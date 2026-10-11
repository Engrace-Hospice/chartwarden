import { createDefaultBillingRegistry, type repositories } from "@wardenx/billing";
import { WardenXError } from "@wardenx/types";
// apps/backend/src/modules/23-billing-medicare/services/boot-assembly.ts — the boot-time CLAIM-ASSEMBLY
// service the composition root binds into `mountM23Routes` (route #1 `POST /claims/assemble`).
//
// STATUS (#250/#251, corrected from this file's earlier "6 seam areas, all pending a M1 SeamRegistry
// addition" framing — that framing was itself stale: five of the six ARE in `SeamContracts` and have been
// since their own modules' -T05/-T08 tasks landed; the real blocker per seam is checked below, one at a
// time).
//
// TEN of the eleven named `ClaimAssemblySeams` reader PORTS (the #250 issue's own count: patientPayer/
// admission/electionPeriods/certifications/faceToFace/levelOfCare/billableEncounters/signedEncounters/
// evvCompliance/mdm/terminology — `referenceData` is platform reference data, not one of the eleven) are
// now bound to REAL data (`claim-assembly-seam-adapters.ts`): `patientPayer` (M5), all FIVE M6
// range-shaped seams (F-121, #251: `admission`, `electionPeriods`, `certifications`, `faceToFace`,
// `levelOfCare`, over `claimAssemblyRangeContextForOrg`), `billableEncounters`/`signedEncounters` (F-122,
// #251: M8, over `billableEncountersInRangeForOrg`/`signedEncounterSnapshotsInRangeForOrg`), `evvCompliance`
// (F-123, #251: bridging M8's `encounterVisitIdsForOrg` and M18's new bulk `complianceStatesForVisitsForOrg`),
// and `terminology` (F-124, #251: over M38's registered `TerminologyProvider.expand()`). `mdm` is
// PARTIALLY bound — `resolveProviderEntity` (#250) and, as of F-127 (#251), the physician-IDENTITY half of
// `resolveClinicalParticipants`; `placeOfService` is bound only partially (F-213, see below) — so it counts toward neither
// the bound nor the fully-stub tally cleanly. All four of `referenceData`'s methods are also real:
// `wageIndexForCcn`, `activeSequestrationPolicy` (#250) and — F-210 — the TENANT-ENTERED `perDiemRateTable`/
// `chcHourlyRateCents` over the M23-owned `hospice_rate_table` (see the "RATE TABLE" note below).
// Each is individually live-tested against real rows
// under RLS (`m23-claim-assembly-seams.live.test.ts`). Binding all this is NOT "the route works end to end"
// — see NET EFFECT ON REACHABILITY below.
//
// EVERY OTHER READER STAYS A DENY-STUB, and per-seam, not as one blanket "not ready yet" — each reason
// below was checked against the owning module's actual published seam shape, not assumed from this file's
// prior header:
//     (referenceData.perDiemRateTable / .chcHourlyRateCents were the last two stubs here — see RATE TABLE.)
//
// RATE TABLE (F-210): the CMS per-diem rates are TENANT-ENTERED (no bundled CMS file). A billing administrator
// keys each fiscal year's national base per-diems per provider entity via `POST /api/v1/billing/rate-tables`
// (permission `billing.rate_table.admin`), into the M23-owned, effective-dated, append-only `hospice_rate_table`;
// `buildM23ReferenceDataAdapter` reads the version covering the claim's service-from date and throws the typed
// `RATE_TABLE_MISSING` (422) when none does. This removed the `SEAM_UNBOUND` wall at `perDiemRateTable` — it is NOT
// "the route works": see NET EFFECT ON REACHABILITY for what still stops `POST /claims/assemble`.
//
// `mdm.resolveClinicalParticipants` (M40) was recorded as ONE "genuinely unbuilt" verdict (#250/#251);
// checked precisely rather than left at that (F-127, #251), it splits into two independent facts with
// opposite answers. Physician IDENTITY is real: `admission.hospice_physician_id` and a SIGNED
// `election_statement.attending_physician_id` are both M40 physician ids the M6 range read now carries
// (extended alongside the F-121 shapes — no new port), resolved through M40's already-registered
// `MdmEntityProvider.resolvePhysician`. `licenseUnexpiredOnServiceDates` is honestly `false` always — M40
// tracks which STATES a physician is licensed in, never a per-state EXPIRY DATE, so there is nothing to
// confirm (`physician-credentials.ts`'s defect message was rewordered, F-126, so it never asserts a
// confirmed expiry this seam cannot back up). `placeOfService` is REAL as of F-213 (#252)
// (F-127's "no producer exists" was corrected): M5's effective-dated address history + M40 `facility.kind`
// (migration 0183) via injected ports (`ports.placeOfService`). It maps home + the seven facility kinds with an
// unambiguous CMS Q-code and returns null (line falls to Q5009) for clinic/other, GIP/IRC claims (the site is
// the LOC facility, not the residence), or a range that spans a move — see `place-of-service-resolver.ts`.
//
// Binding the physician-identity half surfaced an independent, real Q-code defect (F-125, #251):
// `qCodeForPlaceOfService` (below) and `@wardenx/billing`'s own `place_of_service_consistency` rule had
// each carried an independently-authored CMS Q5001-Q5010 mapping, and three of nine places disagreed
// between them (`snf`, `ipu`, `hospital` each resolved to a DIFFERENT Q-code depending which side asked),
// while an unrecognized place silently defaulted to Q5006 ("inpatient hospice facility") under a doc
// comment that called it "unspecified" — CMS's real catch-all is Q5009 ("place N.O.S."). Fixed by making
// `@wardenx/billing`'s `POS_BY_QCODE` the one authoritative table and deriving this file's Q-code lookup
// from it (inverted), so the two cannot disagree again; the unknown-place default is now the honest Q5009.
//
// `terminology` (M38) was investigated (#250/#251) as needing a BULK method M38 did not publish — false,
// checked against `TerminologyProvider`'s actual interface rather than assumed from the per-code `lookup`
// M25's CARC/RARC precedent uses: `expand(valueSetId)` (§4.5) already IS the bulk method, unused by any
// consumer until now. See `claim-assembly-seam-adapters.ts`'s own doc comment (F-124, #251) for the full
// accounting, including a genuine second gap that binding it surfaced: the ONE value set M23's rule
// registry references (`CMS_HOSPICE_MODIFIER_VALUE_SET`) did not exist as real curated data anywhere
// before this pass either — fixed alongside the bind, not deferred, because two CMS-defined modifier codes
// is exactly the size of reference data this platform already hand-curates (`level_of_care`,
// `place_of_service_q_codes`), not the "no table exists" scale of the CMS rate-table gap below.
//
// NET EFFECT ON REACHABILITY, stated precisely rather than implied: `assemble()`'s call order is
// patientPayer → admission → electionPeriods → certifications/faceToFace/levelOfCare → mdm.
// resolveProviderEntity → referenceData.wageIndexForCcn → referenceData.perDiemRateTable →
// referenceData.activeSequestrationPolicy → billableEncounters → evvCompliance → mdm.
// resolveClinicalParticipants → terminology → ... — binding `patientPayer` (#250) moved the boundary from
// the FIRST read to the SECOND; binding all five M6 seams (#251, F-121) moves it PAST the M6 block
// entirely, to the FIRST of the remaining stubs the call order actually reaches: `referenceData.
// perDiemRateTable` (`WAGE_INDEX_UNAVAILABLE`/422 fires first when no wage-index factor is loaded for the
// CCN, so `perDiemRateTable`'s `SEAM_UNBOUND`/503 is the live wall only once a factor resolves — both #250
// and this pass's own live test exercise wage-index rows the migration 0080 seed covers). Binding
// `billableEncounters`/`signedEncounters`/`evvCompliance`/`terminology`/the physician-identity half of
// `mdm.resolveClinicalParticipants` (F-122/F-123/F-124/F-127, #251) does NOT move that wall at all — all
// sit LATER in the call order than `perDiemRateTable`/`activeSequestrationPolicy`, so they stay unreachable
// by a real request until the CMS rate-table gap closes. This is real, individually-verified progress on
// five more seam steps, not a further unblock of the live boundary — stated precisely rather than implied,
// the exact discipline the #250/#251 issues themselves established.
//
// F-210 UPDATE — the rate-table gap is closed by CODE + TENANT DATA (not by a bundled CMS file): the
// `SEAM_UNBOUND` wall at `perDiemRateTable` is gone, and a tenant that has keyed its rate table reaches every seam
// step above. What can STILL stop `POST /claims/assemble` is now DATA, each with a typed, actionable 4xx (none is
// `SEAM_UNBOUND`): `WAGE_INDEX_UNAVAILABLE` (`wage_index_factor` is platform-shared and has NO loader — only the
// five non-authoritative migration-0080 placeholder CCNs exist, FY starting 2026), `RATE_TABLE_MISSING` (the tenant
// has not entered rates for the service date), `SEQUESTRATION_POLICY_UNAVAILABLE` (no active policy row for the
// provider entity), plus the clinical preconditions the earlier seams enforce. `placeOfService` is NOT a wall:
// the adapter returns `null` and the line Q-code falls back to Q5009 ("place N.O.S.") — an honest but imprecise
// value until a site-of-care producer exists. A real end-to-end assembly has not been exercised against a real
// provider entity CCN in any environment.
//
// Per RULE 4 (fail-closed-unbound), every method that stays a stub still throws the typed `SEAM_UNBOUND`
// (503) only when an assemble request actually reaches it — boot stays green, and the route never
// silently fabricates a claim from absent clinical facts.
import { type ClaimZipPorts, buildHospiceCbsaReader } from "./claim-cbsa";

