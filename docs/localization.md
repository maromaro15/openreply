# Interface languages

OpenReply defaults to English. Choose **English**, **繁體中文**, **Português (Brasil)**, **Русский**, **Español** or **العربية** in the dashboard
sidebar, under **Settings → Interface language**, or on the sign-in screen.
The choice is stored in a browser cookie for one year and applies to the
dashboard, sign-in screens, workspace invitations, and shared campaign reports.

Changing the interface language does not translate campaign names, keywords,
outgoing messages, button text, imported CSV data, or Instagram content. An
unsaved campaign stays in the editor when switching languages. Default outgoing
message content retains its original values in both languages.

Public marketing, template playbooks, legal pages, authentication emails, and
raw API/provider error details remain in English. Those are outside this
interface translation's scope.

## Adding or changing copy

- `lib/i18n/zh-TW.json` maps English source copy to Traditional Chinese and
  `lib/i18n/pt-BR.json` to Brazilian Portuguese, `lib/i18n/ru.json` to Russian, `lib/i18n/es.json` to Spanish, `lib/i18n/ar.json` to Arabic. All catalogs must carry exactly
  the same keys; a missing key fails the typecheck. Use complete sentences with
  named placeholders when word order can vary.
- Client components use `useI18n()`; server components use `await getI18n()`.
  `t("Hello, {name}!", { name })` checks both the message key and required
  placeholders at compile time. Never pass user content as a translation key.
- `label(value)` translates known status, role, and weekday display labels.
  Unknown values pass through; stored values and API filters stay unchanged.
- Format dates and numbers with the selected `locale`. Translate input hints,
  not values already entered by the user.
- Remove unused catalog entries when removing UI copy. The catalog tests check
  that translations retain their interpolation fields and contain plain text.

## Arabic and right-to-left layout

Arabic (`ar`) is a supported interface language and is right-to-left. The
layout uses Tailwind logical classes, so the same markup renders correctly in
both directions. New UI must use logical classes instead of physical ones:

- `ms-*` / `me-*` instead of `ml-*` / `mr-*`, and `ps-*` / `pe-*` instead of
  `pl-*` / `pr-*` (negative values too: `-ml-2` becomes `-ms-2`).
- `start-*` / `end-*` instead of `left-*` / `right-*`.
- `text-start` / `text-end` instead of `text-left` / `text-right`.
- `border-s` / `border-e` instead of `border-l` / `border-r`, and
  `rounded-s` / `rounded-e` / `rounded-ss` / `rounded-se` / `rounded-es` /
  `rounded-ee` instead of `rounded-l` / `rounded-r` / `rounded-tl` /
  `rounded-tr` / `rounded-bl` / `rounded-br`.
- Add `rtl:space-x-reverse` next to a `space-x-*` that separates items in a
  row, and `rtl:-translate-x-*` next to a direction-dependent `translate-x-*`.
- Charts and other number or time-axis displays stay left to right: put
  `dir="ltr"` on their container.

The optional `DEFAULT_LOCALE` environment variable sets the language a visitor
gets before choosing one (for example `DEFAULT_LOCALE=ar`). Without it, English
remains the default.

## Rendering and persistence

The locale cookie is validated on the server; missing or unsupported values
fall back to English. A server action saves it and re-renders the current route
without remounting the editor. The action sets a same-site, HTTP-only cookie,
with the secure flag in production. There is no translation dependency, new
database column, or change to the sending worker.

Providers live in the localized route layouts, below the root layout. This
keeps the public marketing and template pages statically rendered. Localized
content has a server-rendered `lang` attribute; the provider also updates the
document language while mounted and restores it when leaving these routes.

## Validation

Run the contribution checks in `CONTRIBUTING.md`. The locale unit tests cover
preference validation, persistence, English fallback, interpolation, and status
labels. For browser verification:

1. Start with no locale cookie: sign-in should display English.
2. Switch to Traditional Chinese (and again to Brazilian Portuguese), reload, and navigate to another localized
   route: the selected language, labels, and dates should remain consistent.
3. In the campaign editor, change a message and toggle an option without saving.
   Switch languages: both draft values and the selected post should remain.
4. Switch back to English, including on a narrow viewport using the sidebar.
5. Visit a public marketing page: it should remain English.
