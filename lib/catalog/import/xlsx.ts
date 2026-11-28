/**
 * A small .xlsx codec for the product import template: enough of the Office
 * Open XML format to write a workbook Excel, LibreOffice and Google Sheets
 * open, and to read back what any of them saves. No dependency: the zip is
 * written and read by hand, compression is Node's zlib, and the XML parts go
 * through a tiny tokenizer that knows no DTD and expands no entity beyond the
 * five XML ones, so an uploaded file can neither blow up memory nor reach out.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface Sheet {
  name: string;
  rows: string[][];
}

export const XLSX_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxUncompressed: 50 * 1024 * 1024,
  maxRows: 5000,
  maxCols: 100,
  maxCell: 32767,
} as const;

export type SpreadsheetLimits = { [K in keyof typeof XLSX_LIMITS]: number };

export type SpreadsheetErrorKind = "too_large" | "not_xlsx" | "malformed" | "encrypted" | "too_many_rows";

/** Why an uploaded spreadsheet was refused; `kind` is what the screens translate. */
export class SpreadsheetError extends Error {
  readonly kind: SpreadsheetErrorKind;
  constructor(kind: SpreadsheetErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "SpreadsheetError";
    this.kind = kind;
  }
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as zip wants it; zlib.crc32 is missing from Node 20, which production runs. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Characters XML 1.0 cannot hold at all; lone surrogates included thanks to the u flag.
const INVALID_XML_CHARS = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/** Cuts to at most `max` UTF-16 units without splitting a surrogate pair. */
function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// ─── Writing ────────────────────────────────────────────────────────────────

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function escapeXml(text: string): string {
  return text
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML parsers turn a raw CR into LF; a character reference keeps it.
    .replace(/\r/g, "&#13;");
}

/** Cell text as Excel stores it: a literal `_x0041_` would otherwise be read back as "A". */
function escapeCellText(text: string): string {
  return escapeXml(cutUnits(text, XLSX_LIMITS.maxCell).replace(/_(x[0-9A-Fa-f]{4}_)/g, "_x005F_$1"));
}

/** Excel's rules: 1 to 31 characters, none of []:*?/\, no apostrophe at either end, unique ignoring case. */
function sheetNames(sheets: Sheet[]): string[] {
  const taken = new Set<string>();
  return sheets.map((sheet, index) => {
    let base = (sheet.name ?? "")
      .replace(INVALID_XML_CHARS, "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[[\]:*?/\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^'+|'+$/g, "")
      .trim();
    // "History" is reserved by Excel for change tracking.
    if (!base || base.toLowerCase() === "history") base = `Sheet${index + 1}`;
    base = cutUnits(base, 31).trim();
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = cutUnits(base, 31 - suffix.length).trim() + suffix;
    }
    taken.add(name.toLowerCase());
    return name;
  });
}

function worksheetXml(rows: string[][]): string {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths: number[] = new Array(width).fill(0);
  const body: string[] = [];
  rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((value, c) => {
      const text = value == null ? "" : String(value);
      if (text === "" && r > 0) return;
      const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? "";
      widths[c] = Math.max(widths[c], Array.from(firstLine).length);
      const style = r === 0 ? ' s="1"' : ' s="2"';
      cells.push(
        `<c r="${columnName(c)}${r + 1}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeCellText(text)}</t></is></c>`,
      );
    });
    body.push(cells.length ? `<row r="${r + 1}">${cells.join("")}</row>` : "");
  });
  const lastRef = width && rows.length ? `${columnName(width - 1)}${rows.length}` : "A1";
  const frozen =
    rows.length > 1
      ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
      : "";
  const cols = width
    ? `<cols>${widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(10, w + 2))}" style="2" customWidth="1"/>`)
        .join("")}</cols>`
    : "";
  const data = body.join("");
  return (
    XML_HEAD +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<dimension ref="${lastRef === "A1" ? "A1" : `A1:${lastRef}`}"/>` +
    `<sheetViews><sheetView workbookViewId="0">${frozen}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    cols +
    (data ? `<sheetData>${data}</sheetData>` : "<sheetData/>") +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    "</worksheet>"
  );
}

const STYLES_XML =
  XML_HEAD +
  `<styleSheet xmlns="${NS_MAIN}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  // 1: the bold header; 2: plain text. Number format 49 ("@") makes Excel keep
  // what the brand types later as text, so a code like 0550 keeps its zero.
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>' +
  '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