import type { ProviderCcnPort } from "../routes/write-service";
import { buildM23CapProjectionAdapter } from "./cap-projection-adapter";
import {
  type AssemblyOutboxPort,
  type ClaimAssemblySeams,
  type ClaimAssemblyService,
  type DiagnosisSequenceReader,
  buildClaimAssemblyService,
} from "./claim-assembly";
import {
  type M6ClaimRangeReader,
  type M7ClaimDiagnosesReader,
  type M8BillableEncountersReader,
  type M8EncounterVisitIdsReader,
  type M8SignedEncountersReader,
  type M18ComplianceStatesReader,
  buildM23AdmissionRangeAdapters,
  buildM23BillableEncountersAdapter,
  buildM23ClinicalParticipantsAdapter,
  buildM23DiagnosesAdapter,
  buildM23EvvComplianceAdapter,
  buildM23MdmProviderEntityAdapter,
  buildM23PatientPayerAdapter,
  buildM23ReferenceDataAdapter,
  buildM23SignedEncountersAdapter,
  buildM23TerminologyAdapter,
} from "./claim-assembly-seam-adapters";
import type { ElectionAddendumComplianceReader } from "./claim-assembly-types";
import type { PlaceOfServicePorts } from "./place-of-service-resolver";

type BillingDb = repositories.BillingDb;

