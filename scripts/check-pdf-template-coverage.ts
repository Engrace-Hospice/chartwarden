#!/usr/bin/env bun
/**
 * ChartWarden - PDF template coverage gate (GAP-033), `bun run arch:pdf-templates`.
 * ---------------------------------------------------------------------------
 * The M22 renderer resolves a render request against PLATFORM_TEMPLATE_TABLE, and draws it with a bespoke builder
 * (DEFAULT_PDF_RENDERERS) or, silently, the generic payload dump. Two registries (the forms library and the
 * renderer table) had drifted, 43 of 50 templates drew through the generic dump, and a request could name a key
 * the table did not hold (M13's reconciliation worksheet dead-lettered every render).
 *
 * WHAT IT ENFORCES
 *  1. Every renderer key has a bespoke builder OR is in GENERIC_ALLOWLIST with a reason (no silent default).
 *     A reason must name a verified blocker: a placeholder ("scheduled", "wave N", TODO) or a stub fails.
 *  2. RATCHET: a GENERIC_ALLOWLIST entry that now has a builder, or names no renderer key, fails - delete it.
 *  3. Every forms-registry key is a renderer key, or in FORMS_KEY_ALIASES (target must be a renderer key), or in
 *     FORMS_ONLY_KEYS (and then must truly have no renderer key). A forms key in none of them is drift.
 *  4. Every alias / forms-only entry is live (no dead entries).
 *  5. Every template key the render-request table names statically is a renderer key.
 *
 * Add a bespoke layout: register it in render-pdf/registry.ts and delete its allow-list line. Never add a key to
 * an allow-list without a real reason; the lists exist to shrink.
 */
import { FORM_TEMPLATE_REGISTRY } from "@chartwarden/forms";
import { staticRequestTemplateKeys } from "../apps/backend/src/modules/22-documents/outbox-consumers/render-consumer";
import { DEFAULT_PDF_RENDERERS } from "../apps/backend/src/modules/22-documents/render-pdf";
import { PLATFORM_TEMPLATE_TABLE } from "../apps/backend/src/modules/22-documents/seams/renderer";
import { FORMS_KEY_ALIASES, FORMS_ONLY_KEYS, GENERIC_ALLOWLIST } from "./pdf-generic-allowlist";

/** A reason shorter than this cannot name a verified blocker ("no data", "later"). */
export const MIN_REASON_LENGTH = 40;
/** Placeholders that defer rather than explain: "scheduled", "wave N", TODO / TBD. */
const PLACEHOLDER_REASON = /\b(scheduled|todo|tbd|wave\s*\d)\b/i;

export interface CoverageInput {
  readonly rendererKeys: readonly string[];
  readonly builderKeys: readonly string[];
  readonly formsKeys: readonly string[];
  readonly requestKeys: readonly string[];
  readonly genericAllowlist: Readonly<Record<string, string>>;
  readonly aliases: Readonly<Record<string, string>>;
  readonly formsOnly: Readonly<Record<string, string>>;
}

/** Pure check; returns every violation (empty = pass). */
export function checkCoverage(input: CoverageInput): string[] {
  const out: string[] = [];
  const renderer = new Set(input.rendererKeys);
  const builders = new Set(input.builderKeys);
  const forms = new Set(input.formsKeys);

  for (const key of builders) {
    if (!renderer.has(key))
      out.push(`builder '${key}' is registered but is not a renderer template key`);
  }
  for (const key of renderer) {
    if (!builders.has(key) && input.genericAllowlist[key] === undefined) {
      out.push(
        `renderer key '${key}' has no bespoke builder and is not in GENERIC_ALLOWLIST: register a form, or allow-list it WITH a reason`,
      );
    }
  }
  for (const [key, reason] of Object.entries(input.genericAllowlist)) {
    if (reason.trim() === "") out.push(`GENERIC_ALLOWLIST '${key}' has no reason`);
    else if (PLACEHOLDER_REASON.test(reason)) {
      out.push(
        `GENERIC_ALLOWLIST '${key}' reason is a placeholder (scheduled / wave / TODO): name the verified blocker`,
      );
    } else if (reason.trim().length < MIN_REASON_LENGTH) {
      out.push(`GENERIC_ALLOWLIST '${key}' reason is too short to name a blocker`);
    }
    if (!renderer.has(key))
      out.push(`GENERIC_ALLOWLIST '${key}' is not a renderer key: delete the entry`);
    else if (builders.has(key)) {
      out.push(`GENERIC_ALLOWLIST '${key}' now has a bespoke builder: delete the entry (ratchet)`);
    }
  }
  for (const key of forms) {
    const direct = renderer.has(key);
    const aliased = input.aliases[key] !== undefined;
    const only = input.formsOnly[key] !== undefined;
    if (!direct && !aliased && !only) {
      out.push(
        `forms-registry key '${key}' resolves to no renderer key: add an alias or a forms-only entry`,
      );
    }
    if (direct && aliased)
      out.push(`alias '${key}' is redundant: the key is already a renderer key`);
    if (direct && only) out.push(`FORMS_ONLY '${key}' now has a renderer key: delete the entry`);
  }
  for (const [from, to] of Object.entries(input.aliases)) {
    if (!forms.has(from)) out.push(`alias '${from}' is not a forms-registry key: delete the entry`);
    if (!renderer.has(to)) out.push(`alias '${from}' -> '${to}': target is not a renderer key`);
  }
  for (const key of Object.keys(input.formsOnly)) {
    if (!forms.has(key))
      out.push(`FORMS_ONLY '${key}' is not a forms-registry key: delete the entry`);
  }
  for (const key of input.requestKeys) {
    if (!renderer.has(key)) {
      out.push(
        `render-request table names template '${key}' which is not a renderer key (unknown_template at runtime)`,
      );
    }
  }
  return out;
}

export function currentInput(): CoverageInput {
  return {
    rendererKeys: Object.keys(PLATFORM_TEMPLATE_TABLE),
    builderKeys: Object.keys(DEFAULT_PDF_RENDERERS),
    formsKeys: FORM_TEMPLATE_REGISTRY.map((t) => t.key),
    requestKeys: staticRequestTemplateKeys(),
    genericAllowlist: GENERIC_ALLOWLIST,
    aliases: FORMS_KEY_ALIASES,
    formsOnly: FORMS_ONLY_KEYS,
  };
}

if (import.meta.main) {
  const violations = checkCoverage(currentInput());
  if (violations.length > 0) {
    console.error("arch:pdf-templates FAILED:");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  const input = currentInput();
  console.log(
    `arch:pdf-templates OK - ${input.builderKeys.length} bespoke, ${Object.keys(GENERIC_ALLOWLIST).length} allow-listed generic, ${Object.keys(FORMS_KEY_ALIASES).length} aliases, ${Object.keys(FORMS_ONLY_KEYS).length} forms-only.`,
  );
}
