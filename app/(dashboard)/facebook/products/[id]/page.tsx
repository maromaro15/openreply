"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import DraftActions from "@/components/facebook/draft-actions";
import ProductEditor, { type ProductDetail, type TemplateAttribute } from "@/components/facebook/product-editor";
import { useFbI18n } from "@/lib/facebook/i18n/client";

type Loaded = { role: string; product: ProductDetail; attributes: TemplateAttribute[] };

export default function ProductPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useFbI18n();
  const [data, setData] = useState<Loaded | null>(null);
  const [missing, setMissing] = useState(false);
  // Bumped when a draft is approved: the card is read again, as an active one.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/catalog/products/${encodeURIComponent(id)}`, { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/catalog/attributes", { cache: "no-store" }).then((response) => response.json()),
    ])
      .then(([productPayload, attributesPayload]) => {
        if (cancelled) return;
        if (productPayload?.success && attributesPayload?.success) {
          setData({
            role: productPayload.data.role,
            product: productPayload.data.product,
            attributes: attributesPayload.data.attributes,
          });
        } else setMissing(true);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, version]);

  if (missing) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted">{t("Product not found.")}</p>
        <Link href="/facebook/products" className="text-foreground underline underline-offset-2">
          {t("Back to the products")}
        </Link>
      </div>
    );
  }
  if (!data) return <div className="panel h-64 rounded" />;
  const canEdit = data.role === "OWNER" || data.role === "ADMIN";
  return (
    <div className="space-y-4">
      {data.product.status === "DRAFT" && (
        <DraftActions productId={data.product.id} canEdit={canEdit} onApproved={() => setVersion((current) => current + 1)} />
      )}
      <ProductEditor
        // Opening another product from here (an alternative) starts a fresh form.
        key={`${data.product.id}:${version}`}
        product={data.product}
        template={data.attributes}
        canEdit={canEdit}
      />
    </div>
  );
}