/** Throw the typed fail-closed error every still-unbound assembly reader raises at call time (RULE 4). */
function unbound(seam: string): never {
  throw new WardenXError(
    "SEAM_UNBOUND",
    `M23 claim-assembly seam '${seam}' is not bound at boot — see boot-assembly.ts's header for the exact, per-seam reason (a real new read-surface addition needed in the owning module, or genuinely absent CMS reference data)`,
    503,
  );
}

/**
 * F-209 (#251) — the `diagnoses` seam: the real M7-backed adapter when the composition root injects the
 * port, otherwise a fail-closed `SEAM_UNBOUND` stub. Exported so the port-absent behaviour is unit-testable
 * (the call sits behind `referenceData.perDiemRateTable`, which the end-to-end path cannot yet pass).
 */
export function buildM23BootDiagnosesSeam(port?: M7ClaimDiagnosesReader): DiagnosisSequenceReader {
  return port
    ? buildM23DiagnosesAdapter(port)
    : { forRange: () => unbound("DiagnosisSequenceReader") };
}

/** The injected reader ports the boot assembly binds over (every absent port stays a fail-closed deny-stub). */
export interface M23BootAssemblyPorts {
  readonly outbox?: AssemblyOutboxPort;
  readonly providerCcn?: ProviderCcnPort;
  /** F-121 (#251) — M6's `claimAssemblyRangeContextForOrg`, injected by the composition root. Absent
   *  (e.g. in a unit test that only exercises the earlier `patientPayer` gate), the five M6 seams stay
   *  the fail-closed `unbound()` deny-stubs below. */
  readonly m6ClaimRange?: M6ClaimRangeReader;
  /** F-122 (#251) — M8's two new range-shaped seam functions, injected by the composition root. Absent,
   *  `billableEncounters`/`signedEncounters` stay their fail-closed `unbound()` deny-stubs below. */
  readonly m8BillableEncounters?: M8BillableEncountersReader;
  readonly m8SignedEncounters?: M8SignedEncountersReader;
  /** F-123 (#251) — the M8 encounter→visit bridge + M18's bulk compliance read, injected by the
   *  composition root. Absent, `evvCompliance` stays its fail-closed `unbound()` deny-stub below. */
  readonly m8EncounterVisitIds?: M8EncounterVisitIdsReader;
  readonly m18Compliance?: M18ComplianceStatesReader;
  /** F-209 (#251) — M7's `claimDiagnosesForOrg`, injected by the composition root. Absent, `diagnoses`
   *  stays its fail-closed `unbound()` deny-stub below (an unbound sequence must never read as "no
   *  diagnoses" — that would silently fail `icd10_sequencing` on real data). */
  readonly m7ClaimDiagnoses?: M7ClaimDiagnosesReader;
  /** F-213 (#252) — the M5 residence-range + M40 facility-kind ports behind
   *  `mdm.resolveClinicalParticipants().placeOfService`. Absent, `placeOfService` stays `null`
   *  (line Q-code falls to Q5009 honestly). */
  readonly placeOfService?: PlaceOfServicePorts;
  /** FY2027 — M6's `electionAddendumComplianceForOrg` (42 CFR 418.24(c)). Absent, the
   *  `election_addendum_signed` rule SKIPs `seam_not_bound`. */
  readonly m6ElectionAddendum?: ElectionAddendumComplianceReader;
  /** The patient / facility ZIPs behind the wage-index value codes 61 / G8 (M5 residence + M40 facility). Absent,
   *  the claim carries no value codes and the `cbsa_value_codes_present` rule SKIPs. */
  readonly claimZips?: ClaimZipPorts;
}

