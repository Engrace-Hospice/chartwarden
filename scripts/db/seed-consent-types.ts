/**
 * ChartWarden — minimal `consent_type_catalog` fixture (local dev / E2E only). NOT for production.
 *
 * `consent_type_catalog` (M39 §3.3 #1) is a platform-shared reference table (no organization_id) —
 * its own schema comment says it should be "seeded idempotently in M39-T09 / the migration §3.4",
 * but no migration or seed script ever actually did that, so a fresh `db:reset` leaves it EMPTY.
 * WX-PR-018's E2E consent workflow spec (e2e/specs/consent.spec.ts) surfaced this directly: with
 * zero rows, the capture form's type dropdown never populates, so "Create draft" stays disabled
 * forever — not a test bug, a missing-fixture-data bug.
 *
 * F-171 (#248): grew from 3 to 5 of the 12 canonical v1 types. The other 9 are checked PER TYPE
 * against whether their own §2.4/D7 revocation-cascade consumer is a real, live-bound mechanism —
 * seeding a type whose cascade doesn't exist yet would move the blocker from "no seed row" to "seed
 * row with dead cascade behavior", which is worse (looks fixed, isn't) — never assumed from the
 * spec's prose alone. Added:
 *   - `portal_access` — D7's cascade is M2 (`buildM2ConsentRevokedConsumer`, F-142, filters exactly
 *     `typeKey==='portal_access'`, deletes the patient's own `patient_portal` sessions) + M31
 *     (`buildM31ConsentRevokedGrantCascadeConsumer`, revokes every `portal_access_grant` row whose
 *     `source_consent_record_id` matches) — both real and bound in `apps/backend/src/index.ts`.
 *   - `bereavement_outreach_consent` — D7's cascade is M16 (`buildM16ConsentRevokedConsumer`, F-151,
 *     the §2.6 per-bereaved-contact opt-out cascade) + the same M31 grant-cascade consumer above —
 *     both real and bound. This is also the type `createBereavementOutreachDraft` (M39's
 *     `grantorKind==='bereaved_person_self'` path) has required since M39-T05 with no catalog row to
 *     satisfy the `consent_record.type_key` FK — the D14 post-mortem consent flow was unreachable in
 *     every deployment until this row existed, independent of any cascade question.
 * NOT added (cascade genuinely unbuilt or unverifiable, checked against the actual consumer code
 * rather than the spec's D7 table, per this pass's own instruction to stay conservative):
 *   - `media_release` — THE PRIMARY TARGET this pass investigated. D7's cascade is M22 ("locate
 *     prior-rendered media artifacts... set `document.disclosure_restricted=true`", §4.11). No M22
 *     consumer file for `m39.consent.revoked` exists anywhere in `22-documents/` (grepped). Worse:
 *     even a from-scratch build has no non-guessed way to "locate" the target rows — `document`'s
 *     `aggregate_type`/`source_kind` enums (`packages/db/src/enums.ts`) carry no "media"/photo/video
 *     concept distinct from any other upload (a wound-care photo uploaded via
 *     `DOC.Mobile.UploadPhotoToChart` is stored the identical way), and `consent_document_link`
 *     (M39-owned) links a consent record only to ITS OWN rendered PDF (D15/§1.2), never to media
 *     released under its authority. A MIME-type heuristic (`document_version.mime_type` LIKE
 *     'image/%'/'video/%') would misclassify ordinary clinical photos as media-release content — the
 *     "guessed provider entity is a mis-stated cost report" mistake (F-102) applied to PHI photos.
 *     This is a real, deeper, unbuilt-infrastructure gap on the M22 side, not a seed gap — reported in
 *     `scripts/outbox-deferred-consumers.ts`'s m22 group, not fixed here.
 *   - `dpoa_financial` — D7's own cascade table names NO consumer for this type at all (unlike its
 *     sibling `dpoa_healthcare`, which lists M7/M11/M14/M22 acting-consent revalidation — itself also
 *     entirely unbuilt, checked: no `m39.consent.revoked` consumer exists in any of those four
 *     modules' `outbox-consumers/`, a pre-existing gap on an already-seeded type this pass does not
 *     touch). No task-relevant benefit to adding it now; left out to keep this change scoped to
 *     verified cascade mechanisms.
 *   - `family_caregiver_access` — multi-consumer (M2/M31/M16/M17/M18/M19/M36 per D7) and M2's own
 *     consumer file explicitly documents refusing this type on purpose: it is per-recipient (D6), so
 *     two different caregivers can hold two independently-valid consent records for the same patient,
 *     and M2's own table has no way to disambiguate which caregiver's session a given revocation
 *     should end — a real, reported, unresolved over-termination risk, not merely unbuilt.
 *   - `research_participation`, `telehealth_consent`, `advance_directive_acknowledgment` — each
 *     names a cascade consumer (M30/M8/M5+M7 respectively) that does not exist anywhere in the
 *     corresponding module (grepped `30-quality/`, `08-encounters/`, `05-patient/`'s privacy consumer
 *     only implements the ONE real SUD/Part-2 mapping (F-167), not an AD-on-file flag).
 *
 * The `body_text_template_key`/`m22_template_version` values remain placeholders (confirmed: neither
 * field is read anywhere in `apps/backend/src` or `packages/` outside this file and
 * `consent-store-db.ts`'s own SELECT — dead data on the wire today), not real M22 template bindings.
 *
 * Idempotent (ON CONFLICT DO NOTHING). Prereqs: none (platform-shared, no patient/org dependency).
 * Run: bun run db:seed:consent-types
 */
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

