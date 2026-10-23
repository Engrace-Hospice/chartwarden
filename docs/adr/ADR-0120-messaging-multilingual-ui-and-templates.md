# ADR-0120 — Messaging multilingual UI and reviewed template translations

- **Status:** **Proposed** (2026-10-23). Mechanism built for the saved-reply picker; Spanish is provisional and no clinician sign-off is recorded.
- **Date:** 2026-10-23
- **Phase:** Messaging Hub Phase 6, WP 6.4.
- **Related:** [ADR-0089](ADR-0089-messaging-export.md) (ADR style), `docs/messaging-hub/10-ui-spec-phases-4-to-6.md` section 6.4, `docs/messaging-hub/brief-clinical-lead-signoff.md`.

## Context

No i18n package exists in `apps/web`, `apps/admin` or `packages` (`locale` hits are date formatting). WP 6.4 asks for UI strings as keys, clinician-reviewed template translations, no machine translation of clinical content, and a visible English fallback.

## Decision

1. **Mechanism.** A small module, `apps/web/src/modules/36-messaging/i18n/` (no dependency added, no migration, no route, no table): `catalog.ts` (locales `en`, `es`; `translate()`; `resolveLocale()`), `template-translations.ts` (translation data and `pickTemplateText()`), `use-messaging-locale.tsx` (`currentLocale()`, `<Txt>`, `<EnTag>`). Locale: saved preference (`localStorage` `cw.messaging.locale`), else `navigator.languages`, else English. A server-side user preference is not built (needs an M4 column); the key is the seam.
2. **Visible fallback.** English is the source and the fallback. A missing or blank key returns the English text with `fallback: true`; the UI renders `lang="en"` on that segment and a visible `EN` tag. Every translated segment carries its own `lang` (WCAG 3.1.2). Tests: `i18n/catalog.test.ts`, `template-picker-i18n.dom.test.tsx`.
3. **Template translations are reviewable data.** Each `TemplateTranslation` has `review: unreviewed | clinician_reviewed {reviewer, reviewedOn}`. Only `clinician_reviewed` is ever offered or inserted; unreviewed rows fall back to English (with the EN tag). Translation applies only to untouched platform templates: org, personal and tenant-customized text is the author's own words and is shown as written. The emergency-floor template (`general.after_hours_emergency`, required phrases) has no translation: the floor cannot be verified across languages; a reviewer must add one deliberately.
4. **Spanish is provisional.** UI strings are chrome only, `data-provisional="true"` on rendered segments, and `PROVISIONAL_LOCALES` lists `es`. Template translations ship as drafts, all `unreviewed`, so none is offered until a clinician signs.
5. **No machine translation.** Nothing is translated at runtime. A per-tenant, off-by-default flag with a visible "Machine translated, check original" label is documented as the only acceptable shape and is NOT built.

## Not done (follow-ups)

Server-stored user language and `/messaging/settings/language`; reviewer workflow UI and a stored translations table (`messaging.template.translate`, needs a migration and a live RLS suite); converting the other 36-messaging `*-wording.ts` files to keys (only the saved-reply picker is converted); `<html lang>` stays `en` (per-segment lang is used instead); clinician and translator review of all Spanish text.
