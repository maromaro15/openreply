"use client";

import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { createFbI18n } from "./index";

/** Copy for the Facebook, agency and alerts screens, in the interface language. */
export function useFbI18n() {
  const { locale } = useI18n();
  return useMemo(() => createFbI18n(locale), [locale]);
}
