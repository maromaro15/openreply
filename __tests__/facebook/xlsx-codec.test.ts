/**
 * The in-project .xlsx codec: round trips, sheet names, a workbook laid out
 * the way Excel and LibreOffice save one, and archives built to hurt (zip
 * bombs, encryption, broken zips, DTDs). The last tests run openpyxl and
 * LibreOffice for real, only where they are installed.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { SpreadsheetError, XLSX_LIMITS, crc32, readXlsx, writeXlsx, type Sheet } from "../../lib/catalog/import/xlsx";

// ─── A zip builder of our own, so tests can bend every field ────────────────

interface Part {
  name: string;
  data: string | Buffer;
  method?: 0 | 8 | 12;
  flags?: number;
  /** What the headers claim, when a test wants them to lie. */
  size?: number;
  crc?: number;
  /** Bytes stored as the compressed body, as they are. */
  raw?: Buffer;
}

function zip(parts: Part[], options: { zip64?: boolean; zip64Count?: number; duplicate?: boolean } = {}): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const data = typeof part.data === "string" ? Buffer.from(part.data, "utf8") : part.data;
    const method = part.method ?? 8;
    const body = part.raw ?? (method === 0 ? data : deflateRawSync(data));
    const name = Buffer.from(part.name, "utf8");
    const crc = part.crc ?? crc32(data);
    const size = part.size ?? data.length;
    const flags = part.flags ?? 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const count = parts.length;
  const tail: Buffer[] = [];
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  if (options.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(BigInt(44), 4);
    record.writeBigUInt64LE(BigInt(options.zip64Count ?? count), 24);
    record.writeBigUInt64LE(BigInt(options.zip64Count ?? count), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
    end.writeUInt16LE(0xffff, 8);
    end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(0xffffffff, 12);
    end.writeUInt32LE(0xffffffff, 16);
  } else {
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
  }
  return Buffer.concat([...chunks, directory, ...tail, end]);
}

/** The parts of an archive our writer made: local headers in a row, no data descriptors. */
function unzip(bytes: Buffer): Map<string, string> {
  const parts = new Map<string, string>();
  let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const size = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26);
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    const start = at + 30 + nameLength + bytes.readUInt16LE(at + 28);
    parts.set(name, inflateRawSync(bytes.subarray(start, start + size)).toString("utf8"));
    at = start + size;
  }
  return parts;
}

// ─── A workbook laid out the way Excel saves one ────────────────────────────

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

const CONTENT_TYPES = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`;
const ROOT_RELS = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

function workbookParts(sheets: { name: string; xml: string | Buffer }[], shared?: string): Part[] {
  // Sheets numbered backwards and an absolute target, as files reordered in Excel end up.
  const n = sheets.length;
  const rels =
    `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="${i === 0 ? "/xl/" : ""}worksheets/sheet${n - i}.xml"/>`)
      .join("") +
    `<Relationship Id="rId${n + 1}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
    `<Relationship Id="rId${n + 2}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;
  const workbook =
    `${HEAD}<workbook ${NS}><fileVersion appName="xl"/><bookViews><workbookView/></bookViews><sheets>` +
    sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 7}" r:id="rId${i + 1}"/>`).join("") +
    `</sheets><calcPr calcId="191029"/></workbook>`;
  return [
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "docProps/app.xml", data: `${HEAD}<Properties/>` },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: rels },
    { name: "xl/styles.xml", data: `${HEAD}<styleSheet ${NS}/>`, method: 0 },
    ...(shared === undefined ? [] : [{ name: "xl/sharedStrings.xml", data: shared }]),
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${n - i}.xml`, data: s.xml })),
  ];
}

function sheetXml(data: string): string {
  return `${HEAD}<worksheet ${NS}><dimension ref="A1:C9"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>${data}</sheetData><pageMargins left="0.7"/></worksheet>`;
}

const SHARED = `${HEAD}<sst ${NS} count="6" uniqueCount="5">
  <si><t>code</t></si>
  <si><t xml:space="preserve">  nom  </t></si>
  <si><r><rPr><b/><sz val="11"/><rFont val="Calibri"/></rPr><t>Robe </t></r><r><rPr><i/></rPr><t xml:space="preserve">rouge</t></r><rPh sb="0" eb="1"><t>ろ</t></rPh><phoneticPr fontId="1"/></si>
  <si><t>فستان &amp; حذاء</t></si>
  <si><t>ligne 1_x000D_
