"use client";

/**
 * Create or edit a Facebook campaign: which Page and post, which keywords,
 * the private reply with its link button, and an optional public reply.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import KeywordInput from "@/components/keyword-input";
import ProductSelect from "@/components/facebook/product-select";
import { useFbI18n } from "@/lib/facebook/i18n/client";
import { translateReason, type FbStaticKey } from "@/lib/facebook/i18n";
import { useI18n } from "@/lib/i18n/provider";

type PageOption = { id: string; name: string; status: string };
type Post = { id: string; message: string; createdTime: string | null; permalink: string | null; picture: string | null };

export type CampaignFormValues = {
  name: string;
  facebookPageId: string;
  matchAnyPost: boolean;
  postId: string;
  postPermalink: string;
  postPreview: string;
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
  privateReplyMessage: string;
  buttonLabel: string;
  landingUrl: string;
  addUtm: boolean;
  publicReplyEnabled: boolean;
  publicReplyText: string;
  botContext: string;
  /** A product of the catalog, or "" for none. */
  productId: string;
  isActive: boolean;
};

export function defaultCampaignValues(arabic: boolean): CampaignFormValues {
  return {
    name: "",
    facebookPageId: "",
    matchAnyPost: false,
    postId: "",
    postPermalink: "",
    postPreview: "",
    keywords: ["سعر", "prix", "price"],
    matchAnyWord: false,
    wholeWordMatch: true,
    privateReplyMessage: arabic
      ? "مرحبا {name} 👋 كل التفاصيل والسعر في الرابط 👇"
      : "Hi {name} 👋 All the details and the price are here 👇",
    buttonLabel: arabic ? "شوف التفاصيل" : "See details",
    landingUrl: "https://",
    addUtm: true,
    publicReplyEnabled: false,
    publicReplyText: arabic ? "بعثنالك في الخاص 📩" : "Sent you a message 📩",
    botContext: "",
    productId: "",
    isActive: true,
  };
}

/** The first problem with the form, as a message key, or null. */
export function validateCampaign(values: CampaignFormValues): FbStaticKey | null {
  if (!values.name.trim()) return "Give the campaign a name.";
  if (!values.facebookPageId) return "Choose a connected Page of this brand.";
  if (!values.matchAnyPost && !/^\d+_\d+$/.test(values.postId.trim())) {
    return "Pick a post, or answer comments on any post.";
  }
  if (!values.matchAnyWord && values.keywords.length === 0) return "Add a keyword, or answer every comment.";
  const message = values.privateReplyMessage.trim();
  if (!message || Array.from(message).length > 640) return "Message: 1 to 640 characters.";
  const label = values.buttonLabel.trim();
  if (!label || Array.from(label).length > 20) return "Button text: 1 to 20 characters.";
  try {
    const url = new URL(values.landingUrl.trim());
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) throw new Error();
  } catch {
    return "Enter a valid link starting with https://";
  }
  if (values.publicReplyEnabled && publicReplies(values).length === 0) return "Add at least one public reply.";
  return null;
}

function publicReplies(values: CampaignFormValues): string[] {
  return values.publicReplyText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);
}

export function toPayload(values: CampaignFormValues) {
  return {
    name: values.name.trim(),
    facebookPageId: values.facebookPageId,
    matchAnyPost: values.matchAnyPost,
    postId: values.matchAnyPost ? null : values.postId.trim(),
    postPermalink: values.matchAnyPost ? null : values.postPermalink || null,
    postPreview: values.matchAnyPost ? null : values.postPreview.slice(0, 300) || null,
    keywords: values.keywords,
    matchAnyWord: values.matchAnyWord,
    wholeWordMatch: values.wholeWordMatch,
    privateReplyMessage: values.privateReplyMessage.trim(),
    buttonLabel: values.buttonLabel.trim(),
    landingUrl: values.landingUrl.trim(),
    addUtm: values.addUtm,
    publicReplyEnabled: values.publicReplyEnabled,
    publicReplyMessages: values.publicReplyEnabled ? publicReplies(values) : [],
    botContext: values.botContext.trim() || null,
    productId: values.productId || null,
    isActive: values.isActive,
  };
}

