"use client";

/**
 * Fill the catalog from a spreadsheet: download the template made for the
 * brand, pick the filled file (and, if wanted, a folder of pictures named by
 * code), read the preview, confirm. The preview only reads: the server reads
 * the file again on confirm. Pictures are sent one by one afterwards, each
 * matched again by the server, so a long folder shows its progress and a bad
 * picture never stops the others.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { translateReason, type FbStaticKey } from "@/lib/facebook/i18n";
import { translateImportLabel, translateImportMessage } from "@/lib/catalog/import/messages";
import { useFbI18n } from "@/lib/facebook/i18n/client";

type RowAction = "create" | "update" | "error";
type Filter = "ALL" | RowAction;

type PreviewRow = {
  sheet: string;
  row: number;
  code: string | null;
  name: string | null;
  action: RowAction;
  errors: string[];
};
type Problem = { sheet: string; row: number; message: string };
type Match = { fileName: string; productCode: string; variantCode: string | null };
type Preview = {
  role: string;
  summary: {
    total: number;
    create: number;
    update: number;
    error: number;
    withoutCode: number;
    products: number;
    productLimit: number;
    overLimit: boolean;
  };
  rows: PreviewRow[];
  problems: Problem[];
  pictures: { matched: Match[]; unmatched: { fileName: string; reason: string }[]; room: number };
};
type Outcome = {
  created: number;
  updated: number;
  unchanged: number;
  refused: number;
  failed: { sheet: string; row: number; code: string | null; name: string | null; message: string }[];
  products: { id: string; code: string | null; name: string; action: "created" | "updated" }[];
  moreProducts: number;
};
type Uploads = {
  total: number;
  done: number;
  stored: number;
  reused: number;
  failed: { fileName: string; reason: string }[];
  running: boolean;
  stopped: boolean;
};

const IMAGE_NAME = /\.(jpe?g|png|webp)$/i;
const FIRST_ROWS = 50;
const MORE_ROWS = 100;
const UPLOAD_WORKERS = 3;

const FILTERS: { value: Filter; label: FbStaticKey }[] = [
  { value: "ALL", label: "All" },
  { value: "create", label: "To create" },
  { value: "update", label: "To update" },
  { value: "error", label: "Refused" },
];

/**
 * A message of the codec or of the apply step (a row's error, a note about the
 * file, a picture's reason, a failed row): built from a template of
 * lib/catalog/import/messages, else a fixed sentence of the catalog, else shown as written.
 */