ligne 2 &#x41;&#66;</t></si>
</sst>`;

const FIXTURE_SHEET = sheetXml(
  [
    '<row r="1" spans="1:3"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s" s="1"><v>1</v></c></row>',
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>19.989999999999998</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="b"><v>0</v></c></row>',
    '<row r="3"><c r="A3"><f>B2*2</f><v>39.979999999999997</v></c><c r="B3" t="str"><f>A1&amp;"-x"</f><v>code-x</v></c><c r="C3" t="e"><f>VLOOKUP(1,A1:A2,2,0)</f><v>#N/A</v></c><c r="D3"><f>NOW()</f></c></row>',
    // Row 4 has only a styled empty cell; row 5 is missing entirely.
    '<row r="4" ht="20" customHeight="1"><c r="E4" s="3"/></row>',
    '<row r="6"><c r="AA6" t="inlineStr"><is><t>loin</t></is></c><c r="B6" t="s"><v>3</v></c></row>',
    // No r attributes at all: a row after the last, cells one after another.
    "<row><c t=\"s\"><v>4</v></c><c t=\"inlineStr\"><is><r><t>a</t></r><r><t>b</t></r></is></c><c><v>0550</v></c><c><v>1.5E-3</v></c></row>",
    '<row r="9"><c r="A9" t="s"/><c r="B9"><v></v></c></row>',
  ].join("\n"),
);

describe("readXlsx on a workbook saved by a spreadsheet program", () => {
  const prefixed =
    `${HEAD}<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><!-- written by the OpenXML SDK -->` +
    `<x:sheetData><x:row r="1"><x:c r="B1" t="inlineStr"><x:is><x:t><![CDATA[<b> & </b>]]></x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`;
  const file = zip(
    workbookParts(
      [
        { name: "Produits &amp; prix", xml: FIXTURE_SHEET },
        { name: "SDK", xml: prefixed },
      ],
      SHARED,
    ),
  );

  it("reads shared strings, rich text, numbers, booleans, formulas and gaps into the right cells", () => {
    const [products] = readXlsx(file);
    expect(products.name).toBe("Produits & prix");
    expect(products.rows).toEqual([
      ["code", "", "  nom  "],
      ["Robe rouge", "19.99", "TRUE", "FALSE"],
      ["39.98", "code-x", "#N/A"],
      [],
      [],
      ["", "فستان & حذاء", ...new Array(24).fill(""), "loin"],
      ["ligne 1\r\nligne 2 AB", "ab", "0550", "0.0015"],
    ]);
  });

  it("keeps the workbook's sheet order, follows absolute targets and namespace prefixes", () => {
    const sheets = readXlsx(file);
    expect(sheets.map((s) => s.name)).toEqual(["Produits & prix", "SDK"]);
    expect(sheets[1].rows).toEqual([["", "<b> & </b>"]]);
  });

  it("reads a workbook with no shared strings part and skips chart sheets", () => {
    const parts = workbookParts([{ name: "Only", xml: sheetXml('<row r="1"><c r="A1"><v>7</v></c></row>') }]);
    const rels = parts.find((p) => p.name === "xl/_rels/workbook.xml.rels")!;
    rels.data = String(rels.data).replace(
      "</Relationships>",
      `<Relationship Id="rId9" Type="${REL}/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`,
    );
    const book = parts.find((p) => p.name === "xl/workbook.xml")!;
    book.data = String(book.data).replace("</sheets>", '<sheet name="Chart" sheetId="9" r:id="rId9"/></sheets>');
    expect(readXlsx(zip(parts))).toEqual([{ name: "Only", rows: [["7"]] }]);
  });

  it("reads a zip64 archive whose sizes are within the limits", () => {
    expect(readXlsx(zip(workbookParts([{ name: "A", xml: FIXTURE_SHEET }], SHARED), { zip64: true }))[0].rows[0]).toEqual([
      "code",
      "",
      "  nom  ",
    ]);
  });
});

