"use client";

import { createContext, useContext, useEffect, useMemo } from "react";
import { createI18n, type Locale } from "./index";

// Shared components on the English marketing pages work without a provider.
const I18nContext = createContext(createI18n("en"));

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  const value = useMemo(() => createI18n(locale), [locale]);
  // Arabic reads right to left; every other interface language left to right.
  const dir = locale === "ar" ? "rtl" : "ltr";

  useEffect(() => {
    const previous = document.documentElement.lang;
    const previousDir = document.documentElement.dir;
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    return () => {
      document.documentElement.lang = previous;
      document.documentElement.dir = previousDir;
    };
  }, [locale, dir]);

  return (
    <I18nContext.Provider value={value}>
      <div lang={locale} dir={dir} className="contents">
        {children}
      </div>
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
