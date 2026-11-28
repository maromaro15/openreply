import { getI18n } from "@/lib/i18n/server";
import { createFbI18n } from "./index";

export async function getFbI18n() {
  const { locale } = await getI18n();
  return createFbI18n(locale);
}
