/**
 * WardenX — minimal `consent_type_catalog` fixture (local dev / E2E only). NOT for production.
 *
 * `consent_type_catalog` (M39 §3.3 #1) is a platform-shared reference table (no organization_id) —
 * its own schema comment says it should be "seeded idempotently in M39-T09 / the migration §3.4",
 * but no migration or seed script ever actually did that, so a fresh `db:reset` leaves it EMPTY.
 * WX-PR-018's E2E consent workflow spec (e2e/specs/consent.spec.ts) surfaced this directly: with
 * zero rows, the capture form's type dropdown never populates, so "Create draft" stays disabled
 * forever — not a test bug, a missing-fixture-data bug.
 *
 * This seeds only 3 of the 12 canonical v1 consent types (docs/modules — full M39-T09 catalog is
 * out of scope here; getting the platform-floor policy fields for all 12 right needs the real M39
 * spec review, not a guess) — just enough for local dev and the E2E suite to exercise the real
 * create-draft write path. The `body_text_template_key`/`m22_template_version` values are
 * placeholders, not real M22 template bindings.
 *
 * Idempotent (ON CONFLICT DO NOTHING). Prereqs: none (platform-shared, no patient/org dependency).
 * Run: bun run db:seed:consent-types
 */
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

const TYPES = [
  {
    typeKey: "hipaa_release",
    displayNameEn: "HIPAA Release of Information",
    scopeDiscriminator: "per_recipient",
    defaultExpirationSeconds: 31_536_000, // 1 year
    maxTermSeconds: 63_072_000, // 2 years
    captureMethodFloor: ["typed_signature_in_app", "witnessed_verbal_documented"],
    reminderCadenceFloor: ["30_days", "1_day"],
    revocationCascadeKind: "immediate",
    isPerRecipient: true,
    isPerNamedAgent: false,
    isPostMortemEligible: false,
    requiresJurisdictionCode: false,
    cfr42Part2Compliant: false,
    hipaa164508Compliant: true,
    bodyTextTemplateKey: "hipaa_release_v1",
    m22TemplateVersion: "1.0.0",
  },
  {
    typeKey: "42_cfr_part_2_release",
    displayNameEn: "42 CFR Part 2 SUD Records Release",
    scopeDiscriminator: "per_recipient",
    defaultExpirationSeconds: 31_536_000,
    maxTermSeconds: 31_536_000,
    captureMethodFloor: ["typed_signature_in_app", "witnessed_verbal_documented", "notarized"],
    reminderCadenceFloor: ["30_days", "7_days"],
    revocationCascadeKind: "immediate",
    isPerRecipient: true,
    isPerNamedAgent: false,
    isPostMortemEligible: false,
    requiresJurisdictionCode: false,
    cfr42Part2Compliant: true,
    hipaa164508Compliant: false,
    bodyTextTemplateKey: "42_cfr_part_2_release_v1",
    m22TemplateVersion: "1.0.0",
  },
  {
    typeKey: "dpoa_healthcare",
    displayNameEn: "Durable Power of Attorney — Healthcare",
    scopeDiscriminator: "per_named_agent",
    defaultExpirationSeconds: null,
    maxTermSeconds: null,
    captureMethodFloor: ["typed_signature_in_app", "uploaded_signed_pdf", "notarized"],
    reminderCadenceFloor: ["90_days"],
    revocationCascadeKind: "immediate",
    isPerRecipient: false,
    isPerNamedAgent: true,
    isPostMortemEligible: false,
    requiresJurisdictionCode: true,
    cfr42Part2Compliant: false,
    hipaa164508Compliant: false,
    bodyTextTemplateKey: "dpoa_healthcare_v1",
    m22TemplateVersion: "1.0.0",
  },
] as const;

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is not set");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");

  let inserted = 0;
  for (const c of TYPES) {
    const res = await db.query(
      `INSERT INTO consent_type_catalog (
         type_key, display_name_en, scope_discriminator, default_expiration_seconds,
         max_term_seconds, capture_method_floor, reminder_cadence_floor, revocation_cascade_kind,
         is_per_recipient, is_per_named_agent, is_post_mortem_eligible, requires_jurisdiction_code,
         cfr_42_part_2_compliant, hipaa_164_508_compliant, body_text_template_key, m22_template_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (type_key) DO NOTHING`,
      [
        c.typeKey,
        c.displayNameEn,
        c.scopeDiscriminator,
        c.defaultExpirationSeconds,
        c.maxTermSeconds,
        c.captureMethodFloor,
        c.reminderCadenceFloor,
        c.revocationCascadeKind,
        c.isPerRecipient,
        c.isPerNamedAgent,
        c.isPostMortemEligible,
        c.requiresJurisdictionCode,
        c.cfr42Part2Compliant,
        c.hipaa164508Compliant,
        c.bodyTextTemplateKey,
        c.m22TemplateVersion,
      ],
    );
    if ((res.rowCount ?? 0) > 0) inserted++;
  }

  await db.end();
  console.log(
    `✓ consent-type seed: ${inserted} inserted, ${TYPES.length - inserted} already present.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