// ─── Round trips ────────────────────────────────────────────────────────────

describe("writeXlsx then readXlsx", () => {
  it("brings back Arabic, accents, emoji, quotes, line breaks, leading zeros and long cells unchanged", () => {
    const long = "ب".repeat(XLSX_LIMITS.maxCell);
    const rows = [
      ["code", "nom", "prix", "note"],
      ["0550", "فستان أحمر 👗", "2500", 'il a dit "oui" & <non>'],
      ["007", "Crème brûlée à l'été", "", "ligne 1\nligne 2\r\nligne 3\rfin"],
      ["", "", "=SUM(A1:A2)", "+213 550 12 34 56"],
      ["_x0041_", "  espaces  ", "\t", long],
    ];
    const [sheet] = readXlsx(writeXlsx([{ name: "Produits", rows }]));
    expect(sheet.rows).toEqual(rows);
  });

  it("drops characters XML cannot hold and cuts cells at Excel's limit without splitting an emoji", () => {
    const rows = [["a\u0000b\u0001c\uFFFE", "x\uD800y", "z".repeat(XLSX_LIMITS.maxCell - 1) + "👗"]];
    const [sheet] = readXlsx(writeXlsx([{ name: "S", rows }]));
    expect(sheet.rows[0][0]).toBe("abc");
    expect(sheet.rows[0][1]).toBe("xy");
    expect(sheet.rows[0][2]).toBe("z".repeat(XLSX_LIMITS.maxCell - 1));
  });

  it("trims trailing empty cells and rows, keeps gaps in the middle", () => {
    const rows = [["a", "", "c", "", ""], [], ["", "b"], ["", ""], []];
    expect(readXlsx(writeXlsx([{ name: "S", rows }]))[0].rows).toEqual([["a", "", "c"], [], ["", "b"]]);
  });

  it("writes several sheets in order and makes their names valid and unique", () => {
    const sheets: Sheet[] = [
      { name: "Produits", rows: [["code"], ["A1"]] },
      { name: "produits", rows: [["x"]] },
      { name: "Couleurs/[tailles]: *?\\", rows: [] },
      { name: "", rows: [] },
      { name: "'cité'", rows: [] },
      { name: "History", rows: [] },
      { name: "ا".repeat(40), rows: [] },
      { name: "x".repeat(30) + "👗", rows: [] },
      { name: "Sheet4", rows: [] },
    ];
    const names = readXlsx(writeXlsx(sheets)).map((s) => s.name);
    expect(names).toEqual([
      "Produits",
      "produits (2)",
      "Couleurs tailles",
      "Sheet4",
      "cité",
      "Sheet6",
      "ا".repeat(31),
      "x".repeat(30),
      "Sheet4 (2)",
    ]);
    expect(names.every((n) => n.length <= 31)).toBe(true);
  });

  it("writes one empty sheet for an empty workbook", () => {
    expect(readXlsx(writeXlsx([]))).toEqual([{ name: "Sheet1", rows: [] }]);
  });

  it("is reproducible byte for byte", () => {
    const sheets = [{ name: "S", rows: [["a", "b"], ["1", "2"]] }];
    expect(writeXlsx(sheets).equals(writeXlsx(sheets))).toBe(true);
  });

  it("lays out the parts Excel expects: bold frozen header, inline strings, text columns", () => {
    const parts = unzip(writeXlsx([{ name: "Produits", rows: [["code", "nom"], ["0550", "<robe>"]] }]));
    expect([...parts.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    const sheet = parts.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">code</t></is></c>');
    expect(sheet).toContain('<c r="B2" s="2" t="inlineStr"><is><t xml:space="preserve">&lt;robe&gt;</t></is></c>');
    expect(sheet).toMatch(/<cols><col min="1" max="1" width="10" style="2" customWidth="1"\/>/);
    expect(sheet.indexOf("<sheetViews>")).toBeLessThan(sheet.indexOf("<cols>"));
    expect(sheet.indexOf("<cols>")).toBeLessThan(sheet.indexOf("<sheetData>"));
    expect(parts.get("xl/styles.xml")).toContain("<font><b/>");
    expect(parts.get("xl/workbook.xml")).toContain('<sheet name="Produits" sheetId="1" r:id="rId1"/>');
    expect(parts.get("[Content_Types].xml")).toContain('PartName="/xl/worksheets/sheet1.xml"');
  });

  it("computes the CRC-32 zip expects", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

// ─── Refused files ──────────────────────────────────────────────────────────

function kindOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SpreadsheetError);
    return (error as SpreadsheetError).kind;
  }
  return "accepted";
}

function withSheet(xml: string | Buffer, shared?: string): Buffer {
  return zip(workbookParts([{ name: "S", xml }], shared));
}

describe("readXlsx refuses", () => {
  it("files that are not workbooks", () => {
    expect(kindOf(() => readXlsx(Buffer.from("code,nom\n1,robe\n")))).toBe("not_xlsx");
    expect(kindOf(() => readXlsx(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])))).toBe("not_xlsx");
    expect(kindOf(() => readXlsx(new Uint8Array(0)))).toBe("not_xlsx");
    // A Word document is a zip too.
    expect(kindOf(() => readXlsx(zip([{ name: "word/document.xml", data: "<w:document/>" }])))).toBe("not_xlsx");
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
    expect(kindOf(() => readXlsx(ole))).toBe("not_xlsx");
  });

  it("password-protected workbooks and encrypted zip entries", () => {
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(200),
      Buffer.from("EncryptionInfo", "utf16le"),
      Buffer.alloc(200),
    ]);
    expect(kindOf(() => readXlsx(ole))).toBe("encrypted");
    const parts = workbookParts([{ name: "S", xml: FIXTURE_SHEET }], SHARED);
    parts[parts.length - 1].flags = 0x0801;
    expect(kindOf(() => readXlsx(zip(parts)))).toBe("encrypted");
  });

  it("files over the byte limit", () => {
    const file = writeXlsx([{ name: "S", rows: [["a"]] }]);
    expect(kindOf(() => readXlsx(file, { maxBytes: file.length - 1 }))).toBe("too_large");
    expect(kindOf(() => readXlsx(Buffer.alloc(XLSX_LIMITS.maxBytes + 1)))).toBe("too_large");
  });

  it("zip bombs, whether the sizes are declared honestly or not", () => {
    const zeros = Buffer.alloc(60 * 1024 * 1024, 0x20);
    const sheet = `${sheetXml('<row r="1"><c r="A1"><v>1</v></c></row>')}`;
    // Honest: 60 MiB declared, over the 50 MiB limit.
    const honest = workbookParts([{ name: "S", xml: sheet }]);
    honest.push({ name: "xl/media/padding.bin", data: zeros });
    expect(kindOf(() => readXlsx(zip(honest)))).toBe("too_large");
    // Lying: the sheet claims 1 KiB but inflates to 60 MiB.
    const lying = workbookParts([{ name: "S", xml: Buffer.concat([Buffer.from(sheet.slice(0, -12)), zeros, Buffer.from("</worksheet>")]) }]);
    lying[lying.length - 1].size = 1024;
    expect(kindOf(() => readXlsx(zip(lying)))).toBe("too_large");
    // Many parts, each small, adding up past the limit.
    const many = workbookParts([{ name: "S", xml: sheet }]);
    for (let i = 0; i < 6; i++) many.push({ name: `xl/media/p${i}.bin`, data: Buffer.alloc(9 * 1024 * 1024) });
    expect(kindOf(() => readXlsx(zip(many)))).toBe("too_large");
  });

  it("zip64 directories that claim absurd sizes", () => {
    const parts = workbookParts([{ name: "S", xml: FIXTURE_SHEET }], SHARED);
    expect(kindOf(() => readXlsx(zip(parts, { zip64: true, zip64Count: 2 ** 40 })))).toBe("too_large");
    expect(kindOf(() => readXlsx(zip(parts, { zip64: true, zip64Count: 50_000 })))).toBe("too_large");
  });

  it("broken archives", () => {
    const good = withSheet(FIXTURE_SHEET, SHARED);
    expect(kindOf(() => readXlsx(good.subarray(0, good.length - 30)))).toBe("malformed");
    expect(kindOf(() => readXlsx(good.subarray(0, 200)))).toBe("malformed");
    const corrupted = workbookParts([{ name: "S", xml: FIXTURE_SHEET }], SHARED);
    corrupted[corrupted.length - 1].crc = 1234;
    expect(kindOf(() => readXlsx(zip(corrupted)))).toBe("malformed");
    const bzip = workbookParts([{ name: "S", xml: FIXTURE_SHEET }], SHARED);
    bzip[bzip.length - 1].method = 12;
    expect(kindOf(() => readXlsx(zip(bzip)))).toBe("malformed");
    const twice = workbookParts([{ name: "S", xml: FIXTURE_SHEET }], SHARED);
    twice.push({ ...twice[twice.length - 1] });
    expect(kindOf(() => readXlsx(zip(twice)))).toBe("malformed");
    // Deflate data that is not deflate.
    const garbage = workbookParts([{ name: "S", xml: FIXTURE_SHEET }], SHARED);
    garbage[garbage.length - 1].raw = Buffer.alloc(40, 0xff);
    expect(kindOf(() => readXlsx(zip(garbage)))).toBe("malformed");
    // A part that claims more than it holds.
    const short = workbookParts([{ name: "S", xml: FIXTURE_SHEET }], SHARED);
    short[short.length - 1].size = FIXTURE_SHEET.length + 10;
    expect(kindOf(() => readXlsx(zip(short)))).toBe("malformed");
  });

  it("XML with a DTD, unknown entities, bad nesting or bad text", () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><worksheet ${NS}><sheetData><row><c t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>`;
    expect(kindOf(() => readXlsx(withSheet(laughs)))).toBe("malformed");
    expect(kindOf(() => readXlsx(withSheet(sheetXml('<row><c t="inlineStr"><is><t>&nbsp;</t></is></c></row>'))))).toBe("malformed");
    expect(kindOf(() => readXlsx(withSheet(sheetXml("<row><c><v>1</v></row></c>"))))).toBe("malformed");
    expect(kindOf(() => readXlsx(withSheet(sheetXml("<row><c><v>1</v></c>"))))).toBe("malformed");
    expect(kindOf(() => readXlsx(withSheet(sheetXml('<row><c r="1A"><v>1</v></c></row>'))))).toBe("malformed");
    expect(kindOf(() => readXlsx(withSheet(sheetXml('<row><c t="s"><v>9</v></c></row>'), SHARED)))).toBe("malformed");
    const latin1 = Buffer.from(sheetXml('<row><c t="inlineStr"><is><t>café</t></is></c></row>'), "latin1");
    expect(kindOf(() => readXlsx(withSheet(latin1)))).toBe("malformed");
    expect(kindOf(() => readXlsx(withSheet(sheetXml('<row><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>') + "<extra/>")))).toBe("malformed");
  });

  it("a workbook part pointing nowhere", () => {
    const parts = workbookParts([{ name: "S", xml: FIXTURE_SHEET }], SHARED);
    parts.pop();
    expect(kindOf(() => readXlsx(zip(parts)))).toBe("malformed");
  });

  it("sheets past the row, column and cell limits", () => {
    const rows = Array.from({ length: 6 }, (_, i) => [`r${i}`]);
    const file = writeXlsx([{ name: "S", rows }]);
    expect(readXlsx(file, { maxRows: 6 })[0].rows).toHaveLength(6);
    expect(kindOf(() => readXlsx(file, { maxRows: 5 }))).toBe("too_many_rows");
    // One value on Excel's last row is enough; empty styled rows there are not.
    expect(kindOf(() => readXlsx(withSheet(sheetXml('<row r="1048576"><c r="A1048576"><v>1</v></c></row>'))))).toBe("too_many_rows");
    expect(readXlsx(withSheet(sheetXml('<row r="1"><c r="A1"><v>1</v></c></row><row r="1048576" ht="3"><c r="A1048576" s="2"/></row>')))[0].rows).toEqual([["1"]]);
    expect(kindOf(() => readXlsx(withSheet(sheetXml('<row><c r="CW1"><v>1</v></c></row>'))))).toBe("too_large");
    expect(readXlsx(withSheet(sheetXml('<row><c r="CV1"><v>1</v></c></row>')))[0].rows[0]).toHaveLength(100);
    expect(kindOf(() => readXlsx(writeXlsx([{ name: "S", rows: [["abcdef"]] }]), { maxCell: 5 }))).toBe("too_large");
  });

  it("with a typed error that names its kind", () => {
    const error = new SpreadsheetError("malformed", "broken");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SpreadsheetError");
    expect(error.kind).toBe("malformed");
    expect(error.message).toBe("broken");
  });
});

// ─── Real spreadsheet programs, where installed ─────────────────────────────

const python = process.env.PYTHON ?? "python3";
const openpyxlAvailable = spawnSync(python, ["-c", "import openpyxl"], { stdio: "ignore" }).status === 0;
const sofficeAvailable = spawnSync("soffice", ["--version"], { stdio: "ignore", timeout: 20_000 }).status === 0;
const scratch = mkdtempSync(join(tmpdir(), "xlsx-codec-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SAMPLE: Sheet[] = [
  { name: "Produits", rows: [["code", "nom", "prix"], ["0550", "فستان أحمر 👗", "2500"], ["WP-12", 'Crème "brûlée"\nà deux lignes', "1990"]] },
  { name: "Couleurs", rows: [["code", "couleur"], ["0550", "rouge"]] },
];

describe.skipIf(!openpyxlAvailable)("openpyxl", () => {
  it("opens what we write: values, sheet names, bold frozen header", () => {
    const path = join(scratch, "ours.xlsx");
    writeFileSync(path, writeXlsx(SAMPLE));
    const script = `
import json, sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
print(json.dumps([{"name": ws.title, "frozen": ws.freeze_panes, "bold": ws["A1"].font.b,
  "rows": [[c.value for c in r] for r in ws.iter_rows()]} for ws in wb]))`;
    const run = spawnSync(python, ["-c", script, path], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const books = JSON.parse(run.stdout) as { name: string; frozen: string; bold: boolean; rows: string[][] }[];
    expect(books.map((b) => b.name)).toEqual(["Produits", "Couleurs"]);
    expect(books[0].rows).toEqual(SAMPLE[0].rows);
    expect(books[0].frozen).toBe("A2");
    expect(books[0].bold).toBe(true);
  });

  it("writes a workbook we read: shared strings, numbers, booleans, gaps", () => {
    const path = join(scratch, "theirs.xlsx");
    const script = `
import sys, openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Données"
ws.append(["code", "prix", "ok"]); ws.append(["0550", 19.99, True]); ws["D4"] = "loin"; ws["B5"] = 1234567890123
wb.create_sheet("Second")["B2"] = "x"
wb.save(sys.argv[1])`;
    const run = spawnSync(python, ["-c", script, path], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(readXlsx(readFileSync(path))).toEqual([
      { name: "Données", rows: [["code", "prix", "ok"], ["0550", "19.99", "TRUE"], [], ["", "", "", "loin"], ["", "1234567890123"]] },
      { name: "Second", rows: [[], ["", "x"]] },
    ]);
  });
});

describe.skipIf(!sofficeAvailable)("LibreOffice", () => {
  it(
    "opens what we write and saves a workbook we read back the same",
    () => {
      const input = join(scratch, "lo-in.xlsx");
      const out = join(scratch, "lo-out");
      writeFileSync(input, writeXlsx(SAMPLE));
      // Through .ods and back, so LibreOffice really parses our file and writes its own.
      const profile = `-env:UserInstallation=file://${join(scratch, "lo-profile")}`;
      const ods = spawnSync("soffice", [profile, "--headless", "--convert-to", "ods", "--outdir", scratch, input], { timeout: 90_000 });
      expect(ods.status).toBe(0);
      const back = spawnSync("soffice", [profile, "--headless", "--convert-to", "xlsx", "--outdir", out, join(scratch, "lo-in.ods")], {
        timeout: 90_000,
      });
      expect(back.status).toBe(0);
      expect(readdirSync(out)).toEqual(["lo-in.xlsx"]);
      expect(readXlsx(readFileSync(join(out, "lo-in.xlsx")))).toEqual(SAMPLE);
    },
    200_000,
  );
});
