import { describe, expect, it } from "vitest";
import ar from "../../lib/facebook/i18n/ar.json";
import { createFbI18n } from "../../lib/facebook/i18n";
import { IMPORT_SHEETS, matchImageFiles, parseImport, type ImportAttribute, type Sheet } from "../../lib/catalog/import/catalog";
import {
  FIELD_LABELS,
  fillMessage,
  IMPORT_SHEET_NAMES,
  IMPORT_TEMPLATES,
  translateImportLabel,
  translateImportMessage,
} from "../../lib/catalog/import/messages";

const arabic = createFbI18n("ar");
const english = createFbI18n("en");
const say = (message: string) => translateImportMessage(arabic.t, message);

const attributes: ImportAttribute[] = [
  { key: "thickness", label: "Thickness", type: "NUMBER", unit: "mm", options: [] },
  { key: "waterproof", label: "Waterproof", type: "BOOLEAN", unit: null, options: [] },
];

const sheet = (name: string, rows: string[][]): Sheet => ({ name, rows });
const products = (rows: string[][]) => sheet(IMPORT_SHEETS.products, rows);

function rowErrors(rows: string[][], extra: Sheet[] = []): string[] {
  const { rows: parsed } = parseImport([products(rows), ...extra], attributes, new Map());
  expect(parsed).toHaveLength(1);
  return parsed[0].errors;
}