const inputClass =
  "w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent/40";

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <span className="text-foreground">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export default function CampaignForm({
  campaignId,
  initial,
}: {
  campaignId?: string;
  initial?: CampaignFormValues;
}) {
  const router = useRouter();
  const { locale } = useI18n();
  const { t, dir } = useFbI18n();
  const [values, setValues] = useState<CampaignFormValues>(() => initial ?? defaultCampaignValues(dir === "rtl"));
  const [pages, setPages] = useState<PageOption[] | null>(null);
  const [posts, setPosts] = useState<{ pageId: string; items: Post[] | null; failed: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof CampaignFormValues>(key: K, value: CampaignFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    let cancelled = false;
    fetch("/api/facebook/pages", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled || !payload?.success) return;
        const usable = (payload.data.pages as PageOption[]).filter((page) => page.status !== "DISCONNECTED");
        setPages(usable);
        setValues((current) =>
          current.facebookPageId || usable.length === 0 ? current : { ...current, facebookPageId: usable[0].id }
        );
      })
      .catch(() => {
        if (!cancelled) setPages([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pageId = values.facebookPageId;
  const wantPosts = Boolean(pageId) && !values.matchAnyPost;
  useEffect(() => {
    if (!wantPosts) return;
    let cancelled = false;
    fetch(`/api/facebook/pages/${pageId}/posts`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        setPosts({ pageId, items: payload?.success ? payload.data.posts : null, failed: !payload?.success });
      })
      .catch(() => {
        if (!cancelled) setPosts({ pageId, items: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, wantPosts]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const problem = validateCampaign(values);
    if (problem) {
      setError(t(problem));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(campaignId ? `/api/facebook/campaigns/${campaignId}` : "/api/facebook/campaigns", {
        method: campaignId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPayload(values)),
      });
      const payload = await response.json();
      if (!payload.success) {
        setError(payload.error ? translateReason(t, payload.error) : t("Something went wrong. Please try again."));
        setSaving(false);
        return;
      }
      router.push("/facebook/campaigns");
      router.refresh();
    } catch {
      setError(t("Could not reach the server. Please try again."));
      setSaving(false);
    }
  }

  const currentPosts = posts && posts.pageId === pageId ? posts : null;
  const previewText = values.privateReplyMessage.replace(/\{name\}/g, dir === "rtl" ? "أمينة" : "Amina");

  if (pages && pages.length === 0) {
    return (
      <div className="panel space-y-3 rounded p-6 text-sm">
        <p className="text-foreground">{t("Connect a Facebook Page before creating a campaign.")}</p>
        <a href="/facebook/pages" className="inline-block rounded bg-accent px-4 py-2 font-medium text-accent-foreground hover:bg-accent-hover">
          {t("Connect a Page")}
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={save} className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1fr_320px]">
      {/* min-w-0: the one-line post previews must truncate, not widen the column past the screen. */}
      <div className="min-w-0 space-y-6">
        <section className="panel space-y-4 rounded p-4 sm:p-6">
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-foreground">{t("Campaign name")}</span>
            <input value={values.name} onChange={(event) => set("name", event.target.value)} maxLength={100} className={inputClass} />
          </label>

          <label className="block space-y-1">
            <span className="text-sm font-semibold text-foreground">{t("Facebook Page")}</span>
            <select
              value={values.facebookPageId}
              onChange={(event) => setValues((current) => ({ ...current, facebookPageId: event.target.value, postId: "", postPermalink: "", postPreview: "" }))}
              className={inputClass}
            >
              {(pages ?? []).map((page) => (
                <option key={page.id} value={page.id}>
                  {page.name}
                </option>
              ))}
            </select>
          </label>

          <div className="space-y-3">
            <Toggle
              checked={values.matchAnyPost}
              onChange={(value) => set("matchAnyPost", value)}
              label={t("Answer comments on any post")}
              hint={t("Includes ads. A campaign for one post takes priority over this.")}
            />
            {!values.matchAnyPost && (
              <div className="space-y-2">
                <p className="text-sm font-semibold text-foreground">{t("Post")}</p>
                {!currentPosts && <p className="text-xs text-muted">{t("Loading posts…")}</p>}
                {currentPosts?.failed && <p className="text-xs text-warning">{t("Could not load the posts. Paste the post ID instead.")}</p>}
                {currentPosts?.items && (
                  <div className="max-h-72 space-y-1 overflow-y-auto rounded border border-border p-1">
                    {currentPosts.items.length === 0 && <p className="p-2 text-xs text-muted">{t("No posts found.")}</p>}
                    {currentPosts.items.map((post) => (
                      <label
                        key={post.id}
                        className={`flex cursor-pointer items-center gap-3 rounded p-2 text-sm hover:bg-surface-hover ${values.postId === post.id ? "bg-surface-hover" : ""}`}
                      >
                        <input
                          type="radio"
                          name="post"
                          checked={values.postId === post.id}
                          onChange={() =>
                            setValues((current) => ({
                              ...current,
                              postId: post.id,
                              postPermalink: post.permalink ?? "",
                              postPreview: post.message,
                            }))
                          }
                        />
                        {post.picture && (
                          // eslint-disable-next-line @next/next/no-img-element -- Facebook CDN thumbnail
                          <img src={post.picture} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-foreground" dir="auto">
                            {post.message || t("(no text)")}
                          </span>
                          {post.createdTime && (
                            <span className="text-xs text-muted">{new Date(post.createdTime).toLocaleDateString(locale)}</span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <input
                  value={values.postId}
                  onChange={(event) => set("postId", event.target.value)}
                  placeholder="1234567890_9876543210"
                  aria-label={t("Post ID")}
                  dir="ltr"
                  className={`${inputClass} font-mono text-xs`}
                />
              </div>
            )}
          </div>
        </section>

        <section className="panel space-y-4 rounded p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-foreground">{t("Keywords")}</h2>
          {!values.matchAnyWord && <KeywordInput keywords={values.keywords} onChange={(keywords) => set("keywords", keywords)} max={20} />}
          <Toggle checked={values.matchAnyWord} onChange={(value) => set("matchAnyWord", value)} label={t("Answer every comment")} />
          {!values.matchAnyWord && (
            <Toggle
              checked={values.wholeWordMatch}
              onChange={(value) => set("wholeWordMatch", value)}
              label={t("Whole words only")}
              hint={t("Arabic forms still match: سعر also matches السعر and بالسعر and سعرو.")}
            />
          )}
        </section>

        <section className="panel space-y-4 rounded p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-foreground">{t("Private reply")}</h2>
          <label className="block space-y-1">
            <span className="text-xs text-muted">
              {t("Message ({placeholder} is replaced by the person's first name)", { placeholder: "{name}" })}
            </span>
            <textarea
              value={values.privateReplyMessage}
              onChange={(event) => set("privateReplyMessage", event.target.value)}
              rows={3}
              dir="auto"
              className={inputClass}
            />
            <span className="block text-end text-xs text-muted">{Array.from(values.privateReplyMessage).length}/640</span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs text-muted">{t("Button text (20 characters at most)")}</span>
              <input value={values.buttonLabel} onChange={(event) => set("buttonLabel", event.target.value)} maxLength={20} dir="auto" className={inputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted">{t("Landing page link")}</span>
              <input value={values.landingUrl} onChange={(event) => set("landingUrl", event.target.value)} dir="ltr" className={inputClass} />
            </label>
          </div>
          <Toggle
            checked={values.addUtm}
            onChange={(value) => set("addUtm", value)}
            label={t("Add UTM parameters to the link")}
            hint="utm_source=facebook · utm_medium=comment"
          />
        </section>

        <section className="panel space-y-4 rounded p-4 sm:p-6">
          <Toggle
            checked={values.publicReplyEnabled}
            onChange={(value) => set("publicReplyEnabled", value)}
            label={t("Also reply publicly under the comment")}
            hint={t("One reply per line; one is picked at random each time.")}
          />
          {values.publicReplyEnabled && (
            <textarea value={values.publicReplyText} onChange={(event) => set("publicReplyText", event.target.value)} rows={3} dir="auto" className={inputClass} />
          )}
        </section>

        <section className="panel space-y-4 rounded p-4 sm:p-6">
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-foreground">{t("What is this campaign about? (for the bot)")}</span>
            <span className="block text-xs text-muted">
              {t("When someone answers the private reply, the bot knows which product they came for.")}
            </span>
            <textarea value={values.botContext} onChange={(event) => set("botContext", event.target.value)} rows={2} maxLength={2000} dir="auto" className={inputClass} />
          </label>
          <div className="space-y-1">
            <label htmlFor="campaign-product" className="block text-sm font-semibold text-foreground">
              {t("Product (optional)")}
            </label>
            <span className="block text-xs text-muted">
              {t("The bot reads this product's full card in the conversations of this campaign.")}
            </span>
            <ProductSelect id="campaign-product" value={values.productId} onChange={(productId) => set("productId", productId)} className={inputClass} />
          </div>
        </section>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <div className="panel space-y-3 rounded p-4">
          <p className="label-caps text-muted">{t("Preview")}</p>
          <div className="space-y-2 rounded-lg border border-border bg-background p-3">
            <p className="whitespace-pre-wrap break-words text-sm text-foreground" dir="auto">
              {previewText}
            </p>
            <div className="rounded border border-border py-1.5 text-center text-sm font-medium text-foreground" dir="auto">
              {values.buttonLabel || "…"}
            </div>
          </div>
        </div>
        <div className="panel space-y-3 rounded p-4">
          <Toggle checked={values.isActive} onChange={(value) => set("isActive", value)} label={t("Campaign active")} />
          {error && (
            <p role="alert" className="rounded border border-error/20 bg-error/10 p-2 text-xs text-error" dir="auto">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={saving}
            className="w-full rounded bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? t("Saving…") : campaignId ? t("Save changes") : t("Create campaign")}
          </button>
        </div>
      </aside>
    </form>
  );
}