function importText(t: ReturnType<typeof useFbI18n>["t"], message: string): string {
  return translateReason(t, translateImportMessage(t, message));
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className="min-w-24 flex-1 rounded border border-border bg-surface p-3">
      <div className={`text-xl font-semibold ${tone ?? "text-foreground"}`}>{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded border border-border p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs text-white">{number}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function ProductImport() {
  const { t } = useFbI18n();
  const [role, setRole] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pictures, setPictures] = useState<File[]>([]);
  const [ignored, setIgnored] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [uploads, setUploads] = useState<Uploads | null>(null);
  const [busy, setBusy] = useState<"preview" | "confirm" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [shown, setShown] = useState(FIRST_ROWS);
  const stopRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const picturesInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/catalog/attributes", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled && payload?.success) setRole(payload.data.role);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const canConfirm = role === "OWNER" || role === "ADMIN";

  function resetResult() {
    setPreview(null);
    setOutcome(null);
    setUploads(null);
    setError(null);
    setFilter("ALL");
    setShown(FIRST_ROWS);
  }

  function chooseFile(next: File | null) {
    setFile(next);
    resetResult();
  }

  function choosePictures(list: FileList | null) {
    const all = Array.from(list ?? []);
    const images = all.filter((item) => IMAGE_NAME.test(item.name) && !item.name.startsWith("."));
    setPictures(images);
    setIgnored(all.length - images.length);
    resetResult();
  }

  async function failureText(response: Response): Promise<string> {
    const payload = await response.json().catch(() => null);
    return payload?.error ? translateReason(t, payload.error) : t("Something went wrong. Please try again.");
  }

  async function runPreview() {
    if (!file) return;
    setBusy("preview");
    resetResult();
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      if (pictures.length) form.append("images", JSON.stringify(pictures.map((item) => ({ name: item.name, size: item.size }))));
      const response = await fetch("/api/catalog/import/preview", { method: "POST", body: form });
      if (!response.ok) setError(await failureText(response));
      else setPreview((await response.json()).data);
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setBusy(null);
    }
  }

  async function uploadPictures(matches: Match[]) {
    const byName = new Map<string, File>();
    for (const item of pictures) if (!byName.has(item.name)) byName.set(item.name, item);
    const queue = [...matches];
    stopRef.current = false;
    let state: Uploads = { total: queue.length, done: 0, stored: 0, reused: 0, failed: [], running: true, stopped: false };
    setUploads(state);
    const publish = (patch: Partial<Uploads>) => {
      state = { ...state, ...patch };
      setUploads(state);
    };
    const worker = async () => {
      for (;;) {
        const match = queue.shift();
        if (!match || stopRef.current) return;
        const item = byName.get(match.fileName);
        let reason: string | null = null;
        let reused = false;
        if (!item) reason = t("The file is not selected any more.");
        else {
          try {
            const form = new FormData();
            form.append("file", item, item.name);
            const response = await fetch("/api/catalog/import/images", { method: "POST", body: form });
            if (!response.ok) reason = await failureText(response);
            else reused = response.status === 200;
          } catch {
            reason = t("Could not reach the server. Please try again.");
          }
        }
        publish({
          done: state.done + 1,
          stored: state.stored + (reason === null && !reused ? 1 : 0),
          reused: state.reused + (reason === null && reused ? 1 : 0),
          failed: reason === null ? state.failed : [...state.failed, { fileName: match.fileName, reason }],
        });
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_WORKERS }, worker));
    publish({ running: false, stopped: stopRef.current && state.done < state.total });
  }

  async function confirm() {
    if (!file || !preview || !canConfirm) return;
    setBusy("confirm");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const response = await fetch("/api/catalog/import", { method: "POST", body: form });
      if (!response.ok) {
        setError(await failureText(response));
        return;
      }
      setOutcome((await response.json()).data);
      setBusy(null);
      if (preview.pictures.matched.length) await uploadPictures(preview.pictures.matched);
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setBusy(null);
    }
  }

  const rows = preview ? preview.rows.filter((row) => filter === "ALL" || row.action === filter) : [];
  const finished = outcome !== null && !uploads?.running;
  const locked = busy !== null || uploads?.running === true;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <p className="max-w-2xl text-sm text-muted">
        {t("Fill a spreadsheet with your products, add the pictures if you have them, check the preview, then import. A product whose code already exists is updated; the others are created.")}
      </p>

      <Step number={1} title={t("Download the template")}>
        <p className="text-sm text-muted">
          {t("The template has your own attributes as columns. The Excel file also has the colours sheet; the CSV file has the products only.")}
        </p>
        <div className="flex flex-wrap gap-2">
          <a
            href="/api/catalog/import/template?format=xlsx"
            download
            className="rounded bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            {t("Download Excel (.xlsx)")}
          </a>
          <a
            href="/api/catalog/import/template?format=csv"
            download
            className="rounded border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-hover"
          >
            {t("Download CSV")}
          </a>
        </div>
      </Step>

      <Step number={2} title={t("Choose your file and pictures")}>
        <div className="space-y-2">
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-label={t("Spreadsheet file")}
            disabled={locked}
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
            className="block w-full text-sm text-foreground file:me-3 file:rounded file:border file:border-border file:bg-surface file:px-3 file:py-2 file:text-sm file:text-foreground"
          />
          <p className="text-xs text-muted">{t("An .xlsx or .csv file of 5 MB at most.")}</p>
        </div>

        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-sm text-foreground">{t("Pictures (optional)")}</p>
          <p className="text-xs text-muted">
            {t("Name each picture with the product code, like WP-12.jpg, or with the colour code, like WP-12_12-04.jpg or 12-04.jpg.")}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={locked}
              onClick={() => folderInput.current?.click()}
              className="rounded border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-hover disabled:opacity-60"
            >
              {t("Choose a folder")}
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => picturesInput.current?.click()}
              className="rounded border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-hover disabled:opacity-60"
            >
              {t("Choose pictures")}
            </button>
            {pictures.length > 0 && (
              <button
                type="button"
                disabled={locked}
                onClick={() => choosePictures(null)}
                className="rounded px-3 py-2 text-sm text-muted hover:text-foreground disabled:opacity-60"
              >
                {t("Remove the pictures")}
              </button>
            )}
          </div>
          {/* A folder where the browser has it, plain files elsewhere (most phones). */}
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            aria-label={t("Folder of pictures")}
            {...{ webkitdirectory: "" }}
            onChange={(event) => {
              choosePictures(event.target.files);
              event.target.value = "";
            }}
          />
          <input
            ref={picturesInput}
            type="file"
            multiple
            hidden
            accept="image/jpeg,image/png,image/webp"
            aria-label={t("Pictures")}
            onChange={(event) => {
              choosePictures(event.target.files);
              event.target.value = "";
            }}
          />
          <p className="text-xs text-muted" aria-live="polite">
            {t("{count} pictures chosen", { count: pictures.length })}
            {ignored > 0 && ` · ${t("{count} other files ignored", { count: ignored })}`}
          </p>
        </div>

        <button
          type="button"
          disabled={!file || locked}
          onClick={() => void runPreview()}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {busy === "preview" ? t("Reading the file…") : t("Preview")}
        </button>
      </Step>

      {error && (
        <p role="alert" className="text-sm text-error" dir="auto">
          {error}
        </p>
      )}

      {preview && (
        <Step number={3} title={t("Preview")}>
          <div className="flex flex-wrap gap-2">
            <Stat value={preview.summary.create} label={t("To create")} tone="text-success" />
            <Stat value={preview.summary.update} label={t("To update")} />
            <Stat value={preview.summary.error} label={t("Refused")} tone={preview.summary.error ? "text-error" : undefined} />
            <Stat value={preview.pictures.matched.length} label={t("Pictures matched")} />
          </div>

          {preview.summary.overLimit && (
            <p role="alert" className="text-sm text-warning">
              {t("This brand holds {count} products and can hold {limit}: the new products that do not fit will fail.", {
                count: preview.summary.products,
                limit: preview.summary.productLimit,
              })}
            </p>
          )}
          {preview.summary.withoutCode > 0 && (
            <p className="text-sm text-warning">
              {t("{count} rows have no code: they are created again each time you import the file.", { count: preview.summary.withoutCode })}
            </p>
          )}
          {preview.summary.update > 0 && (
            <p className="text-xs text-muted">
              {t("An update changes only the columns of your file. Colours are added or updated by code, and the pictures, the other colours and the related products stay.")}
            </p>
          )}

          {preview.problems.length > 0 && (
            <details className="rounded border border-border p-3 text-sm" open={preview.rows.length === 0}>
              <summary className="cursor-pointer text-foreground">
                {t("{count} notes about the file", { count: preview.problems.length })}
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-muted" dir="auto">
                {preview.problems.map((problem, index) => (
                  <li key={index} className="break-words">
                    {problem.sheet && <span className="font-medium text-foreground">{translateImportLabel(t, problem.sheet)}</span>}
                    {problem.row > 0 && <span> {t("row {row}", { row: problem.row })}</span>}
                    {(problem.sheet || problem.row > 0) && ": "}
                    {importText(t, problem.message)}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {preview.rows.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1" role="tablist">
                {FILTERS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={filter === option.value}
                    onClick={() => {
                      setFilter(option.value);
                      setShown(FIRST_ROWS);
                    }}
                    className={`rounded-full border px-3 py-1 text-xs ${
                      filter === option.value
                        ? "border-accent bg-accent/10 font-medium text-foreground"
                        : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    {t(option.label)}
                  </button>
                ))}
              </div>
              <ul className="divide-y divide-border rounded border border-border">
                {rows.slice(0, shown).map((row) => (
                  <li key={`${row.sheet}:${row.row}`} className="space-y-1 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="w-10 shrink-0 text-xs text-muted">#{row.row}</span>
                      {row.code && (
                        <span className="font-mono text-xs text-muted" dir="ltr">
                          {row.code}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-foreground" dir="auto">
                        {row.name ?? "—"}
                      </span>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${
                          row.action === "error"
                            ? "border-error text-error"
                            : row.action === "create"
                              ? "border-success text-success"
                              : "border-border text-foreground"
                        }`}
                      >
                        {row.action === "error" ? t("Refused") : row.action === "create" ? t("Create") : t("Update")}
                      </span>
                    </div>
                    {row.errors.length > 0 && (
                      <ul className="ms-10 list-disc space-y-0.5 ps-4 text-xs text-error" dir="auto">
                        {row.errors.map((message, index) => (
                          <li key={index} className="break-words">
                            {importText(t, message)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
              {rows.length > shown && (
                <button
                  type="button"
                  onClick={() => setShown((count) => count + MORE_ROWS)}
                  className="rounded border border-border px-3 py-1.5 text-sm text-foreground hover:bg-surface-hover"
                >
                  {t("Show more")}
                </button>
              )}
            </div>
          )}

          {pictures.length > 0 && (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-sm text-foreground">
                {t("{matched} pictures matched, {unmatched} not matched", {
                  matched: preview.pictures.matched.length,
                  unmatched: preview.pictures.unmatched.length,
                })}
              </p>
              {preview.pictures.unmatched.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-warning">{t("Pictures that match nothing: they will not be stored")}</summary>
                  <ul className="mt-2 space-y-1 text-xs text-muted">
                    {preview.pictures.unmatched.slice(0, 200).map((item, index) => (
                      <li key={index} className="break-words">
                        <span className="font-mono text-foreground" dir="ltr">
                          {item.fileName}
                        </span>
                        {": "}
                        {importText(t, item.reason)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          <div className="space-y-2 border-t border-border pt-3">
            {!canConfirm && <p className="text-sm text-muted">{t("Only owners and admins can import the products.")}</p>}
            <button
              type="button"
              disabled={!canConfirm || locked || finished || preview.summary.create + preview.summary.update === 0}
              onClick={() => void confirm()}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {busy === "confirm"
                ? t("Importing…")
                : t("Import {count} products", { count: preview.summary.create + preview.summary.update })}
            </button>
          </div>
        </Step>
      )}

      {uploads && (
        <section className="space-y-2 rounded border border-border p-4" aria-live="polite">
          <h2 className="text-sm font-semibold text-foreground">{t("Uploading the pictures")}</h2>
          <progress value={uploads.done} max={Math.max(uploads.total, 1)} className="h-2 w-full" />
          <p className="text-xs text-muted">{t("{done} of {total} pictures", { done: uploads.done, total: uploads.total })}</p>
          {uploads.running && (
            <button
              type="button"
              onClick={() => {
                stopRef.current = true;
              }}
              className="rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-hover"
            >
              {t("Stop")}
            </button>
          )}
          {uploads.stopped && <p className="text-sm text-warning">{t("Stopped: the pictures not sent yet were not stored.")}</p>}
        </section>
      )}

      {outcome && (
        <section className="space-y-3 rounded border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground">{t("Result")}</h2>
          <div className="flex flex-wrap gap-2">
            <Stat value={outcome.created} label={t("Created")} tone="text-success" />
            <Stat value={outcome.updated} label={t("Updated")} />
            <Stat value={outcome.unchanged} label={t("Unchanged")} />
            <Stat value={outcome.failed.length + outcome.refused} label={t("Not imported")} tone={outcome.failed.length + outcome.refused ? "text-error" : undefined} />
          </div>
          {uploads && !uploads.running && (
            <p className="text-sm text-foreground">
              {t("Pictures: {stored} stored, {reused} already there, {failed} failed", {
                stored: uploads.stored,
                reused: uploads.reused,
                failed: uploads.failed.length,
              })}
            </p>
          )}
          {outcome.failed.length > 0 && (
            <ul className="space-y-1 text-xs text-error" dir="auto">
              {outcome.failed.map((item) => (
                <li key={`${item.sheet}:${item.row}`} className="break-words">
                  {t("row {row}", { row: item.row })}
                  {item.code ? ` (${item.code})` : ""}: {importText(t, item.message)}
                </li>
              ))}
            </ul>
          )}
          {uploads && uploads.failed.length > 0 && !uploads.running && (
            <details className="text-sm">
              <summary className="cursor-pointer text-error">{t("Pictures that failed")}</summary>
              <ul className="mt-2 space-y-1 text-xs text-muted">
                {uploads.failed.slice(0, 200).map((item, index) => (
                  <li key={index} className="break-words">
                    <span className="font-mono text-foreground" dir="ltr">
                      {item.fileName}
                    </span>
                    {": "}
                    {item.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {outcome.products.length > 0 && (
            <ul className="divide-y divide-border rounded border border-border">
              {outcome.products.map((product) => (
                <li key={product.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2 text-sm">
                  <Link href={`/facebook/products/${product.id}`} className="min-w-0 flex-1 truncate text-accent hover:underline" dir="auto">
                    {product.name}
                  </Link>
                  {product.code && (
                    <span className="font-mono text-xs text-muted" dir="ltr">
                      {product.code}
                    </span>
                  )}
                  <span className="text-xs text-muted">{product.action === "created" ? t("Created") : t("Updated")}</span>
                </li>
              ))}
            </ul>
          )}
          {outcome.moreProducts > 0 && <p className="text-xs text-muted">{t("And {count} more.", { count: outcome.moreProducts })}</p>}
          <Link href="/facebook/products" className="inline-block text-sm text-accent hover:underline">
            {t("Back to the products")}
          </Link>
        </section>
      )}
    </div>
  );
}