const templates = [...new Set<string>(Object.values(IMPORT_TEMPLATES))];
const placeholdersOf = (template: string) => [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
const NUMBERS = new Set(["max", "line", "row", "count"]);

describe("the templates", () => {
  it("are all keys of the Arabic catalog, with their own Arabic", () => {
    for (const template of templates) expect(ar, template).toHaveProperty([template]);
    for (const label of [...Object.values(FIELD_LABELS), ...Object.values(IMPORT_SHEET_NAMES)]) expect(ar, label).toHaveProperty([label]);
  });

  it("fill to English and translate back, each one", () => {
    expect(templates.length).toBeGreaterThan(40);
    for (const template of templates) {
      const values: Record<string, string> = {};
      const arabicValues: Record<string, string> = {};
      for (const name of placeholdersOf(template)) {
        if (name === "error") {
          values[name] = fillMessage(IMPORT_TEMPLATES.empty);
          arabicValues[name] = arabic.t(IMPORT_TEMPLATES.empty);
        } else {
          values[name] = NUMBERS.has(name) ? "7" : name === "letter" ? "AB" : `v-${name}`;
          arabicValues[name] = values[name];
        }
      }
      const message = (fillMessage as (template: string, values: Record<string, string>) => string)(template, values);
      expect(message, template).toBe((english.t as (key: string, values: Record<string, string>) => string)(template, values));

      // English stays as it is, Arabic is the catalog's text with the values in place.
      expect(translateImportMessage(english.t, message), template).toBe(message);
      const expected = (arabic.t as (key: string, values: Record<string, string>) => string)(template, arabicValues);
      expect(say(message), template).toBe(expected);
      expect(expected, template).toMatch(/[؀-ۿ]/);
    }
  });

  it("translate a message inside a message", () => {
    const inner = fillMessage(IMPORT_TEMPLATES.fieldIssue, { column: "Colour code", error: fillMessage(IMPORT_TEMPLATES.tooLong, { max: 40 }) });
    const message = fillMessage(IMPORT_TEMPLATES.colourRowIssue, { sheet: "Colours", row: 4, error: inner });
    expect(message).toBe("Colours row 4: Colour code: at most 40 characters.");
    expect(say(message)).toBe("الألوان، السطر 4: كود اللون: 40 حرفاً على الأكثر.");
    expect(translateImportMessage(english.t, message)).toBe(message);
  });
});

describe("what is not ours", () => {
  it("is returned unchanged", () => {
    for (const text of [
      "",
      "Something else entirely",
      "Name: a note somebody wrote",
      "Colours row 4: a note somebody wrote",
      "Code: at most many characters.",
      "Stock: answer yes or no (not",
      "الاسم: ملاحظة",
    ]) {
      expect(say(text), text).toBe(text);
    }
  });

  it("does not turn a header into a template or a placeholder", () => {
    const header = "{sheet} {row} $& {error} <b>x</b>";
    const message = fillMessage(IMPORT_TEMPLATES.unknownColumn, { header });
    expect(message).toBe(`Unknown column "${header}"; it was not read.`);
    expect(say(message)).toBe(`العمود «${header}» غير معروف؛ لم يُقرأ.`);
    // A header that looks like a message of ours is only text inside the quotes.
    const tricky = `a"; it was not read.`;
    expect(say(fillMessage(IMPORT_TEMPLATES.unknownColumn, { header: tricky }))).toBe(`العمود «${tricky}» غير معروف؛ لم يُقرأ.`);
  });

  it("leaves a fixed sentence of the catalog to the caller", () => {
    expect(say("The file is empty.")).toBe("The file is empty.");
  });
});

describe("labels", () => {
  it("translate the app's own column and sheet names only", () => {
    expect(translateImportLabel(arabic.t, "Name")).toBe("الاسم");
    expect(translateImportLabel(arabic.t, "Colours")).toBe("الألوان");
    expect(translateImportLabel(arabic.t, "Mes produits")).toBe("Mes produits");
    expect(translateImportLabel(english.t, "Name")).toBe("Name");
  });

  it("are the ones the codec falls back to", () => {
    expect(rowErrors([["Code"], ["WP-1"]])).toEqual(["Name: Give the product a name."]);
  });
});

describe("real messages of the codec", () => {
  it("keeps the English of a file read and shows it in Arabic", () => {
    const errors = rowErrors([
      ["Nom", "Disponible", "Points forts", "Questions", "Thickness", "Waterproof", "Mystère"],
      ["", "peut-être", `${"x".repeat(301)}`, "no arrow here", "thick", "maybe", "?"],
    ]);
    expect(errors).toEqual([
      'Disponible: answer yes or no (not "peut-être").',
      'Questions (line 1): write it as "question => answer".',
      "Thickness: write a number, like 12 or 1.5.",
      "Waterproof: answer yes or no.",
      "Nom: Give the product a name.",
      "Points forts (line 1): at most 300 characters.",
    ]);
    expect(errors.map(say)).toEqual([
      "Disponible: أجب بنعم أو لا (وليس «peut-être»).",
      "Questions (السطر 1): اكتبه هكذا «السؤال => الجواب».",
      `Thickness: ${ar["{label}: write a number, like 12 or 1.5."].replace("{label}: ", "")}`,
      "Waterproof: أجب بنعم أو لا.",
      `Nom: ${ar["Give the product a name."]}`,
      "Points forts (السطر 1): 300 حرفاً على الأكثر.",
    ]);
  });

  it("covers the notes about a file", () => {
    const { problems } = parseImport(
      [products([["Nom", "Couleur préférée", "", "Nom"], ["Lampe", "bleu", "x", "y"]]), sheet("Divers", [["a"]])],
      attributes,
      new Map()
    );
    expect(problems.map((problem) => problem.message)).toEqual([
      'The sheet "Divers" was not read.',
      'Unknown column "Couleur préférée"; it was not read.',
      "Column C has no header; it was not read.",
      'The column "Nom" repeats "Nom"; only the first one is read.',
    ]);
    expect(problems.map((problem) => say(problem.message))).toEqual([
      "الورقة «Divers» لم تُقرأ.",
      "العمود «Couleur préférée» غير معروف؛ لم يُقرأ.",
      "العمود C بلا عنوان؛ لم يُقرأ.",
      "العمود «Nom» يكرّر «Nom»؛ يُقرأ الأول فقط.",
    ]);

    const none = parseImport([], attributes, new Map()).problems.map((problem) => problem.message);
    expect(none).toContain('No "Products" sheet in the file.');
    expect(say('No "Products" sheet in the file.')).toBe("لا توجد ورقة «المنتجات» في الملف.");
  });

  it("covers the colours sheet, nested", () => {
    const errors = rowErrors(
      [["Code", "Nom"], ["WP-1", "Lampe"]],
      [sheet(IMPORT_SHEETS.colours, [["Code produit", "Code couleur", "Disponible"], ["WP-1", "12-04", "bof"], ["WP-1", "", ""], ["WP-1", "12-04", ""]])]
    );
    expect(errors).toEqual([
      'Colours row 2: Disponible: answer yes or no (not "bof").',
      "Colours row 3: Code couleur: Give each colour or type its code.",
      "Colours row 4: Code couleur: The code 12-04 is used twice.",
    ]);
    expect(errors.map(say)).toEqual([
      "الألوان، السطر 2: Disponible: أجب بنعم أو لا (وليس «bof»).",
      `الألوان، السطر 3: Code couleur: ${ar["Give each colour or type its code."]}`,
      "الألوان، السطر 4: Code couleur: الكود 12-04 مستعمل مرتين.",
    ]);
  });

  it("covers a repeated code and the cap on a row's errors", () => {
    const { rows } = parseImport(
      [products([["Code", "Nom"], ["WP-1", "A"], ["wp 1", "B"]])],
      attributes,
      new Map()
    );
    expect(rows[1].errors).toEqual(["Code: wp 1 is already on row 2."]);
    expect(say(rows[1].errors[0])).toBe("الكود: wp 1 موجود بالفعل في السطر 2.");

    const many = Array.from({ length: 12 }, (_, index) => `${"x".repeat(301)}${index}`).join("\n");
    const [last] = rowErrors([["Nom", "Points forts"], ["", many]]).slice(-1);
    expect(last).toBe("And 4 more.");
    expect(say(last)).toBe(ar["And {count} more."].replace("{count}", "4"));
  });

  it("covers the reasons of the pictures", () => {
    const { unmatched } = matchImageFiles(
      ["notes.txt", "---.jpg", "ZZ-99.jpg", "01.jpg", "WP-12.jpg", "wp12.png"],
      [
        { code: "WP-12", variantCodes: ["01"] },
        { code: "WP-13", variantCodes: ["01"] },
      ]
    );
    expect(unmatched.map((item) => item.reason)).toEqual([
      "not a picture (jpg, jpeg, png or webp)",
      "no code in the name",
      "no product or colour has this code",
      "ambiguous: could be WP-12 01, WP-13 01",
      "duplicate: WP-12.jpg is already this picture",
    ]);
    expect(unmatched.map((item) => say(item.reason))).toEqual([
      ar["not a picture (jpg, jpeg, png or webp)"],
      ar["no code in the name"],
      ar["no product or colour has this code"],
      "غير واضح: قد يكون WP-12 01, WP-13 01",
      "مكرّر: الملف WP-12.jpg يمثّل هذه الصورة من قبل",
    ]);

    const files = Array.from({ length: 10_001 }, (_, index) => `${index}.jpg`);
    const last = matchImageFiles(files, []).unmatched.at(-1);
    expect(last?.reason).toBe("too many files (10000 at most)");
    expect(say(last?.reason ?? "")).toBe("ملفات كثيرة جداً (10000 على الأكثر)");
  });
});