interface ZipFile {
  name: string;
  data: Buffer;
}

// 1980-01-01 00:00: a fixed date keeps the output byte-for-byte reproducible.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

function writeZip(files: ZipFile[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, deflate
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by: MS-DOS, 2.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/**
 * A minimal workbook: one bold header row per sheet, frozen under it, with
 * every value an inline string so nothing is reinterpreted as a number or date.
 */
export function writeXlsx(sheets: Sheet[]): Buffer {
  const list = sheets.length ? sheets : [{ name: "Sheet1", rows: [] }];
  const names = sheetNames(list);
  const files: ZipFile[] = [];
  const text = (name: string, xml: string) => files.push({ name, data: Buffer.from(xml, "utf8") });

  text(
    "[Content_Types].xml",
    XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      list
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("") +
      "</Types>",
  );
  text(
    "_rels/.rels",
    XML_HEAD +
      `<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
      "</Relationships>",
  );
  text(
    "xl/workbook.xml",
    XML_HEAD +
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
      names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      "</sheets></workbook>",
  );
  text(
    "xl/_rels/workbook.xml.rels",
    XML_HEAD +
      `<Relationships xmlns="${NS_PKG_REL}">` +
      list
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("") +
      `<Relationship Id="rId${list.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      "</Relationships>",
  );
  text("xl/styles.xml", STYLES_XML);
  list.forEach((sheet, i) => text(`xl/worksheets/sheet${i + 1}.xml`, worksheetXml(sheet.rows ?? [])));
  return writeZip(files);
}

// ─── Reading the zip ────────────────────────────────────────────────────────

interface ZipEntry {
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const MAX_ENTRIES = 10_000;
const MAX_SHEETS = 100;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** A 64-bit zip64 field, refused when it does not fit a safe integer (it never fits our limits then). */
function u64(bytes: Uint8Array, at: number): number {
  const high = u32(bytes, at + 4);
  if (high > 0x1fffff) throw new SpreadsheetError("too_large", "A zip64 size is out of range.");
  return high * 0x100000000 + u32(bytes, at);
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((b, i) => bytes[i] === b);
}

/** Password-protected .xlsx files are OLE compound files holding an "EncryptionInfo" stream. */
function isEncryptedOle(bytes: Uint8Array): boolean {
  const marker = Buffer.from("EncryptionInfo", "utf16le");
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(marker);
}

class ZipReader {
  private readonly entries = new Map<string, ZipEntry>();
  private budget: number;

  constructor(
    private readonly bytes: Uint8Array,
    limits: SpreadsheetLimits,
  ) {
    this.budget = limits.maxUncompressed;
    this.readDirectory(limits);
  }

  private readDirectory(limits: SpreadsheetLimits): void {
    const bytes = this.bytes;
    // The end record is the last 22 bytes, plus a comment of up to 64 KiB.
    let end = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
      if (u32(bytes, at) === 0x06054b50) {
        end = at;
        break;
      }
    }
    if (end < 0) throw new SpreadsheetError("malformed", "The zip directory is missing.");
    let count = u16(bytes, end + 10);
    let size = u32(bytes, end + 12);
    let offset = u32(bytes, end + 16);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      const locator = end - 20;
      if (locator < 0 || u32(bytes, locator) !== 0x07064b50) throw new SpreadsheetError("malformed", "The zip64 locator is missing.");
      const record = u64(bytes, locator + 8);
      if (record + 56 > bytes.length || u32(bytes, record) !== 0x06064b50) {
        throw new SpreadsheetError("malformed", "The zip64 directory is missing.");
      }
      count = u64(bytes, record + 32);
      size = u64(bytes, record + 40);
      offset = u64(bytes, record + 48);
    }
    if (count > MAX_ENTRIES) throw new SpreadsheetError("too_large", "The archive holds too many files.");
    if (offset + size > bytes.length) throw new SpreadsheetError("malformed", "The zip directory is out of bounds.");

    let declared = 0;
    let at = offset;
    for (let i = 0; i < count; i++) {
      if (at + 46 > offset + size || u32(bytes, at) !== 0x02014b50) {
        throw new SpreadsheetError("malformed", "A zip directory entry is broken.");
      }
      const flags = u16(bytes, at + 8);
      const method = u16(bytes, at + 10);
      let compressedSize = u32(bytes, at + 20);
      let uncompressed = u32(bytes, at + 24);
      const nameLength = u16(bytes, at + 28);
      const extraLength = u16(bytes, at + 30);
      const commentLength = u16(bytes, at + 32);
      let localOffset = u32(bytes, at + 42);
      const next = at + 46 + nameLength + extraLength + commentLength;
      if (next > offset + size) throw new SpreadsheetError("malformed", "A zip directory entry is broken.");
      // Bit 0: traditional encryption; bit 6: strong encryption.
      if (flags & 0x41) throw new SpreadsheetError("encrypted", "The workbook is encrypted.");
      const name = Buffer.from(bytes.subarray(at + 46, at + 46 + nameLength)).toString(flags & 0x0800 ? "utf8" : "latin1");

      // Zip64 extra field: the 64-bit values appear only for fields marked 0xFFFFFFFF, in this order.
      if (uncompressed === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        let extra = at + 46 + nameLength;
        const extraEnd = extra + extraLength;
        let found = false;
        while (extra + 4 <= extraEnd) {
          const id = u16(bytes, extra);
          const length = u16(bytes, extra + 2);
          if (id === 0x0001) {
            let field = extra + 4;
            const fieldEnd = field + length;
            const take = () => {
              if (field + 8 > fieldEnd) throw new SpreadsheetError("malformed", "A zip64 field is broken.");
              const value = u64(bytes, field);
              field += 8;
              return value;
            };
            if (uncompressed === 0xffffffff) uncompressed = take();
            if (compressedSize === 0xffffffff) compressedSize = take();
            if (localOffset === 0xffffffff) localOffset = take();
            found = true;
            break;
          }
          extra += 4 + length;
        }
        if (!found) throw new SpreadsheetError("malformed", "A zip64 field is missing.");
      }

      if (method !== 0 && method !== 8) throw new SpreadsheetError("malformed", "A zip entry uses an unknown compression.");
      if (method === 0 && compressedSize !== uncompressed) throw new SpreadsheetError("malformed", "A stored zip entry is inconsistent.");
      declared += uncompressed;
      // Declared sizes are checked up front; actual sizes again while inflating, in case they lie.
      if (uncompressed > limits.maxUncompressed || declared > limits.maxUncompressed) {
        throw new SpreadsheetError("too_large", "The workbook is too large once uncompressed.");
      }
      if (this.entries.has(name)) throw new SpreadsheetError("malformed", "The archive holds the same file twice.");
      this.entries.set(name, { method, crc: u32(bytes, at + 16), compressedSize, size: uncompressed, localOffset });
      at = next;
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  read(name: string): Buffer | null {
    const entry = this.entries.get(name);
    if (!entry) return null;
    const bytes = this.bytes;
    const local = entry.localOffset;
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) {
      throw new SpreadsheetError("malformed", "A zip entry header is broken.");
    }
    if (u16(bytes, local + 6) & 0x41) throw new SpreadsheetError("encrypted", "The workbook is encrypted.");
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    if (start + entry.compressedSize > bytes.length) throw new SpreadsheetError("malformed", "A zip entry is cut short.");
    const raw = bytes.subarray(start, start + entry.compressedSize);
    if (entry.size > this.budget) throw new SpreadsheetError("too_large", "The workbook is too large once uncompressed.");
    let data: Buffer;
    if (entry.method === 0) {
      data = Buffer.from(raw);
    } else {
      try {
        // One byte more than declared, so a stream that lies about its size is caught, not truncated.
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size + 1) });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ERR_BUFFER_TOO_LARGE") throw new SpreadsheetError("too_large", "A zip entry inflates beyond its declared size.");
        throw new SpreadsheetError("malformed", "A zip entry cannot be decompressed.");
      }
    }
    if (data.length !== entry.size) throw new SpreadsheetError("malformed", "A zip entry does not match its declared size.");
    if (crc32(data) !== entry.crc) throw new SpreadsheetError("malformed", "A zip entry is corrupted.");
    this.budget -= data.length;
    return data;
  }
}