export const TYPES = [
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
  {
    // D7 cascade: M2 (`buildM2ConsentRevokedConsumer`, session terminate, filters this exact
    // typeKey) + M31 (`buildM31ConsentRevokedGrantCascadeConsumer`, grant revoke by
    // `source_consent_record_id`) — both real and bound. D8: indefinite (no platform-floor term).
    // Not in M31's "portal-issued consent flow" list of self-service-signable types by omission —
    // typically staff-captured at intake before portal access exists (chicken-and-egg), matching the
    // one capture method the repo's own `m39-consent-lifecycle.live.test.ts` fixture already uses for
    // this type. `revocationCascadeKind` is the spec's own literal (§7.3 W-CON-03 worked example).
    typeKey: "portal_access",
    displayNameEn: "Patient/Family Portal Access",
    scopeDiscriminator: "categorical",
    defaultExpirationSeconds: null,
    maxTermSeconds: null,
    captureMethodFloor: ["electronic_portal_signature"],
    reminderCadenceFloor: ["90_days"],
    revocationCascadeKind: "portal_access_revocation",
    isPerRecipient: false,
    isPerNamedAgent: false,
    isPostMortemEligible: false,
    requiresJurisdictionCode: false,
    cfr42Part2Compliant: false,
    hipaa164508Compliant: false,
    bodyTextTemplateKey: "portal_access_v1",
    m22TemplateVersion: "1.0.0",
  },
  {
    // D7 cascade: M16 (`buildM16ConsentRevokedConsumer`, F-151, §2.6 per-bereaved-contact opt-out) +
    // the same M31 grant-revoke consumer above — both real and bound. D14: captured POST-death with
    // `grantorKind='bereaved_person_self'`; `createBereavementOutreachDraft` (consent-store-db.ts)
    // requires this exact `type_key` to exist in the catalog before it will accept a draft at all —
    // this row is what makes that path reachable for the first time. D8: 13 months, aligned with
    // M16's CoP 418.64(d) bereavement window (13/12 * 365-day-year seconds, matching this file's own
    // `31_536_000`-per-year convention). Not in M31's portal-self-service capture list (D-portal-flow)
    // — captured by staff during a bereavement outreach contact, not signed by the bereaved person in
    // a portal session they don't yet have.
    typeKey: "bereavement_outreach_consent",
    displayNameEn: "Bereavement Outreach Consent",
    scopeDiscriminator: "categorical",
    defaultExpirationSeconds: 34_164_000, // 13 months
    maxTermSeconds: 34_164_000,
    captureMethodFloor: ["typed_signature_in_app", "witnessed_verbal_documented"],
    reminderCadenceFloor: ["30_days"],
    revocationCascadeKind: "bereavement_outreach_consent",
    isPerRecipient: false,
    isPerNamedAgent: false,
    isPostMortemEligible: true,
    requiresJurisdictionCode: false,
    cfr42Part2Compliant: false,
    hipaa164508Compliant: false,
    bodyTextTemplateKey: "bereavement_outreach_consent_v1",
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

// import.meta.main (Bun) — matches scripts/check-outbox-bindings.ts's own guard convention — so a
// test importing `TYPES` (F-171, #248) doesn't also run `main()` against an unset DATABASE_ADMIN_URL.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
