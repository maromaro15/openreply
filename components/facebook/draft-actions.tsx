"use client";

/**
 * The banner of a product draft: where it was read from, and the three
 * decisions. Approve makes it active (the bot starts using it), Merge folds it
 * into a product the brand already has (copying only what that one lacks), and
 * Reject deletes it. Members see the banner but not the actions.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ProductSelect from "@/components/facebook/product-select";
import { translateReason, type FbStaticKey } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";

type Source = "MANUAL" | "IMPORT" | "POST" | "CONVERSATION" | "INTERVIEW";
type DraftInfo = {
  source: Source;
  sourceRef: string | null;
  sourceLink: string | null;
  sourceNote: string | null;
  /** The post's code, which another product already has: the draft was made without it. */
  codeClash: { code: string; holder: string } | null;
  suggestedTargetId: string | null;
  suggestedBy: "code" | "name" | null;
};

const SOURCES: Record<Exclude<Source, "MANUAL">, FbStaticKey> = {
  IMPORT: "From a file",
  POST: "From a post",
  CONVERSATION: "From conversations",
  INTERVIEW: "From a voice interview",
};

type Decision = "approve" | "merge" | "reject";

const buttonClass = "rounded px-3 py-2 text-sm font-medium disabled:opacity-60";

export default function DraftActions({
  productId,
  canEdit,
  onApproved,
}: {
  productId: string;
  canEdit: boolean;
  /** The card is active now: reload it. */
  onApproved: () => void;
}) {
  const { t } = useFbI18n();
  const router = useRouter();
  const [info, setInfo] = useState<DraftInfo | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [confirmReject, setConfirmReject] = useState(false);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/catalog/products/${encodeURIComponent(productId)}/draft`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.success) {
          const draft = payload.data.draft as DraftInfo;
          setInfo(draft);
          // The product with the same code or name is the likely duplicate.
          setTargetId((current) => current || draft.suggestedTargetId || "");
        } else setLoadFailed(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  async function decide(action: Decision) {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`/api/catalog/products/${encodeURIComponent(productId)}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "merge" ? { action, targetId } : { action }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setError(payload?.error ? translateReason(t, payload.error) : t("Something went wrong. Please try again."));
        // The code is the other product's: offer it as the merge target.
        if (payload?.code === "code_clash" && typeof payload?.target?.id === "string") setTargetId(payload.target.id);
        return;
      }
      if (action === "approve") onApproved();
      else if (action === "merge") router.push(`/facebook/products/${payload.data.target.id}`);
      else router.push("/facebook/products");
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setBusy(null);
      setConfirmReject(false);
    }
  }

  const fromPost = info?.source === "POST";
  const sourceLabel = info && info.source !== "MANUAL" ? t(SOURCES[info.source]) : null;

  return (
    <section className="mx-auto max-w-6xl space-y-3 rounded border border-warning/40 bg-warning/10 p-4 text-sm">
      <div className="space-y-1">
        <h2 className="font-semibold text-foreground">
          {fromPost ? t("A draft read from a post of your Page") : t("A draft waiting for your decision")}
        </h2>
        <p className="text-muted">{t("The bot does not use a draft until it is approved.")}</p>
      </div>

      {info && (
        <div className="space-y-2">
          {(sourceLabel || info.sourceRef) && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              {sourceLabel && <span>{sourceLabel}</span>}
              {info.sourceLink ? (
                <a
                  href={info.sourceLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-2"
                >
                  {t("Open the post")}
                </a>
              ) : (
                info.sourceRef && (
                  <span className="max-w-full truncate" dir="auto">
                    {info.sourceRef}
                  </span>
                )
              )}
            </p>
          )}
          {info.codeClash && (
            <p className="text-xs text-foreground" dir="auto">
              {t("The post gives the code {code}, which «{name}» already has: the draft was made without it. Merge it into that product.", {
                code: info.codeClash.code,
                name: info.codeClash.holder,
              })}
            </p>
          )}
          {info.sourceNote && (
            <figure className="space-y-1">
              <figcaption className="text-xs text-muted">{t("It was read from this sentence:")}</figcaption>
              {/* Written by a Page and a model: plain text, never HTML. */}
              <blockquote className="line-clamp-4 break-words border-s-2 border-warning/60 ps-3 text-foreground" dir="auto">
                {info.sourceNote}
              </blockquote>
            </figure>
          )}
        </div>
      )}
      {loadFailed && <p className="text-xs text-warning">{t("Could not load where this draft came from.")}</p>}

      {canEdit ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void decide("approve")}
              className={`${buttonClass} bg-accent text-accent-foreground hover:bg-accent-hover`}
            >
              {busy === "approve" ? t("Working…") : t("Approve")}
            </button>
            <span className="text-xs text-muted">{t("Save your edits first: approving does not save the form.")}</span>
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <label htmlFor="draft-merge-target" className="block font-semibold text-foreground">
              {t("Merge into an existing product")}
            </label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <ProductSelect
                  id="draft-merge-target"
                  value={targetId}
                  onChange={setTargetId}
                  className="block w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground"
                />
              </div>
              <button
                type="button"
                disabled={busy !== null || !targetId}
                onClick={() => void decide("merge")}
                className={`${buttonClass} border border-border text-foreground hover:bg-surface-hover`}
              >
                {busy === "merge" ? t("Working…") : t("Merge")}
              </button>
            </div>
            {info?.suggestedBy && targetId === info.suggestedTargetId && (
              <p className="text-xs text-muted">
                {info.suggestedBy === "code"
                  ? t("This product has the same code as the draft.")
                  : t("This product has the same name as the draft.")}
              </p>
            )}
            <p className="text-xs text-muted">
              {t(
                "Copies only what that product lacks (price, colours, pictures, strengths), never overwrites what you wrote, then deletes this draft."
              )}
            </p>
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            {confirmReject ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-foreground">{t("Delete this draft and its pictures?")}</span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void decide("reject")}
                  className={`${buttonClass} bg-error text-white hover:opacity-90`}
                >
                  {busy === "reject" ? t("Working…") : t("Yes, reject it")}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setConfirmReject(false)}
                  className={`${buttonClass} border border-border text-foreground hover:bg-surface-hover`}
                >
                  {t("Cancel")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setConfirmReject(true)}
                className={`${buttonClass} border border-error/40 text-error hover:bg-error/10`}
              >
                {t("Reject")}
              </button>
            )}
          </div>

          {error && (
            <p role="alert" className="text-xs text-error" dir="auto">
              {error}
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">{t("Only owners and admins can decide on drafts.")}</p>
      )}
    </section>
  );
}
