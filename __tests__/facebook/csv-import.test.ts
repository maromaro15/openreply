/**
 * CSV for the product import: what Excel needs to open our template, and
 * what Excel, LibreOffice and Google Sheets give back (delimiters, encodings,
 * quoting), plus the formula-injection guard.
 */
import { describe, expect, it } from "vitest";
import { readCsv, writeCsv } from "../../lib/catalog/import/csv";
import { SpreadsheetError } from "../../lib/catalog/import/xlsx";

const BOM = "\uFEFF";

function text(bytes: Buffer): string {
  return bytes.toString("utf8");
}

function kindOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SpreadsheetError);
    return (error as SpreadsheetError).kind;
  }
  return "accepted";
}

describe("writeCsv", () => {
  it("starts with a UTF-8 BOM, ends lines with CRLF and quotes only what needs it", () => {
    const out = writeCsv([
      ["code", "nom", "note"],
      ["0550", "Robe, rouge", 'dit "oui"'],
      ["7", "ligne 1\nligne 2", "a;b"],
    ]);
    expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text(out)).toBe(`${BOM}code,nom,note\r\n0550,"Robe, rouge","dit ""oui"""\r\n7,"ligne 1\nligne 2",a;b\r\n`);
  });

  it("quotes the semicolon instead of the comma with the semicolon delimiter", () => {
    expect(text(writeCsv([["1,5", "a;b"]], { delimiter: ";" }))).toBe(`${BOM}1,5;"a;b"\r\n`);
  });

  it("puts an apostrophe before anything a spreadsheet would run as a formula", () => {
    const out = text(writeCsv([["=HYPERLINK(\"http://x\")", "+213 550", "-5", "@SUM(A1)", "\tx", "\rx", "a=b", "'deja"]]));
    expect(out).toBe(`${BOM}"'=HYPERLINK(""http://x"")",'+213 550,'-5,'@SUM(A1),'\tx,"'\rx",a=b,'deja\r\n`);
  });

  it("writes only the BOM for no rows", () => {
    expect(text(writeCsv([]))).toBe(BOM);
  });
});

describe("writeCsv then readCsv", () => {
  const rows = [
    ["code", "nom", "prix", "note"],
    ["0550", "فستان أحمر 👗", "2500", 'il a dit "oui", puis; non'],
    ["007", "Crème brûlée à l'été", "1,5", "ligne 1\nligne 2\r\nligne 3"],
    ["", "", "=SUM(A1:A2)", "+213 550 12 34 56"],
    ["-5", "@me", "  espaces  ", "x".repeat(20_000)],
  ];

  it.each([",", ";"] as const)("brings everything back unchanged with %j", (delimiter) => {
    expect(readCsv(writeCsv(rows, { delimiter }))).toEqual(rows);
  });
});

