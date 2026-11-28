"use client";

import Link from "next/link";
import ProductImport from "@/components/facebook/product-import";
import { useFbI18n } from "@/lib/facebook/i18n/client";

export default function ImportProductsPage() {
  const { t } = useFbI18n();
  return (
    <div className="space-y-4">
      <Link href="/facebook/products" className="inline-block text-sm text-foreground underline underline-offset-2">
        {t("Back to the products")}
      </Link>
      <ProductImport />
    </div>
  );
}
