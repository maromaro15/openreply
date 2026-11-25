/**
 * What a refused product change means, for the API (English) and the
 * screens (translated). No server code: the editor imports it too.
 */
import type { FbStaticKey } from "@/lib/facebook/i18n";

export const PRODUCT_ERRORS = {
  not_found: { status: 404, message: "Product not found." },
  too_many: { status: 400, message: "This brand has reached the number of products it can hold." },
  duplicate_code: { status: 409, message: "Another product of this brand already has this code." },
  invalid_attributes: { status: 400, message: "An attribute value does not fit its type." },
  unknown_image: { status: 400, message: "An image does not belong to this product." },
  unknown_related: { status: 400, message: "An alternative product is not one of this brand's products." },
} as const satisfies Record<string, { status: number; message: FbStaticKey }>;

export type ProductErrorCode = keyof typeof PRODUCT_ERRORS;

export function isProductErrorCode(value: unknown): value is ProductErrorCode {
  return typeof value === "string" && value in PRODUCT_ERRORS;
}
