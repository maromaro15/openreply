"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ProductEditor, { type TemplateAttribute } from "@/components/facebook/product-editor";
import { useFbI18n } from "@/lib/facebook/i18n/client";

export default function NewProductPage() {
  const { t } = useFbI18n();
  const [data, setData] = useState<{ role: string; attributes: TemplateAttribute[] } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/catalog/attributes", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.success) setData(payload.data);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return <p className="text-sm text-error">{t("Could not load the attributes.")}</p>;
  if (!data) return <div className="panel h-64 rounded" />;
  if (data.role !== "OWNER" && data.role !== "ADMIN") {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted">{t("Only owners and admins can change the products.")}</p>
        <Link href="/facebook/products" className="text-accent hover:underline">
          {t("Back to the products")}
        </Link>
      </div>
    );
  }
  return <ProductEditor product={null} template={data.attributes} canEdit />;
}
