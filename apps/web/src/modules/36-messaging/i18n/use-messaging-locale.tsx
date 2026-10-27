// M36 WP 6.4 - locale for the messaging surface (user preference, then browser) and a <Txt> that never hides a fallback.
import type { JSX } from "react";
import { type Locale, type MessageKey, resolveLocale, translate } from "./catalog";

export const LOCALE_PREFERENCE_KEY = "cw.messaging.locale";

/** Saved preference (if storage is readable), else the browser's languages, else English. */
export function currentLocale(): Locale {
  let preference: string | null = null;
  try {
    preference = window.localStorage.getItem(LOCALE_PREFERENCE_KEY);
  } catch {
    preference = null; // storage blocked: fall through to the browser language
  }
  return resolveLocale(
    preference,
    typeof navigator === "undefined" ? [] : (navigator.languages ?? []),
  );
}

export function EnTag(): JSX.Element {
  return (
    <abbr className="wx-en-tag" title="Not yet translated; shown in English" lang="en">
      {" "}
      EN
    </abbr>
  );
}

export interface TxtProps {
  readonly k: MessageKey;
  readonly vars?: Readonly<Record<string, string | number>>;
  readonly locale: Locale;
}

/** A string in its own language segment; an English fallback carries lang="en" and a visible EN tag. */
export function Txt({ k, vars, locale }: TxtProps): JSX.Element {
  const t = translate(locale, k, vars);
  return (
    <span lang={t.lang} data-provisional={t.provisional ? "true" : undefined}>
      {t.text}
      {t.fallback ? <EnTag /> : null}
    </span>
  );
}
