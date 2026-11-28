/**
 * Screen labels for what the bot reads of a customer: their state and the
 * order details. English source text; lib/facebook/i18n translates it.
 * Client-safe: types only from the bot modules.
 */
import type { FbStaticKey } from "@/lib/facebook/i18n";
import type { OrderFieldValue } from "./order";
import type { CustomerStateValue } from "./persona";

/** NEUTRAL has no badge: nothing to point out. */
export const CUSTOMER_STATE_LABELS: Record<CustomerStateValue, FbStaticKey | null> = {
  NEUTRAL: null,
  PRICE_ONLY: "Price only",
  HESITANT: "Hesitant",
  READY_TO_BUY: "Ready to buy",
  ANGRY: "Angry",
  WHOLESALE: "Wholesale",
  CUSTOM_ORDER: "Custom order",
};

export const CUSTOMER_STATE_BADGE: Record<CustomerStateValue, string> = {
  NEUTRAL: "",
  PRICE_ONLY: "border border-border text-muted",
  HESITANT: "bg-warning/10 text-warning",
  READY_TO_BUY: "bg-success/10 text-success",
  ANGRY: "bg-error/10 text-error",
  WHOLESALE: "bg-accent-soft text-foreground",
  CUSTOM_ORDER: "bg-accent-soft text-foreground",
};

export const ORDER_LINE_LABELS: Record<OrderFieldValue | "PRODUCT", FbStaticKey> = {
  PRODUCT: "Product",
  WILAYA: "Wilaya",
  COLOUR: "Colour or type",
  QUANTITY: "Quantity",
  NAME: "Name",
  PHONE: "Phone number",
  ADDRESS: "Address",
};
