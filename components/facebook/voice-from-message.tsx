"use client";

/**
 * Brand voice from the inbox, under a reply:
 * - a person's reply: «Save as voice example»;
 * - a bot reply: «Correct this reply», saved as an example of how it should
 *   have been written, or (owners and admins) as a dictionary entry.
 */
import { useState } from "react";
import type { FbI18n } from "@/lib/facebook/i18n";
import { splitPhrases, VOICE_LIMITS } from "@/lib/voice/format";

type Mode = "example" | "correction";

const field =
  "mt-1 block w-full resize-y rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground";

export default function VoiceFromMessage({
  messageId,
  text,
  question,
  bot,
  canManage,
  t,
}: {
  messageId: string;
  text: string;
  question: string;
  /** A bot reply, to correct; otherwise a person's reply, to keep. */
  bot: boolean;
  /** Owners and admins: may add to the brand's dictionary. */
  canManage: boolean;
  t: FbI18n["t"];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("example");
  const [customer, setCustomer] = useState("");
  const [reply, setReply] = useState("");
  const [wrong, setWrong] = useState("");
  const [right, setRight] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function start() {
    setCustomer(Array.from(question).slice(0, VOICE_LIMITS.customer).join(""));
    setReply(Array.from(text).slice(0, VOICE_LIMITS.reply).join(""));
    setWrong("");
    setRight("");
    setMode("example");
    setError(null);
    setOpen(true);
  }

  const rights = splitPhrases(right);
  const ready =
    mode === "example" ? Boolean(customer.trim() && reply.trim()) : Boolean(wrong.trim() && rights.length > 0);

  async function save() {
    if (saving || !ready) return;
    setSaving(true);
    setError(null);
    try {
      const body =
        mode === "example"
          ? { kind: "example", messageId, customer, reply }
          : { kind: "correction", messageId, wrong, right: rights };
      const response = await fetch("/api/voice/from-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.success) {
        setDone(
          mode === "example"
            ? payload.data.created
              ? t("Saved as a voice example.")
              : t("Already a voice example.")
            : t("Saved in the brand's dictionary.")
        );
        setOpen(false);
      } else {
        setError(payload?.code === "full" ? t("The list is full.") : t("Something went wrong. Please try again."));
      }
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <p role="status" className={`text-[11px] text-success ${bot ? "text-start" : "text-end"}`}>
        {done}
      </p>
    );
  }
  if (!open) {
    return (
      <div className={`flex ${bot ? "justify-start" : "justify-end"}`}>
        <button
          type="button"
          onClick={start}
          className="text-[11px] text-muted underline-offset-2 hover:text-foreground hover:underline"
        >
          {bot ? t("Correct this reply") : t("Save as voice example")}
        </button>
      </div>
    );
  }
  return (
    <div className={`w-full max-w-md space-y-2 rounded border border-border bg-surface p-3 text-xs ${bot ? "me-auto" : "ms-auto"}`}>
      <p className="text-muted">
        {bot
          ? t("Write the reply the way your team would say it. The bot copies the style of the examples, never their facts.")
          : t("Keep how your team said it, so the bot talks the same way. It copies the style, never the facts.")}
      </p>
      {bot && canManage && (
        <div className="flex flex-wrap gap-3" role="radiogroup" aria-label={t("Save as")}>
          {(["example", "correction"] as const).map((value) => (
            <label key={value} className="flex items-center gap-1.5 text-foreground">
              <input type="radio" name={`voice-${messageId}`} checked={mode === value} onChange={() => setMode(value)} />
              {value === "example" ? t("An example of a good reply") : t("A wrong phrase to fix (dictionary)")}
            </label>
          ))}
        </div>
      )}
      {mode === "example" ? (
        <>
          <label className="block">
            <span className="text-muted">{t("What the customer said")}</span>
            <textarea value={customer} onChange={(event) => setCustomer(event.target.value)} maxLength={VOICE_LIMITS.customer} rows={2} dir="auto" className={field} />
          </label>
          <label className="block">
            <span className="text-muted">{bot ? t("The right reply") : t("The reply")}</span>
            <textarea value={reply} onChange={(event) => setReply(event.target.value)} maxLength={VOICE_LIMITS.reply} rows={3} dir="auto" className={field} />
          </label>
        </>
      ) : (
        <>
          <p className="rounded bg-surface-hover px-2 py-1.5 text-foreground" dir="auto">
            {text}
          </p>
          <label className="block">
            <span className="text-muted">{t("Wrong phrase")}</span>
            <input value={wrong} onChange={(event) => setWrong(event.target.value)} maxLength={VOICE_LIMITS.phrase} dir="auto" placeholder="انهي لون" className={field} />
          </label>
          <label className="block">
            <span className="text-muted">{t("Right phrase (one per line)")}</span>
            <textarea value={right} onChange={(event) => setRight(event.target.value)} rows={3} dir="auto" placeholder={"واش من لون\nاما كولور حبيت"} className={field} />
          </label>
        </>
      )}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => setOpen(false)}
          className="rounded border border-border px-3 py-1.5 font-medium text-foreground hover:bg-surface-hover disabled:opacity-60"
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          disabled={saving || !ready}
          onClick={() => void save()}
          className="rounded bg-accent px-3 py-1.5 font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-60"
        >
          {saving ? t("Saving…") : t("Save")}
        </button>
      </div>
    </div>
  );
}
