"use client";

/**
 * Brand voice screen: example conversations the bot imitates and the
 * dictionary of phrases it must fix, for this brand and the global set,
 * with the auto-save setting and the JSON pack (export, import).
 */
import { useEffect, useState } from "react";
import type { FbI18n } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import { splitPhrases, VOICE_LIMITS, type VoiceSourceValue } from "@/lib/voice/format";

type Example = { id: string; global: boolean; customer: string; reply: string; source: VoiceSourceValue; active: boolean };
type Correction = { id: string; global: boolean; wrong: string; right: string[]; source: VoiceSourceValue; active: boolean };
type Voice = { autoSave: boolean; examples: Example[]; corrections: Correction[]; canEditGlobal: boolean };

const card = "space-y-3 rounded border border-border p-4";
const input = "block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-60";
const button =
  "rounded border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-hover disabled:opacity-60";
const primary = "rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-60";

const SOURCE_LABELS = {
  seed: "Default",
  manual: "Added by hand",
  human_reply: "Team reply",
  inbox_correction: "Inbox correction",
  import: "Imported",
} as const;

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; code?: string; error?: string }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok && Boolean(payload?.success), code: payload?.code, error: payload?.error };
}

function ExampleRow({ row, editable, onChange, t }: { row: Example; editable: boolean; onChange: () => void; t: FbI18n["t"] }) {
  const [editing, setEditing] = useState(false);
  const [customer, setCustomer] = useState(row.customer);
  const [reply, setReply] = useState(row.reply);
  const [busy, setBusy] = useState(false);

  async function run(method: string, body?: unknown) {
    setBusy(true);
    await send(`/api/voice/examples/${row.id}`, method, body).catch(() => null);
    setBusy(false);
    setEditing(false);
    onChange();
  }

  return (
    <li className={`space-y-1.5 rounded border border-border p-3 text-sm ${row.active ? "" : "opacity-60"}`}>
      {editing ? (
        <>
          <textarea value={customer} onChange={(event) => setCustomer(event.target.value)} maxLength={VOICE_LIMITS.customer} rows={2} dir="auto" className={input} />
          <textarea value={reply} onChange={(event) => setReply(event.target.value)} maxLength={VOICE_LIMITS.reply} rows={3} dir="auto" className={input} />
          <div className="flex gap-2">
            <button type="button" disabled={busy || !customer.trim() || !reply.trim()} onClick={() => void run("PATCH", { customer, reply })} className={button}>
              {t("Save")}
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)} className={button}>
              {t("Cancel")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted" dir="auto">
            <span className="font-medium text-foreground">{t("Customer")}:</span> {row.customer}
          </p>
          <p className="whitespace-pre-wrap text-foreground" dir="auto">
            <span className="font-medium">{t("Reply")}:</span> {row.reply}
          </p>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <span>{t(SOURCE_LABELS[row.source])}</span>
        {editable && !editing && (
          <>
            <label className="ms-auto flex items-center gap-1">
              <input type="checkbox" checked={row.active} disabled={busy} onChange={(event) => void run("PATCH", { active: event.target.checked })} />
              {t("On")}
            </label>
            <button type="button" disabled={busy} onClick={() => setEditing(true)} className={button}>
              {t("Edit")}
            </button>
            <button type="button" disabled={busy} onClick={() => void run("DELETE")} className={button}>
              {t("Delete")}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function CorrectionRow({ row, editable, onChange, t }: { row: Correction; editable: boolean; onChange: () => void; t: FbI18n["t"] }) {
  const [editing, setEditing] = useState(false);
  const [wrong, setWrong] = useState(row.wrong);
  const [right, setRight] = useState(row.right.join("\n"));
  const [busy, setBusy] = useState(false);

  async function run(method: string, body?: unknown) {
    setBusy(true);
    await send(`/api/voice/corrections/${row.id}`, method, body).catch(() => null);
    setBusy(false);
    setEditing(false);
    onChange();
  }

  return (
    <li className={`space-y-1.5 rounded border border-border p-3 text-sm ${row.active ? "" : "opacity-60"}`}>
      {editing ? (
        <>
          <input value={wrong} onChange={(event) => setWrong(event.target.value)} maxLength={VOICE_LIMITS.phrase} dir="auto" className={input} />
          <textarea value={right} onChange={(event) => setRight(event.target.value)} rows={3} dir="auto" className={input} />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !wrong.trim() || splitPhrases(right).length === 0}
              onClick={() => void run("PATCH", { wrong, right: splitPhrases(right) })}
              className={button}
            >
              {t("Save")}
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)} className={button}>
              {t("Cancel")}
            </button>
          </div>
        </>
      ) : (
        <p className="text-foreground" dir="auto">
          <span className="text-error line-through">{row.wrong}</span> → {row.right.join(" / ")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <span>{t(SOURCE_LABELS[row.source])}</span>
        {editable && !editing && (
          <>
            <label className="ms-auto flex items-center gap-1">
              <input type="checkbox" checked={row.active} disabled={busy} onChange={(event) => void run("PATCH", { active: event.target.checked })} />
              {t("On")}
            </label>
            <button type="button" disabled={busy} onClick={() => setEditing(true)} className={button}>
              {t("Edit")}
            </button>
            <button type="button" disabled={busy} onClick={() => void run("DELETE")} className={button}>
              {t("Delete")}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function AddForm({ kind, canEditGlobal, onChange, t }: { kind: "examples" | "corrections"; canEditGlobal: boolean; onChange: () => void; t: FbI18n["t"] }) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [global, setGlobal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const examples = kind === "examples";
  const ready = Boolean(first.trim()) && (examples ? Boolean(second.trim()) : splitPhrases(second).length > 0);

  async function add() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const body = examples ? { customer: first, reply: second, global } : { wrong: first, right: splitPhrases(second), global };
    const result = await send(`/api/voice/${kind}`, "POST", body).catch(() => ({ ok: false, code: undefined, error: undefined }));
    setBusy(false);
    if (!result.ok) {
      setError(result.code === "full" ? t("The list is full.") : t("Something went wrong. Please try again."));
      return;
    }
    setFirst("");
    setSecond("");
    onChange();
  }

  return (
    <div className="space-y-2 rounded border border-dashed border-border p-3">
      <label className="block space-y-1 text-sm">
        <span className="text-muted">{examples ? t("What the customer said") : t("Wrong phrase")}</span>
        {examples ? (
          <textarea value={first} onChange={(event) => setFirst(event.target.value)} maxLength={VOICE_LIMITS.customer} rows={2} dir="auto" className={input} />
        ) : (
          <input value={first} onChange={(event) => setFirst(event.target.value)} maxLength={VOICE_LIMITS.phrase} dir="auto" placeholder="انهي لون" className={input} />
        )}
      </label>
      <label className="block space-y-1 text-sm">
        <span className="text-muted">{examples ? t("A good reply, in your shop's voice") : t("Right phrase (one per line)")}</span>
        <textarea
          value={second}
          onChange={(event) => setSecond(event.target.value)}
          maxLength={examples ? VOICE_LIMITS.reply : undefined}
          rows={3}
          dir="auto"
          placeholder={examples ? undefined : "واش من لون\nاما كولور حبيت"}
          className={input}
        />
      </label>
      {canEditGlobal && (
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={global} onChange={(event) => setGlobal(event.target.checked)} />
          {t("Add to the global set (every brand)")}
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <button type="button" disabled={!ready || busy} onClick={() => void add()} className={primary}>
        {t("Add")}
      </button>
    </div>
  );
}

export default function VoiceManager({ canManage }: { canManage: boolean }) {
  const { t } = useFbI18n();
  const [voice, setVoice] = useState<Voice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const reload = () => setReloadKey((key) => key + 1);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/voice", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.success) setVoice(payload.data);
        else setError(t("Could not load the brand voice."));
      })
      .catch(() => {
        if (!cancelled) setError(t("Could not load the brand voice."));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, t]);

  async function importPack(file: File, global: boolean) {
    setImportMessage(null);
    const body = await file.text().then((text) => JSON.parse(text)).catch(() => null);
    const response = await fetch(`/api/voice/pack${global ? "?scope=global" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setImportMessage(
      payload?.success
        ? t("Imported {examples} examples and {corrections} corrections.", payload.data)
        : t("This file is not a voice pack.")
    );
    reload();
  }

  if (error) return <p role="alert" className="text-sm text-error">{error}</p>;
  if (!voice) return <p className="text-sm text-muted">{t("Loading…")}</p>;

  const canEditRow = (row: { global: boolean }) => canManage && (!row.global || voice.canEditGlobal);
  const sections = [
    { kind: "examples" as const, title: t("Example conversations"), rows: voice.examples },
    { kind: "corrections" as const, title: t("Correction dictionary"), rows: voice.corrections },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <p className="text-sm text-muted">
        {t("The bot copies how your shop talks: it reads the examples closest to what the customer wrote, and fixes the phrases of the dictionary in every reply. Facts (prices, colours, delivery) still come only from the knowledge base and the catalog.")}
      </p>
      {!canManage && <p className="text-sm text-muted">{t("Only owners and admins can change the brand voice.")}</p>}

      <section className={card}>
        <h2 className="text-sm font-semibold text-foreground">{t("Learning from your team")}</h2>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="mt-1"
            checked={voice.autoSave}
            disabled={!canManage}
            onChange={async (event) => {
              await send("/api/voice", "PUT", { autoSave: event.target.checked }).catch(() => null);
              reload();
            }}
          />
          <span>
            {t("Save every reply your team writes to a customer as a voice example")}
            <span className="block text-xs text-muted">
              {t("Off: the inbox offers «Save as voice example» under each reply. Either way, you can review and delete the examples here.")}
            </span>
          </span>
        </label>
      </section>

      {sections.map((section) => {
        const brand = section.rows.filter((row) => !row.global);
        const global = section.rows.filter((row) => row.global);
        return (
          <section key={section.kind} className={card}>
            <h2 className="text-sm font-semibold text-foreground">{section.title}</h2>
            {canManage && <AddForm kind={section.kind} canEditGlobal={voice.canEditGlobal} onChange={reload} t={t} />}
            {[
              { title: t("This brand"), rows: brand },
              { title: t("Global set (every brand)"), rows: global },
            ].map((group) => (
              <div key={group.title} className="space-y-2">
                <h3 className="label-caps text-muted">
                  {group.title} · {group.rows.length}
                </h3>
                {group.rows.length === 0 ? (
                  <p className="text-sm text-muted">{t("Nothing here yet.")}</p>
                ) : (
                  <ul className="space-y-2">
                    {group.rows.map((row) =>
                      section.kind === "examples" ? (
                        <ExampleRow key={row.id} row={row as Example} editable={canEditRow(row)} onChange={reload} t={t} />
                      ) : (
                        <CorrectionRow key={row.id} row={row as Correction} editable={canEditRow(row)} onChange={reload} t={t} />
                      )
                    )}
                  </ul>
                )}
              </div>
            ))}
          </section>
        );
      })}

      {canManage && (
        <section className={card}>
          <h2 className="text-sm font-semibold text-foreground">{t("Export and import")}</h2>
          <p className="text-sm text-muted">
            {t("A voice pack is one JSON file with the examples and the dictionary, to copy to another brand or another tool.")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/* A download from the API, not a page: a plain navigation. */}
            <button type="button" onClick={() => window.location.assign("/api/voice/pack")} className={button}>
              {t("Export this brand")}
            </button>
            {voice.canEditGlobal && (
              <button type="button" onClick={() => window.location.assign("/api/voice/pack?scope=global")} className={button}>
                {t("Export the global set")}
              </button>
            )}
            <label className={`${button} cursor-pointer`}>
              {t("Import into this brand")}
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importPack(file, false);
                }}
              />
            </label>
          </div>
          {importMessage && (
            <p role="status" className="text-sm text-foreground">
              {importMessage}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
