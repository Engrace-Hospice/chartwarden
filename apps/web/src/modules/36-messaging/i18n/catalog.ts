// M36 WP 6.4 - messaging UI strings as i18n keys. English is the source of truth and the fallback. A missing key in
// another locale NEVER renders blank: translate() returns the English text flagged `fallback`, and the UI shows it
// with lang="en" and a visible EN tag (WCAG 3.1.2). ADR-0093.
//
// SPANISH IS PROVISIONAL: these strings are chrome only (labels, status lines), written without a translator and not
// clinician-reviewed. They carry `provisional: true` until a reviewer signs off (docs/messaging-hub/brief-clinical-lead-signoff.md).
// No machine translation: nothing here or in template-translations.ts is generated at runtime.

export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
/** Locales whose strings still await human (clinician/translator) review. */
export const PROVISIONAL_LOCALES: readonly Locale[] = ["es"];

export const EN = {
  "picker.toggle": "Saved replies",
  "picker.search": "Search saved replies",
  "picker.loadFailed": "Saved replies could not be loaded.",
  "picker.loading": "Loading saved replies",
  "picker.retry": "Try again",
  "picker.noMatch": "No saved reply matches that search.",
  "picker.none": "No saved replies yet. Add some on the Saved replies page.",
  "picker.count.one": "1 saved reply",
  "picker.count.other": "{n} saved replies",
} as const;
export type MessageKey = keyof typeof EN;
export type Catalog = Partial<Record<MessageKey, string>>;

const ES: Catalog = {
  "picker.toggle": "Respuestas guardadas",
  "picker.search": "Buscar respuestas guardadas",
  "picker.loadFailed": "No se pudieron cargar las respuestas guardadas.",
  "picker.loading": "Cargando respuestas guardadas",
  "picker.retry": "Intentar de nuevo",
  "picker.noMatch": "Ninguna respuesta guardada coincide con la búsqueda.",
  "picker.none": "Aún no hay respuestas guardadas. Agregue algunas en la página de respuestas guardadas.",
  "picker.count.one": "1 respuesta guardada",
  "picker.count.other": "{n} respuestas guardadas",
};

export const CATALOGS: Readonly<Record<Locale, Catalog>> = { en: EN, es: ES };

export interface Translated {
  readonly text: string;
  /** The language of `text` - what the lang attribute must say. */
  readonly lang: Locale;
  /** True when the requested locale had no entry and English is shown instead. */
  readonly fallback: boolean;
  readonly provisional: boolean;
}

export function translate(
  locale: Locale,
  key: MessageKey,
  vars: Readonly<Record<string, string | number>> = {},
  catalogs: Readonly<Record<Locale, Catalog>> = CATALOGS,
): Translated {
  const own = catalogs[locale]?.[key];
  const hit = typeof own === "string" && own.trim().length > 0;
  const raw = hit ? own : EN[key];
  const text = raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
  return {
    text,
    lang: hit ? locale : DEFAULT_LOCALE,
    fallback: !hit && locale !== DEFAULT_LOCALE,
    provisional: hit && PROVISIONAL_LOCALES.includes(locale),
  };
}

/** Preference first, then the browser's ordered languages; the first supported primary subtag wins, else English. */
export function resolveLocale(
  preference: string | null | undefined,
  browserLanguages: readonly string[] = [],
): Locale {
  for (const tag of [preference, ...browserLanguages]) {
    const primary = tag?.toLowerCase().split("-")[0];
    const found = LOCALES.find((l) => l === primary);
    if (found) return found;
  }
  return DEFAULT_LOCALE;
}