/**
 * Build the boot-time claim-assembly service over the RLS-enforced primary `db`. Four reader methods are
 * bound to real data (this file's header); every other cross-module reader seam is a fail-closed deny-stub
 * (throws `SEAM_UNBOUND` at call time). The rule registry is the real frozen platform-default registry. The
 * optional `outbox` threads the catalog-validating tx publisher through for when the remaining seams bind
 * (the still-unbound M6 readers throw before the emit is reached today).
 */
export function buildM23BootAssemblySeams(
  db: BillingDb,
  ports: M23BootAssemblyPorts = {},
): ClaimAssemblySeams {
  const outbox: AssemblyOutboxPort = ports.outbox ?? {
    async publish() {
      unbound("AssemblyOutboxPort");
    },
  };
  // Same deny-stub default the M23 write-service's own `providerCcn` port carries — `provider_entity`
  // is M1-owned (arch:tables refuses this module reading its schema directly), so the composition root
  // binds the SAME port instance already wired for the write-service's control-number derivation.
  const providerCcn: ProviderCcnPort = ports.providerCcn ?? {
    async ccnForProviderEntity() {
      return unbound("ProviderCcnPort");
    },
  };

  const mdmAdapter = buildM23MdmProviderEntityAdapter(db, providerCcn);
  // REAL (#251) — the five M6 range-shaped seams, when the composition root injects the reader; absent,
  // each stays its own fail-closed `unbound()` stub (RULE 4).
  const m6Range = ports.m6ClaimRange ? buildM23AdmissionRangeAdapters(ports.m6ClaimRange) : null;

  return {
    // REAL (#250) — see this file's header for the exact per-seam accounting.
    patientPayer: buildM23PatientPayerAdapter(),
    admission: m6Range?.admission ?? { resolveForRange: () => unbound("AdmissionContextReader") },
    electionPeriods: m6Range?.electionPeriods ?? {
      coveringRange: () => unbound("ElectionPeriodReader"),
    },
    certifications: m6Range?.certifications ?? { forPatient: () => unbound("CertificationReader") },
    faceToFace: m6Range?.faceToFace ?? { forPatient: () => unbound("FaceToFaceReader") },
    levelOfCare: m6Range?.levelOfCare ?? { periodsInRange: () => unbound("LevelOfCareReader") },
    // REAL (#251, F-209) — the claim's diagnosis sequence over M7's org-explicit seam function, when injected.
    diagnoses: buildM23BootDiagnosesSeam(ports.m7ClaimDiagnoses),
    // REAL (#251, F-122) — over M8's two new range-shaped seam functions, when injected.
    billableEncounters: ports.m8BillableEncounters
      ? buildM23BillableEncountersAdapter(ports.m8BillableEncounters)
      : { forRange: () => unbound("BillableEncounterReader") },
    signedEncounters: ports.m8SignedEncounters
      ? buildM23SignedEncountersAdapter(ports.m8SignedEncounters)
      : { inWindow: () => unbound("SignedEncountersReader") },
    // REAL (#251, F-123) — bridges M8's encounter→visit link and M18's bulk compliance read, when both
    // ports are injected.
    evvCompliance:
      ports.m8EncounterVisitIds && ports.m18Compliance
        ? buildM23EvvComplianceAdapter(ports.m8EncounterVisitIds, ports.m18Compliance)
        : { bracketsForEncounters: () => unbound("EvvComplianceReader") },
    mdm: {
      // REAL (#250) — CCN + MAC jurisdiction; cbsaCode is an honest `null` (unread field, see the adapter's
      // own doc comment).
      resolveProviderEntity: mdmAdapter.resolveProviderEntity,
      // PARTIALLY REAL (#251, F-127) — physician identity/NPPES-status over the SAME injected `m6ClaimRange`
      // port (extended, no new port) + M40's registered `MdmEntityProvider`; `placeOfService` via the injected
      // F-213 ports (null when unresolvable — `place-of-service-resolver.ts`).
      resolveClinicalParticipants: ports.m6ClaimRange
        ? buildM23ClinicalParticipantsAdapter(ports.m6ClaimRange, undefined, ports.placeOfService)
            .resolveClinicalParticipants
        : () => unbound("MdmEntityProvider"),
    },
    // REAL (#251, F-124) — over the registered M38 `TerminologyProvider` seam's bulk `expand()`; needs no
    // injected port (M38 is already an M1-registry seam, the `patientPayer` shape, not the M6/M8/M18 one).
    terminology: buildM23TerminologyAdapter(),
    // M26 §11.A cap projection — LIVE: resolves M26's `CapProjectionProvider` via getSeam at call time and
    // degrades to status:"unavailable" when M26 is db-unbound (D8). Unlike the other boot seams it does NOT
    // throw — the cap rules warn-skip while degraded, never block.
    capProjection: buildM23CapProjectionAdapter(),
    // REAL for all four methods: wageIndexForCcn / activeSequestrationPolicy (#250) and, as of F-210, the
    // TENANT-ENTERED perDiemRateTable / chcHourlyRateCents (M23-owned `hospice_rate_table`, read org-explicitly
    // over `db` — no injected port; `RATE_TABLE_MISSING`/422 when no table covers the service date).
    referenceData: buildM23ReferenceDataAdapter(db),
    ...(ports.m6ElectionAddendum ? { electionAddendum: ports.m6ElectionAddendum } : {}),
    ...(ports.claimZips ? { cbsa: buildHospiceCbsaReader(db, ports.claimZips) } : {}),
    ruleRegistry: createDefaultBillingRegistry(),
    outbox,
  };
}

/** Build the boot-time claim-assembly service (the route's `POST /claims/assemble`) over those seams. */
export function buildM23BootAssemblyService(
  db: BillingDb,
  ports: M23BootAssemblyPorts = {},
): ClaimAssemblyService {
  return buildClaimAssemblyService(db, buildM23BootAssemblySeams(db, ports));
}