describe("readCsv", () => {
  it("removes the BOM and reads plain UTF-8", () => {
    expect(readCsv(Buffer.from(`${BOM}code,nom\r\nWP-12,Robe\r\n`))).toEqual([["code", "nom"], ["WP-12", "Robe"]]);
    expect(readCsv(Buffer.from("code,nom\nWP-12,حذاء\n"))).toEqual([["code", "nom"], ["WP-12", "حذاء"]]);
  });

  it("falls back to Windows-1252 when the bytes are not UTF-8", () => {
    // "café;crème;€;œuvre" as an old French Excel saves it.
    const bytes = Buffer.concat([
      Buffer.from("nom;prix\r\ncaf"),
      Buffer.from([0xe9]),
      Buffer.from(";cr"),
      Buffer.from([0xe8]),
      Buffer.from("me "),
      Buffer.from([0x80, 0x3b, 0x9c]),
      Buffer.from("uvre\r\n"),
    ]);
    expect(readCsv(bytes)).toEqual([["nom", "prix"], ["café", "crème €", "œuvre"]]);
  });

  it("reads Excel's UTF-16 'Unicode text' export, tab separated", () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("code\tnom\r\n0550\tفستان\r\n", "utf16le")]);
    expect(readCsv(bytes)).toEqual([["code", "nom"], ["0550", "فستان"]]);
  });

  it("detects the delimiter from the first lines, outside quotes", () => {
    expect(readCsv(Buffer.from("code;nom;prix\nA;Robe;1,5\nB;Sac;2,75\n"))).toEqual([
      ["code", "nom", "prix"],
      ["A", "Robe", "1,5"],
      ["B", "Sac", "2,75"],
    ]);
    expect(readCsv(Buffer.from('code,nom\nA,"Robe; rouge; longue"\nB,"Sac; noir"\n'))).toEqual([
      ["code", "nom"],
      ["A", "Robe; rouge; longue"],
      ["B", "Sac; noir"],
    ]);
    expect(readCsv(Buffer.from("code\tnom, détail\nA\tRobe, rouge\n"))).toEqual([["code", "nom, détail"], ["A", "Robe, rouge"]]);
    expect(readCsv(Buffer.from("code\nA\nB\n"))).toEqual([["code"], ["A"], ["B"]]);
  });

  it("reads quoted fields with doubled quotes, delimiters and line breaks", () => {
    const csv = 'a,"b ""c"" d","e,f","g\r\nh\ni"\r\n"",x,"y"\r\n';
    expect(readCsv(Buffer.from(csv))).toEqual([
      ["a", 'b "c" d', "e,f", "g\r\nh\ni"],
      ["", "x", "y"],
    ]);
  });

  it("keeps stray quotes and text after a closing quote, as Excel does", () => {
    expect(readCsv(Buffer.from('a,5" pouces,"x"y\n'))).toEqual([["a", '5" pouces', "xy"]]);
  });

  it("accepts CRLF, LF and CR line ends, even mixed", () => {
    expect(readCsv(Buffer.from("a,b\r\nc,d\ne,f\rg,h"))).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
  });

  it("drops blank trailing lines and trailing empty cells, keeps blank lines in the middle", () => {
    expect(readCsv(Buffer.from("a,b,,\r\n\r\nc,,\r\n,,\r\n\r\n\n"))).toEqual([["a", "b"], [], ["c"]]);
    expect(readCsv(Buffer.from(""))).toEqual([]);
    expect(readCsv(Buffer.from(`${BOM}\r\n\r\n`))).toEqual([]);
  });

  it("removes the formula guard only before the characters it guards", () => {
    expect(readCsv(Buffer.from("'=1+1,'+213,'hello,'\n"))).toEqual([["=1+1", "+213", "'hello", "'"]]);
  });

  it("refuses files past the byte, row and column limits", () => {
    const file = Buffer.from("a\nb\nc\n\n\n\n");
    expect(readCsv(file, { maxRows: 3 })).toEqual([["a"], ["b"], ["c"]]);
    expect(kindOf(() => readCsv(file, { maxRows: 2 }))).toBe("too_many_rows");
    expect(kindOf(() => readCsv(Buffer.from("a,b,c\n"), { maxCols: 2 }))).toBe("too_large");
    expect(readCsv(Buffer.from("a,b,,,\n"), { maxCols: 2 })).toEqual([["a", "b"]]);
    expect(kindOf(() => readCsv(file, { maxBytes: 5 }))).toBe("too_large");
    expect(kindOf(() => readCsv(Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)))).toBe("too_large");
    expect(kindOf(() => readCsv(Buffer.from(`a,${"x".repeat(40_000)}\n`)))).toBe("too_large");
    expect(kindOf(() => readCsv(Buffer.from("\n".repeat(20_000) + "a\n")))).toBe("too_many_rows");
  });

  it("refuses a quoted field that never closes", () => {
    expect(kindOf(() => readCsv(Buffer.from('a,"b\nc,d\n')))).toBe("malformed");
  });
});
