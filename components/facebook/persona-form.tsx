"use client";

/**
 * The bot's persona, goal, the order details it collects and its sales
 * playbook. Owners and admins edit; members read.
 */
import { useEffect, useState } from "react";
import { translateReason, type FbStaticKey } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";

type Goal = "SELL" | "COLLECT_ORDER" | "COLLECT_INFO" | "ANSWER_ONLY";
type OrderField = "WILAYA" | "COLOUR" | "QUANTITY" | "NAME" | "PHONE" | "ADDRESS";

type Persona = {
  personaName: string | null;
  personaStyle: string | null;
  dialect: string | null;
  goal: Goal;
  goalNotes: string | null;
  playbook: string | null;
};

type Loaded = {
  role: string;
  persona: Persona;
  orderFields: OrderField[];
  defaultPlaybook: string;
  limits: { name: number; style: number; dialect: number; goalNotes: number; playbook: number };
};

const GOALS: { value: Goal; label: FbStaticKey; hint: FbStaticKey }[] = [
  { value: "SELL", label: "Sell", hint: "Help the customer choose, then take the order details." },
  { value: "COLLECT_ORDER", label: "Take orders", hint: "Collect the order details as soon as the customer is interested." },
  { value: "COLLECT_INFO", label: "Collect contact details", hint: "Collect the details so the team can call back." },
  { value: "ANSWER_ONLY", label: "Answer only", hint: "Answer questions; a person takes every order." },
];

const FIELDS: { value: OrderField; label: FbStaticKey }[] = [
  { value: "WILAYA", label: "Wilaya" },
  { value: "COLOUR", label: "Colour or type" },
  { value: "QUANTITY", label: "Quantity" },
  { value: "NAME", label: "Name" },
  { value: "PHONE", label: "Phone number" },
  { value: "ADDRESS", label: "Address" },
];

const inputClass =
  "block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-60";