// ─── A small XML tokenizer ──────────────────────────────────────────────────

type Attrs = Record<string, string>;

interface XmlHandlers {
  open(name: string, attrs: Attrs, selfClosing: boolean): void;
  close(name: string): void;
  text(text: string): void;
}

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&([^;&\s]{0,12});/g, (_, ref: string) => {
    if (ref in NAMED_ENTITIES) return NAMED_ENTITIES[ref];
    const code = /^#x[0-9a-fA-F]{1,6}$/.test(ref)
      ? parseInt(ref.slice(2), 16)
      : /^#[0-9]{1,7}$/.test(ref)
        ? parseInt(ref.slice(1), 10)
        : -1;
    if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new SpreadsheetError("malformed", "The workbook uses an unknown XML entity.");
    }
    return String.fromCodePoint(code);
  });
}

/** The element's name without its namespace prefix: some tools write `<x:c>`. */
function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

/** An attribute by local name, whatever its prefix (`r:id`, `ns0:id`). */
function attr(attrs: Attrs, name: string): string | undefined {
  if (name in attrs) return attrs[name];
  for (const key in attrs) if (localName(key) === name && key.includes(":")) return attrs[key];
  return undefined;
}

const ATTR_PATTERN = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(source: string): Attrs {
  const attrs: Attrs = {};
  for (const match of source.matchAll(ATTR_PATTERN)) attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
  // Whatever the pattern did not consume must be blank, or the tag is broken.
  if (source.replace(ATTR_PATTERN, "").trim()) throw new SpreadsheetError("malformed", "An XML tag is broken.");
  return attrs;
}

