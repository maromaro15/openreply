"use client";

/**
 * The brand's product catalog: search by name or code, filter, approve
 * drafts, archive. Owners and admins edit; members read.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { translateReason, type FbStaticKey } from "@/lib/facebook/i18n";
import { useFbI18n } from "@/lib/facebook/i18n/client";

type Status = "ACTIVE" | "DRAFT" | "ARCHIVED";
type Source = "MANUAL" | "IMPORT" | "POST" | "CONVERSATION" | "INTERVIEW";
type Filter = "ALL" | Status;
type Summary = {
  id: string;
  name: string;
  code: string | null;
  price: string | null;
  available: boolean;
  status: Status;
  source: Source;
  image: { path: string } | null;
  variantCount: number;
  updatedAt: string;
};

const FILTERS: { value: Filter; label: FbStaticKey }[] = [
  { value: "ALL", label: "All" },
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Drafts" },
  { value: "ARCHIVED", label: "Archived" },
];

const SOURCES: Record<Exclude<Source, "MANUAL">, FbStaticKey> = {
  IMPORT: "From a file",
  POST: "From a post",
  CONVERSATION: "From conversations",
  INTERVIEW: "From a voice interview",
};

const SEARCH_DELAY_MS = 300;

function productsUrl(view: { search: string; filter: Filter; availableOnly: boolean }, cursor: string | null): string {
  const params = new URLSearchParams();
  if (view.search) params.set("search", view.search);
  if (view.filter !== "ALL") params.set("status", view.filter);
  if (view.availableOnly) params.set("available", "true");
  if (cursor) params.set("cursor", cursor);
  return `/api/catalog/products?${params.toString()}`;
}

export default function ProductsPage() {
  const { t } = useFbI18n();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [availableOnly, setAvailableOnly] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [products, setProducts] = useState<Summary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The search runs once the person stops typing.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    fetch(productsUrl({ search, filter, availableOnly }, null), { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.success) {
          setRole(payload.data.role);
          setProducts(payload.data.products);
          setNextCursor(payload.data.nextCursor);
          setError(null);
        } else setError(t("Could not load the products."));
      })
      .catch(() => {
        if (!cancelled) setError(t("Could not load the products."));
      });
    return () => {
      cancelled = true;
    };
  }, [search, filter, availableOnly, reloadKey, t]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const payload = await fetch(productsUrl({ search, filter, availableOnly }, nextCursor), { cache: "no-store" }).then(
        (response) => response.json()
      );
      if (payload?.success) {
        setProducts((current) => [...(current ?? []), ...payload.data.products]);
        setNextCursor(payload.data.nextCursor);
      } else setError(t("Could not load the products."));
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setLoadingMore(false);
    }
  }

  async function setStatus(product: Summary, status: Status) {
    setBusy(product.id);
    setError(null);
    try {
      const response = await fetch(`/api/catalog/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setError(payload?.error ? translateReason(t, payload.error) : t("Something went wrong. Please try again."));
      }
    } catch {
      setError(t("Could not reach the server. Please try again."));
    } finally {
      setBusy(null);
      setReloadKey((key) => key + 1);
    }
  }

  const canEdit = role === "OWNER" || role === "ADMIN";

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          {t("Each product has its card: what the bot knows to answer, compare and help the customer choose. Drafts are not used until a person approves them.")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/facebook/products/attributes"
            className="rounded border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-hover"
          >
            {t("Product attributes")}
          </Link>
          {canEdit && (
            <Link
              href="/facebook/products/new"
              className="rounded bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover"
            >
              {t("New product")}
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder={t("Search by name or code")}
          aria-label={t("Search by name or code")}
          dir="auto"
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground sm:w-72"
        />
        <div className="flex flex-wrap gap-1" role="tablist">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={filter === option.value}
              onClick={() => setFilter(option.value)}
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
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={availableOnly} onChange={(event) => setAvailableOnly(event.target.checked)} />
          {t("Available only")}
        </label>
      </div>

      {error && (
        <p role="alert" className="text-sm text-error" dir="auto">
          {error}
        </p>
      )}

      {!products ? (
        !error && <p className="text-sm text-muted">{t("Loading…")}</p>
      ) : products.length === 0 ? (
        <div className="rounded border border-border p-6 text-sm text-muted">
          {search || filter !== "ALL" || availableOnly ? (
            t("No product matches.")
          ) : (
            <span>
              {t("No products yet.")}{" "}
              {canEdit && (
                <Link href="/facebook/products/new" className="text-accent hover:underline">
                  {t("Add the first one")}
                </Link>
              )}
            </span>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded border border-border">
          {products.map((product) => (
            <li key={product.id} className="flex flex-wrap items-center gap-3 p-3">
              <Link href={`/facebook/products/${product.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                {product.image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- served by this app, any size
                  <img src={product.image.path} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
                ) : (
                  <span className="h-12 w-12 shrink-0 rounded bg-surface-hover" aria-hidden />
                )}
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block truncate text-sm font-medium text-foreground" dir="auto">
                    {product.name}
                    {product.code && (
                      <span className="ms-2 font-mono text-xs text-muted" dir="ltr">
                        {product.code}
                      </span>
                    )}
                  </span>
                  <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                    {product.price && <span dir="auto">{product.price}</span>}
                    {product.variantCount > 0 && (
                      <span>{t("{count} colours or types", { count: product.variantCount })}</span>
                    )}
                    {!product.available && <span className="text-warning">{t("Not available")}</span>}
                    {product.status === "DRAFT" && <span className="text-warning">{t("Draft")}</span>}
                    {product.status === "ARCHIVED" && <span>{t("In the archive")}</span>}
                    {product.source !== "MANUAL" && <span>{t(SOURCES[product.source])}</span>}
                  </span>
                </span>
              </Link>
              {canEdit && (
                <div className="flex shrink-0 gap-2">
                  {product.status === "DRAFT" && (
                    <button
                      type="button"
                      disabled={busy === product.id}
                      onClick={() => void setStatus(product, "ACTIVE")}
                      className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-60"
                    >
                      {t("Approve")}
                    </button>
                  )}
                  {product.status === "ACTIVE" && (
                    <button
                      type="button"
                      disabled={busy === product.id}
                      onClick={() => void setStatus(product, "ARCHIVED")}
                      className="rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-hover disabled:opacity-60"
                    >
                      {t("Archive")}
                    </button>
                  )}
                  {product.status === "ARCHIVED" && (
                    <button
                      type="button"
                      disabled={busy === product.id}
                      onClick={() => void setStatus(product, "ACTIVE")}
                      className="rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface-hover disabled:opacity-60"
                    >
                      {t("Restore")}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="rounded border border-border px-4 py-2 text-sm text-foreground hover:bg-surface-hover disabled:opacity-60"
        >
          {loadingMore ? t("Loading…") : t("Load more")}
        </button>
      )}
    </div>
  );
}