export default function PersonaForm() {
  const { t } = useFbI18n();
  const [data, setData] = useState<Loaded | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [fields, setFields] = useState<OrderField[]>([]);
  const [playbook, setPlaybook] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/bot/persona", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (!payload?.success) {
          setMessage({ ok: false, text: t("Could not load the bot's persona.") });
          return;
        }
        const loaded = payload.data as Loaded;
        setData(loaded);
        setPersona(loaded.persona);
        setFields(loaded.orderFields);
        setPlaybook(loaded.persona.playbook ?? loaded.defaultPlaybook);
      })
      .catch(() => {
        if (!cancelled) setMessage({ ok: false, text: t("Could not load the bot's persona.") });
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  if (!data || !persona) {
    return message ? (
      <p role="alert" className="text-sm text-error">
        {message.text}
      </p>
    ) : (
      <p className="text-sm text-muted">{t("Loading…")}</p>
    );
  }

  const canEdit = data.role === "OWNER" || data.role === "ADMIN";
  const collects = persona.goal !== "ANSWER_ONLY";
  const set = <K extends keyof Persona>(key: K, value: Persona[K]) => setPersona({ ...persona, [key]: value });

  async function save() {
    if (!persona) return;
    if (collects && fields.length === 0) {
      setMessage({ ok: false, text: t("Choose at least one order detail to collect.") });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/bot/persona", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...persona, orderFields: fields, playbook }),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.success) {
        setPersona(payload.data.persona);
        setFields(payload.data.orderFields);
        setMessage({ ok: true, text: t("Saved.") });
      } else {
        setMessage({
          ok: false,
          text: payload?.error ? translateReason(t, payload.error) : t("Something went wrong. Please try again."),
        });
      }
    } catch {
      setMessage({ ok: false, text: t("Could not reach the server. Please try again.") });
    } finally {
      setBusy(false);
    }
  }

  const isDefault = playbook.trim() === data.defaultPlaybook.trim();

  return (
    <fieldset disabled={!canEdit} className="min-w-0 space-y-6">
      {!canEdit && <p className="text-sm text-muted">{t("Only owners and admins can change the bot.")}</p>}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">{t("Who the bot is")}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-sm">
            <span className="text-muted">{t("Name it gives itself (optional)")}</span>
            <input
              value={persona.personaName ?? ""}
              onChange={(event) => set("personaName", event.target.value)}
              maxLength={data.limits.name}
              dir="auto"
              placeholder={t("Example: Lina, from the Maison Lina team")}
              className={inputClass}
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-muted">{t("Dialect (empty: the customer's own)")}</span>
            <input
              value={persona.dialect ?? ""}
              onChange={(event) => set("dialect", event.target.value)}
              maxLength={data.limits.dialect}
              dir="auto"
              placeholder={t("Example: Algerian Darija")}
              className={inputClass}
            />
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t("Style")}</span>
          <input
            value={persona.personaStyle ?? ""}
            onChange={(event) => set("personaStyle", event.target.value)}
            maxLength={data.limits.style}
            dir="auto"
            placeholder={t("Example: warm, short, says «خويا» and «ختي»")}
            className={inputClass}
          />
        </label>
        <p className="text-xs text-muted">{t("The bot never says it is a person: asked, it says it is the shop's assistant.")}</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">{t("Goal")}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {GOALS.map((goal) => (
            <label
              key={goal.value}
              className={`flex cursor-pointer gap-2 rounded border p-3 text-sm ${
                persona.goal === goal.value ? "border-accent bg-accent/5" : "border-border"
              }`}
            >
              <input
                type="radio"
                name="goal"
                className="mt-1"
                checked={persona.goal === goal.value}
                onChange={() => set("goal", goal.value)}
              />
              <span>
                <span className="block font-medium text-foreground">{t(goal.label)}</span>
                <span className="block text-xs text-muted">{t(goal.hint)}</span>
              </span>
            </label>
          ))}
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t("Notes on the goal (optional)")}</span>
          <textarea
            value={persona.goalNotes ?? ""}
            onChange={(event) => set("goalNotes", event.target.value)}
            maxLength={data.limits.goalNotes}
            rows={2}
            dir="auto"
            className={inputClass}
          />
        </label>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">{t("Order details to collect")}</h2>
        <p className="text-xs text-muted">
          {collects
            ? t("Once they are all given and valid, a person gets the order to confirm, as «Order ready to confirm».")
            : t("With «Answer only», the bot collects nothing: a customer ready to buy goes to a person.")}
        </p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {FIELDS.map((field) => (
            <label key={field.value} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                disabled={!collects}
                checked={fields.includes(field.value)}
                onChange={(event) =>
                  setFields((current) =>
                    event.target.checked ? [...current, field.value] : current.filter((value) => value !== field.value)
                  )
                }
              />
              {t(field.label)}
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">{t("Sales playbook")}</h2>
          <button
            type="button"
            disabled={isDefault}
            onClick={() => setPlaybook(data.defaultPlaybook)}
            className="rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-hover disabled:opacity-50"
          >
            {t("Restore the default playbook")}
          </button>
        </div>
        <p className="text-xs text-muted">
          {t("How the bot persuades, step by step. The strict rules always win: no invented price, discount, scarcity or promise.")}
        </p>
        <textarea
          value={playbook}
          onChange={(event) => setPlaybook(event.target.value)}
          maxLength={data.limits.playbook}
          rows={16}
          dir="auto"
          className={`${inputClass} font-mono text-xs leading-relaxed`}
        />
        <p className="text-end text-xs text-muted">
          {isDefault ? t("The default playbook") : t("This brand's playbook")} · {playbook.length}/{data.limits.playbook}
        </p>
      </section>

      {message && (
        <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-success" : "text-error"}`} dir="auto">
          {message.text}
        </p>
      )}
      {canEdit && (
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-60"
        >
          {busy ? t("Saving…") : t("Save changes")}
        </button>
      )}
    </fieldset>
  );
}
