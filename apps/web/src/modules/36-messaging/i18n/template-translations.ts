// M36 WP 6.4 - translations of PLATFORM message templates, stored as reviewable data. A translation is offered
// ONLY when `review.state === "clinician_reviewed"`; an unreviewed one is never inserted into a composer, so clinical
// wording is never auto-applied. Rules:
//  - the emergency-floor template (general.after_hours_emergency, required phrases "call 911" / "on-call line") has NO
//    translation here: the floor cannot be verified across languages, so it stays English until a reviewer adds one;
//  - a template with a tenant overlay (`customized`) is the tenant's own wording, so the platform translation is skipped;
//  - no machine translation. A tenant-flagged "Machine translated, check original" mode is NOT built (ADR-0120).
// The Spanish rows below are DRAFTS: review.state "unreviewed", so nothing is offered until a clinician signs and the
// reviewer/date are filled in.
import { DEFAULT_LOCALE, type Locale } from "./catalog";

export type ReviewState =
  | { readonly state: "unreviewed" }
  | { readonly state: "clinician_reviewed"; readonly reviewer: string; readonly reviewedOn: string };

export interface TemplateTranslation {
  readonly templateKey: string;
  readonly locale: Locale;
  readonly title: string;
  readonly body: string;
  readonly review: ReviewState;
}

const draft: ReviewState = { state: "unreviewed" };

export const TEMPLATE_TRANSLATIONS: readonly TemplateTranslation[] = [
  { templateKey: "scheduling.running_late", locale: "es", review: draft, title: "Llego tarde", body: "Voy un poco retrasado y llegaré más tarde de lo previsto. Le avisaré en cuanto tenga una nueva hora de llegada." },
  { templateKey: "scheduling.reschedule_request", locale: "es", review: draft, title: "Solicitud para reprogramar", body: "¿Podemos cambiar esta visita a otro horario? Por favor responda con una hora que le convenga." },
  { templateKey: "administrative.documentation_reminder", locale: "es", review: draft, title: "Recordatorio de documentación", body: "Recordatorio: por favor complete su documentación pendiente antes del final del día." },
  { templateKey: "logistics.delivery_requested", locale: "es", review: draft, title: "Entrega de suministros solicitada", body: "Se ha solicitado la entrega de suministros. Le confirmaré cuando esté en camino." },
  { templateKey: "confirmation.received", locale: "es", review: draft, title: "Mensaje recibido", body: "Gracias, mensaje recibido. Le responderé en breve." },
];

export interface TemplateText {
  readonly title: string;
  readonly body: string;
  readonly lang: Locale;
  /** True when a non-English locale was requested but English is shown. */
  readonly fallback: boolean;
}

export interface TemplateLike {
  readonly scope: string;
  readonly templateKey: string | null;
  readonly customized: boolean;
  readonly title: string;
  readonly body: string;
}

export function pickTemplateText(
  reply: TemplateLike,
  locale: Locale,
  translations: readonly TemplateTranslation[] = TEMPLATE_TRANSLATIONS,
): TemplateText {
  // Only an untouched platform template is ours to translate. Org/personal/customized text is the author's own
  // words in an unknown language: shown as written, with no EN tag (and no lang claim beyond the page default).
  const translatable = reply.scope === "platform" && !reply.customized && reply.templateKey !== null;
  const english: TemplateText = {
    title: reply.title,
    body: reply.body,
    lang: DEFAULT_LOCALE,
    fallback: translatable && locale !== DEFAULT_LOCALE,
  };
  if (locale === DEFAULT_LOCALE || !translatable) return english;
  const hit = translations.find(
    (t) =>
      t.templateKey === reply.templateKey &&
      t.locale === locale &&
      t.review.state === "clinician_reviewed" &&
      t.title.trim() &&
      t.body.trim(),
  );
  return hit ? { title: hit.title, body: hit.body, lang: locale, fallback: false } : english;
}