function scanXml(xml: string, handlers: XmlHandlers): void {
  const stack: string[] = [];
  let sawRoot = false;
  let at = 0;
  const length = xml.length;
  while (at < length) {
    const lt = xml.indexOf("<", at);
    const textEnd = lt < 0 ? length : lt;
    if (textEnd > at) {
      const text = xml.slice(at, textEnd);
      if (stack.length) handlers.text(decodeEntities(text));
      else if (text.trim()) throw new SpreadsheetError("malformed", "Text outside the XML root.");
    }
    if (lt < 0) break;
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new SpreadsheetError("malformed", "An XML declaration is not closed.");
      at = end + 2;
    } else if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw new SpreadsheetError("malformed", "An XML comment is not closed.");
      at = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0 || !stack.length) throw new SpreadsheetError("malformed", "An XML CDATA section is broken.");
      handlers.text(xml.slice(lt + 9, end));
      at = end + 3;
    } else if (xml.startsWith("<!", lt)) {
      // DOCTYPE and anything like it: entity definitions are how XML bombs start.
      throw new SpreadsheetError("malformed", "The workbook XML declares a DTD.");
    } else {
      const end = tagEnd(xml, lt + 1);
      const inner = xml.slice(lt + 1, end);
      at = end + 1;
      if (inner.startsWith("/")) {
        const name = inner.slice(1).trim();
        if (stack.pop() !== name) throw new SpreadsheetError("malformed", "XML tags are not nested properly.");
        handlers.close(localName(name));
        continue;
      }
      const selfClosing = inner.endsWith("/");
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const nameMatch = /^[^\s/>]+/.exec(body);
      if (!nameMatch) throw new SpreadsheetError("malformed", "An XML tag has no name.");
      const name = nameMatch[0];
      if (!stack.length) {
        if (sawRoot) throw new SpreadsheetError("malformed", "The XML has two roots.");
        sawRoot = true;
      }
      const attrs = parseAttrs(body.slice(name.length));
      handlers.open(localName(name), attrs, selfClosing);
      if (selfClosing) handlers.close(localName(name));
      else stack.push(name);
    }
  }
  if (stack.length || !sawRoot) throw new SpreadsheetError("malformed", "The XML is incomplete.");
}

