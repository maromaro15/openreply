/**
 * CSV for the product import: written in UTF-8 with a BOM so Excel opens
 * Arabic and accents correctly, read back whatever Excel, LibreOffice or
 * Google Sheets saved (comma, semicolon or tab; UTF-8, UTF-16 or Windows-1252).
 */
import { SpreadsheetError, XLSX_LIMITS } from "./xlsx";

export interface CsvLimits {
  maxRows?: number;
  maxCols?: number;
  maxBytes?: number;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// Excel and Sheets run a cell starting with one of these as a formula (CSV injection).
const FORMULA_START = /^[=+\-@\t\r]/;

function quoteCell(value: string, delimiter: string): string {
  let text = value == null ? "" : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 with CRLF, and a leading apostrophe on anything a spreadsheet would run as a formula. */
export function writeCsv(rows: string[][], options?: { delimiter?: "," | ";" }): Buffer {
  const delimiter = options?.delimiter ?? ",";
  const body = rows.map((row) => row.map((cell) => quoteCell(cell, delimiter)).join(delimiter)).join("\r\n");
  return Buffer.concat([BOM, Buffer.from(rows.length ? `${body}\r\n` : "", "utf8")]);
}

// Windows-1252 differs from Latin-1 only in 0x80–0x9F; 0 marks the five undefined bytes.
const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

function decodeCp1252(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    const chunk = bytes.subarray(i, i + 4096);
    const codes = Array.from(chunk, (b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] || b : b));
    out += String.fromCharCode(...codes);
  }
  return out;
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  // Excel's "Unicode text" export is UTF-16 little-endian with a BOM.
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // Not UTF-8: an older Excel on Windows saving "CSV" in the ANSI code page.
    return decodeCp1252(bytes);
  }
}

// On a tie the rarer character in ordinary text wins: a tab or a semicolon on
// every line is a delimiter far more often than a comma is.
const CANDIDATES = ["\t", ";", ","] as const;
const SAMPLE_LINES = 20;

/**
 * The delimiter that splits the first lines most consistently, counting only
 * outside quotes: "Nom;Prix" then "Robe;1,5" is semicolon, not comma.
 */
function detectDelimiter(text: string): string {
  const counts: Record<string, number>[] = [];
  let current: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  let blank = true;
  for (let i = 0; i < text.length && counts.length < SAMPLE_LINES && i < 1_000_000; i++) {
    const ch = text[i];
    if (ch === '"') {
      quoted = !quoted;
      blank = false;
    } else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (!blank) counts.push(current);
      current = { ",": 0, ";": 0, "\t": 0 };
      blank = true;
    } else {
      if (!quoted && ch in current) current[ch]++;
      if (ch.trim()) blank = false;
    }
  }
  if (!blank && counts.length < SAMPLE_LINES) counts.push(current);
  if (!counts.length) return ",";

  let best = ",";
  let bestScore = -1;
  for (const candidate of CANDIDATES) {
    const first = counts[0][candidate];
    if (!first) continue;
    const consistent = counts.filter((line) => line[candidate] === first).length;
    // Consistency first, then how many columns it gives.
    const score = consistent * 1000 + Math.min(first, 999);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Rows of text from a CSV file. The apostrophe writeCsv puts before a
 * formula-like value is taken off again, so a file round-trips unchanged.
 * Trailing empty cells and blank trailing lines are dropped, like readXlsx.
 */
export function readCsv(bytes: Uint8Array, limits?: CsvLimits): string[][] {
  const maxBytes = limits?.maxBytes ?? XLSX_LIMITS.maxBytes;
  const maxRows = limits?.maxRows ?? XLSX_LIMITS.maxRows;
  const maxCols = limits?.maxCols ?? XLSX_LIMITS.maxCols;
  if (bytes.length > maxBytes) throw new SpreadsheetError("too_large", "The file is too large.");

  const text = decodeText(bytes);
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;

  const endField = () => {
    if (row.length >= maxCols && field !== "") {
      throw new SpreadsheetError("too_large", `A row has more than ${maxCols} columns.`);
    }
    if (field.length > XLSX_LIMITS.maxCell) throw new SpreadsheetError("too_large", "A cell holds too much text.");
    // Undo writeCsv's formula guard; only before the characters it guards.
    if (field.length > 1 && field[0] === "'" && FORMULA_START.test(field.slice(1))) field = field.slice(1);
    row.push(field);
    field = "";
    wasQuoted = false;
  };
  const endRow = () => {
    endField();
    while (row.length && row[row.length - 1] === "") row.pop();
    if (row.length && rows.length >= maxRows) {
      throw new SpreadsheetError("too_many_rows", `The file has more than ${maxRows} rows.`);
    }
    rows.push(row);
    row = [];
    // Blank lines count toward the limit only once something follows them.
    if (rows.length > maxRows + 10_000) throw new SpreadsheetError("too_many_rows", "The file has too many lines.");
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      // Text after a closing quote, or a quote mid-field: kept as is, like Excel does.
      field += ch;
    }
  }
  if (quoted) throw new SpreadsheetError("malformed", "A quoted field is not closed.");
  if (field !== "" || row.length || wasQuoted) endRow();
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}
