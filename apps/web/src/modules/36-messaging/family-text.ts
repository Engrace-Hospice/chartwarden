// M36 WP 6.7 (ADR-0099 D11) - the `family.*` catalogue strings as plain text. The locale is the existing one (saved preference, then the browser); no
// family-specific locale logic. The catalogue holds English only for these keys, so every locale renders the English source (the catalogue's fallback).
import { type MessageKey, translate } from "./i18n/catalog";
import { currentLocale } from "./i18n/use-messaging-locale";

export type FamilyKey = Extract<MessageKey, `family.${string}`>;

export function ft(key: FamilyKey, vars: Readonly<Record<string, string | number>> = {}): string {
  return translate(currentLocale(), key, vars).text;
}