/** The ">" closing a tag, skipping any inside quoted attribute values. */
function tagEnd(xml: string, from: number): number {
  let quote = 0;
  for (let i = from; i < xml.length; i++) {
    const code = xml.charCodeAt(i);
    if (quote) {
      if (code === quote) quote = 0;
    } else if (code === 0x22 || code === 0x27) quote = code;
    else if (code === 0x3e) return i;
  }
  throw new SpreadsheetError("malformed", "An XML tag is not closed.");
}

function decodeXmlBytes(data: Buffer): string {
  try {
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(data.subarray(2));
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(data.subarray(2));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
  } catch {
    throw new SpreadsheetError("malformed", "A workbook part is not valid text.");
  }
}

/** Excel's own escape for characters XML cannot carry: `_x000D_` is a CR. */
function decodeExcelEscapes(text: string): string {
  if (!text.includes("_x")) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// ─── Reading the workbook ───────────────────────────────────────────────────

const REL_OFFICE_DOCUMENT = /\/officeDocument$/;
const REL_WORKSHEET = /\/worksheet$/;
const REL_SHARED_STRINGS = /\/sharedStrings$/;

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash + 1);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A relationship target resolved against its source part's folder, `..` included. */
function resolvePart(base: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : base + target).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

interface Relationship {
  type: string;
  target: string;
  external: boolean;
}

function readRels(zip: ZipReader, path: string): Map<string, Relationship> {
  const rels = new Map<string, Relationship>();
  const data = zip.read(path);
  if (!data) return rels;
  scanXml(decodeXmlBytes(data), {
    open(name, attrs) {
      if (name !== "Relationship") return;
      const id = attrs.Id;
      if (id) {
        rels.set(id, { type: attrs.Type ?? "", target: attrs.Target ?? "", external: attrs.TargetMode === "External" });
      }
    },
    close() {},
    text() {},
  });
  return rels;
}

/** Collects the text of `<t>` elements under the current string item, skipping phonetic runs. */
function stringCollector() {
  let inT = 0;
  let inPhonetic = 0;
  let value = "";
  return {
    open(name: string) {
      if (name === "rPh") inPhonetic++;
      else if (name === "t" && !inPhonetic) inT++;
    },
    close(name: string) {
      if (name === "rPh") inPhonetic--;
      else if (name === "t" && inT) inT--;
    },
    text(text: string) {
      if (inT) value += text;
    },
    take(): string {
      const out = decodeExcelEscapes(value);
      value = "";
      return out;
    },
  };
}

function readSharedStrings(zip: ZipReader, path: string | null, limits: SpreadsheetLimits): string[] {
  const strings: string[] = [];
  if (!path) return strings;
  const data = zip.read(path);
  if (!data) return strings;
  const collector = stringCollector();
  let inItem = false;
  scanXml(decodeXmlBytes(data), {
    open(name) {
      if (name === "si") {
        inItem = true;
        collector.take();
      } else if (inItem) collector.open(name);
    },
    close(name) {
      if (name === "si") {
        inItem = false;
        strings.push(cutUnits(collector.take(), limits.maxCell + 1));
      } else if (inItem) collector.close(name);
    },
    text(text) {
      if (inItem) collector.text(text);
    },
  });
  return strings;
}

