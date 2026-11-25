"use client";

/**
 * One product of the brand's catalog, or none. Lists the active products;
 * a product chosen earlier that is now a draft or archived stays selectable,
 * marked, so saving the form does not drop it silently.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useFbI18n } from "@/lib/facebook/i18n/client";

type Option = { id: string; name: string; code: string | null; status: "ACTIVE" | "DRAFT" | "ARCHIVED" };

/** The list API's largest page. */
const MAX_OPTIONS = 200;

function optionLabel(option: Option): string {
  return option.code ? `${option.name} · ${option.code}` : option.name;
}

export default function ProductSelect({
  value,
  onChange,
  className,
  id,
}: {
  value: string;
  onChange: (productId: string) => void;
  className: string;
  id?: string;
}) {
  const { t } = useFbI18n();
  const [options, setOptions] = useState<Option[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The selected product, when it is not among the active ones.
  const [extra, setExtra] = useState<{ id: string; option: Option | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/catalog/products?status=ACTIVE&take=${MAX_OPTIONS}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.success) setOptions(payload.data.products as Option[]);
        else {
          setOptions([]);
          setFailed(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setOptions([]);
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const missing = Boolean(value) && options !== null && !options.some((option) => option.id === value);
  useEffect(() => {
    if (!missing) return;
    let cancelled = false;
    fetch(`/api/catalog/products/${encodeURIComponent(value)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setExtra({ id: value, option: payload?.success ? (payload.data.product as Option) : null });
      })
      .catch(() => {
        if (!cancelled) setExtra({ id: value, option: null });
      });
    return () => {
      cancelled = true;
    };
  }, [missing, value]);

  if (options === null) {
    return (
      <select id={id} disabled className={className}>
        <option>{t("Loading products…")}</option>
      </select>
    );
  }

  const extraOption = missing && extra?.id === value ? extra.option : null;
  return (
    <div className="space-y-1">
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={className}>
        <option value="">{t("No product")}</option>
        {missing && (
          <option value={value}>
            {extraOption
              ? `${optionLabel(extraOption)} (${extraOption.status === "DRAFT" ? t("Draft") : t("In the archive")})`
              : t("A product that is not active")}
          </option>
        )}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
      {missing && (
        <p className="text-xs text-warning">{t("This product is not active: the bot does not use it until it is active again.")}</p>
      )}
      {failed && <p className="text-xs text-warning">{t("Could not load the products.")}</p>}
      {!failed && options.length === 0 && !value && (
        <p className="text-xs text-muted">
          {t("No active products yet.")}{" "}
          <Link href="/facebook/products" className="text-accent hover:underline">
            {t("Add products")}
          </Link>
        </p>
      )}
    </div>
  );
}