/** "AA12" → column 26 (zero-based) and row 11; null when the reference is not a cell. */
function parseRef(ref: string): { col: number; row: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(ref);
  if (!match) return null;
  let col = 0;
  for (const ch of match[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = parseInt(match[2], 10);
  if (row < 1 || col > 16384) return null;
  return { col: col - 1, row: row - 1 };
}

/** A number as Excel shows it: 15 significant digits, so 19.989999999999998 reads 19.99. */
function numberText(raw: string): string {
  const value = raw.trim();
  if (/^-?[0-9]+$/.test(value)) return value;
  const n = Number(value);
  if (!value || !Number.isFinite(n)) return value;
  return String(Number(n.toPrecision(15)));
}

function readWorksheet(xml: string, shared: string[], limits: SpreadsheetLimits): string[][] {
  const rows: string[][] = [];
  const collector = stringCollector();
  let inData = false;
  let rowIndex = -1;
  let colIndex = -1;
  let cellType = "";
  let cellCol = 0;
  let inValue = false;
  let inInline = false;
  let value = "";
  let hasValue = false;

  const place = (text: string) => {
    if (text === "") return;
    if (rowIndex >= limits.maxRows) throw new SpreadsheetError("too_many_rows", `A sheet has more than ${limits.maxRows} rows.`);
    if (cellCol >= limits.maxCols) throw new SpreadsheetError("too_large", `A sheet has more than ${limits.maxCols} columns.`);
    if (text.length > limits.maxCell) throw new SpreadsheetError("too_large", "A cell holds too much text.");
    while (rows.length <= rowIndex) rows.push([]);
    const row = rows[rowIndex];
    while (row.length < cellCol) row.push("");
    row[cellCol] = text;
  };

  scanXml(xml, {
    open(name, attrs) {
      if (name === "sheetData") {
        inData = true;
        return;
      }
      if (!inData) return;
      if (name === "row") {
        const r = attrs.r;
        const next = r === undefined ? rowIndex + 1 : parseInt(r, 10) - 1;
        if (!Number.isInteger(next) || next < 0 || next > 1_048_575 || (r !== undefined && !/^[0-9]+$/.test(r))) {
          throw new SpreadsheetError("malformed", "A row number is invalid.");
        }
        rowIndex = next;
        colIndex = -1;
      } else if (name === "c") {
        if (rowIndex < 0) rowIndex = 0;
        const r = attrs.r;
        if (r !== undefined) {
          const ref = parseRef(r);
          if (!ref) throw new SpreadsheetError("malformed", "A cell reference is invalid.");
          // A cell's own row wins over its <row>: some writers omit row numbers.
          rowIndex = ref.row;
          colIndex = ref.col;
        } else colIndex += 1;
        cellCol = colIndex;
        cellType = attrs.t ?? "n";
        value = "";
        hasValue = false;
        collector.take();
      } else if (name === "v") {
        inValue = true;
        hasValue = true;
      } else if (name === "is") {
        inInline = true;
      } else if (inInline) {
        collector.open(name);
      }
    },
    close(name) {
      if (name === "sheetData") inData = false;
      if (!inData) return;
      if (name === "v") inValue = false;
      else if (name === "is") inInline = false;
      else if (inInline) collector.close(name);
      else if (name === "c") {
        let text = "";
        switch (cellType) {
          case "s": {
            if (!hasValue) break;
            const index = Number(value.trim());
            if (!Number.isInteger(index) || index < 0 || index >= shared.length) {
              throw new SpreadsheetError("malformed", "A cell points to a missing shared string.");
            }
            text = shared[index];
            break;
          }
          case "inlineStr":
            text = collector.take();
            break;
          case "b":
            text = hasValue ? (value.trim() === "1" ? "TRUE" : "FALSE") : "";
            break;
          case "str":
          case "e":
          case "d":
            text = decodeExcelEscapes(value);
            break;
          default:
            text = hasValue ? numberText(value) : "";
        }
        place(text);
      }
    },
    text(text) {
      if (!inData) return;
      if (inValue) value += text;
      else if (inInline) collector.text(text);
    },
  });

  // Trailing empty cells go; the rows that end up empty at the end go too.
  for (const row of rows) {
    while (row.length && row[row.length - 1] === "") row.pop();
  }
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

function cleanSheetName(name: string, index: number): string {
  const clean = cutUnits(name.replace(INVALID_XML_CHARS, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim(), 64);
  return clean || `Sheet${index + 1}`;
}

/**
 * Every sheet of the workbook, in the workbook's order, as rows of text:
 * strings as written, numbers and booleans as shown, formulas as their last
 * computed value. Throws a SpreadsheetError on anything it cannot trust.
 */
// Partial<SpreadsheetLimits>, not Partial<typeof XLSX_LIMITS>: the constant's literal types would only accept the defaults.
export function readXlsx(bytes: Uint8Array, limits?: Partial<SpreadsheetLimits>): Sheet[] {
  const max: SpreadsheetLimits = { ...XLSX_LIMITS, ...limits };
  if (bytes.length > max.maxBytes) throw new SpreadsheetError("too_large", "The file is too large.");
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    if (isEncryptedOle(bytes)) throw new SpreadsheetError("encrypted", "The workbook is protected by a password.");
    throw new SpreadsheetError("not_xlsx", "This is an old .xls file; save it as .xlsx.");
  }
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || bytes.length < 22) {
    throw new SpreadsheetError("not_xlsx", "The file is not an .xlsx workbook.");
  }

  const zip = new ZipReader(bytes, max);
  let workbookPath = "xl/workbook.xml";
  for (const rel of readRels(zip, "_rels/.rels").values()) {
    if (REL_OFFICE_DOCUMENT.test(rel.type) && !rel.external) {
      workbookPath = resolvePart("", rel.target);
      break;
    }
  }
  if (!zip.has(workbookPath)) throw new SpreadsheetError("not_xlsx", "The archive holds no workbook.");

  const base = dirname(workbookPath);
  const rels = readRels(zip, `${base}_rels/${basename(workbookPath)}.rels`);
  let sharedPath: string | null = null;
  for (const rel of rels.values()) {
    if (REL_SHARED_STRINGS.test(rel.type) && !rel.external) sharedPath = resolvePart(base, rel.target);
  }
  if (!sharedPath && zip.has(`${base}sharedStrings.xml`)) sharedPath = `${base}sharedStrings.xml`;

  const entries: { name: string; path: string }[] = [];
  scanXml(decodeXmlBytes(zip.read(workbookPath)!), {
    open(name, attrs) {
      if (name !== "sheet") return;
      if (entries.length >= MAX_SHEETS) throw new SpreadsheetError("too_large", "The workbook has too many sheets.");
      const rel = rels.get(attr(attrs, "id") ?? "");
      // Chart sheets and dialog sheets carry no cells; they are skipped.
      if (!rel || rel.external || !REL_WORKSHEET.test(rel.type)) return;
      entries.push({ name: cleanSheetName(attrs.name ?? "", entries.length), path: resolvePart(base, rel.target) });
    },
    close() {},
    text() {},
  });
  if (!entries.length) throw new SpreadsheetError("malformed", "The workbook has no sheet.");

  const shared = readSharedStrings(zip, sharedPath, max);
  return entries.map(({ name, path }) => {
    const data = zip.read(path);
    if (!data) throw new SpreadsheetError("malformed", "A sheet of the workbook is missing.");
    return { name, rows: readWorksheet(decodeXmlBytes(data), shared, max) };
  });
}
