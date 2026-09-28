// apps/backend/src/modules/23-billing-medicare/services/boot-assembly.ts — the boot-time CLAIM-ASSEMBLY
// service the composition root binds into `mountM23Routes` (route #1 `POST /claims/assemble`).
//
// STATUS (#250/#251, corrected from this file's earlier "6 seam areas, all pending a M1 SeamRegistry
// addition" framing — that framing was itself stale: five of the six ARE in `SeamContracts` and have been
// since their own modules' -T05/-T08 tasks landed; the real blocker per seam is checked below, one at a
// time).
//
// EIGHT of the eleven named `ClaimAssemblySeams` reader PORTS (the #250 issue's own count: patientPayer/
// admission/electionPeriods/certifications/faceToFace/levelOfCare/billableEncounters/signedEncounters/
// evvCompliance/mdm/terminology — `referenceData` is platform reference data, not one of the eleven) are
// now bound to REAL data (`claim-assembly-seam-adapters.ts`): `patientPayer` (M5), all FIVE M6
// range-shaped seams (F-121, #251: `admission`, `electionPeriods`, `certifications`, `faceToFace`,
// `levelOfCare`, over `claimAssemblyRangeContextForOrg`), and — F-122 (#251) —
// `billableEncounters`/`signedEncounters` (M8, over `billableEncountersInRangeForOrg`/
// `signedEncounterSnapshotsInRangeForOrg`). `mdm` is PARTIALLY bound (`resolveProviderEntity` yes,
// `resolveClinicalParticipants` no — see below), so it counts toward neither the bound nor the fully-stub
// tally cleanly. Two of `referenceData`'s four methods are also real (`wageIndexForCcn`,
// `activeSequestrationPolicy`, #250). Each is individually live-tested against real rows under RLS
// (`m23-claim-assembly-seams.live.test.ts`). Binding all eight is NOT "the route works end to end" — see
// NET EFFECT ON REACHABILITY below.
//
// EVERY OTHER READER STAYS A DENY-STUB, and per-seam, not as one blanket "not ready yet" — each reason
// below was checked against the owning module's actual published seam shape, not assumed from this file's
// prior header:
//   * evvCompliance (M18) — the published `EvvComplianceReader` answers one visit's bracket state or a
//     windowed AGGREGATE rate, not "bracket snapshots for this LIST of encounter ids" — and depends on
//     `billableEncounters` resolving the id list first regardless.
//   * terminology (M38) — the published `TerminologyProvider` (the M25 CARC/RARC precedent this file
//     used to cite as proof this is "a small adapter") is a per-CODE `lookup(system, code)`. M23's
//     `TerminologyResolution` wants a BULK pre-resolved `valueSetMembership`/`icd10Billable` map, with
//     no codes given at fetch time — bridging needs either a bulk M38 method or enumerating every
//     value-set/ICD code the §11.A rule registry actually references, a real design task, not a wrapper.
//   * mdm.resolveClinicalParticipants (M40) — physician/POS linking is genuinely unbuilt (confirmed:
//     M27's own attempt at this cast silently degrades to null via try/catch today).
//   * referenceData.hippsRateTable / .chcHourlyRateCents — `packages/billing/src/hipps/calculator.ts`'s
//     own `HippsRateTable` doc carries an explicit `TODO(CMS-fixture)`: no CMS per-diem rate file has
//     ever been loaded anywhere in this repository, and no table exists to load one into. Genuine new
//     infrastructure, confirmed by absence of any backing table (unlike `wageIndexForCcn`'s table, which
//     exists and is simply unloaded).
//
// NET EFFECT ON REACHABILITY, stated precisely rather than implied: `assemble()`'s call order is
// patientPayer → admission → electionPeriods → certifications/faceToFace/levelOfCare → mdm.
// resolveProviderEntity → referenceData.wageIndexForCcn → referenceData.hippsRateTable →
// referenceData.activeSequestrationPolicy → billableEncounters → evvCompliance → mdm.
// resolveClinicalParticipants → terminology → ... — binding `patientPayer` (#250) moved the boundary from
// the FIRST read to the SECOND; binding all five M6 seams (#251, F-121) moves it PAST the M6 block
// entirely, to the FIRST of the remaining stubs the call order actually reaches: `referenceData.
// hippsRateTable` (`WAGE_INDEX_UNAVAILABLE`/422 fires first when no wage-index factor is loaded for the
// CCN, so `hippsRateTable`'s `SEAM_UNBOUND`/503 is the live wall only once a factor resolves — both #250
// and this pass's own live test exercise wage-index rows the migration 0080 seed covers). Binding
// `billableEncounters`/`signedEncounters` (F-122, #251) does NOT move that wall at all — both sit LATER
// in the call order than `hippsRateTable`/`activeSequestrationPolicy`, so they stay unreachable by a real
// request until the CMS rate-table gap closes. This is real, individually-verified progress on two more
// seam steps, not a further unblock of the live boundary — stated precisely rather than implied, the exact
// discipline the #250/#251 issues themselves established. `POST /claims/assemble` remains unreachable
// end-to-end for every real caller today.
//
// Per RULE 4 (fail-closed-unbound), every method that stays a stub still throws the typed `SEAM_UNBOUND`
// (503) only when an assemble request actually reaches it — boot stays green, and the route never
// silently fabricates a claim from absent clinical facts.
import { createDefaultBillingRegistry, type repositories } from "@wardenx/billing";
import { WardenXError } from "@wardenx/types";

import type { ProviderCcnPort } from "../routes/write-service";
import { buildM23CapProjectionAdapter } from "./cap-projection-adapter";
import {
  type AssemblyOutboxPort,
  type ClaimAssemblySeams,
  type ClaimAssemblyService,
  buildClaimAssemblyService,
} from "./claim-assembly";
import {
  type M6ClaimRangeReader,
  type M8BillableEncountersReader,
  type M8SignedEncountersReader,
  buildM23AdmissionRangeAdapters,
  buildM23BillableEncountersAdapter,
  buildM23MdmProviderEntityAdapter,
  buildM23PatientPayerAdapter,
  buildM23ReferenceDataAdapter,
  buildM23SignedEncountersAdapter,
} from "./claim-assembly-seam-adapters";

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
 * Build the boot-time claim-assembly service over the RLS-enforced primary `db`. Four reader methods are
 * bound to real data (this file's header); every other cross-module reader seam is a fail-closed deny-stub
 * (throws `SEAM_UNBOUND` at call time). The rule registry is the real frozen platform-default registry. The
 * optional `outbox` threads the catalog-validating tx publisher through for when the remaining seams bind
 * (the still-unbound M6 readers throw before the emit is reached today).
 */
export function buildM23BootAssemblyService(
  db: BillingDb,
  ports: {
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
  } = {},
): ClaimAssemblyService {
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

  const seams: ClaimAssemblySeams = {
    // REAL (#250) — see this file's header for the exact per-seam accounting.
    patientPayer: buildM23PatientPayerAdapter(),
    admission: m6Range?.admission ?? { resolveForRange: () => unbound("AdmissionContextReader") },
    electionPeriods: m6Range?.electionPeriods ?? {
      coveringRange: () => unbound("ElectionPeriodReader"),
    },
    certifications: m6Range?.certifications ?? { forPatient: () => unbound("CertificationReader") },
    faceToFace: m6Range?.faceToFace ?? { forPatient: () => unbound("FaceToFaceReader") },
    levelOfCare: m6Range?.levelOfCare ?? { periodsInRange: () => unbound("LevelOfCareReader") },
    // REAL (#251, F-122) — over M8's two new range-shaped seam functions, when injected.
    billableEncounters: ports.m8BillableEncounters
      ? buildM23BillableEncountersAdapter(ports.m8BillableEncounters)
      : { forRange: () => unbound("BillableEncounterReader") },
    signedEncounters: ports.m8SignedEncounters
      ? buildM23SignedEncountersAdapter(ports.m8SignedEncounters)
      : { inWindow: () => unbound("SignedEncountersReader") },
    evvCompliance: { bracketsForEncounters: () => unbound("EvvComplianceReader") },
    mdm: {
      // REAL (#250) — CCN + MAC jurisdiction; cbsaCode is an honest `null` (unread field, see the adapter's
      // own doc comment).
      resolveProviderEntity: mdmAdapter.resolveProviderEntity,
      resolveClinicalParticipants: () => unbound("MdmEntityProvider"),
    },
    terminology: { resolveForClaim: () => unbound("TerminologyProvider") },
    // M26 §11.A cap projection — LIVE: resolves M26's `CapProjectionProvider` via getSeam at call time and
    // degrades to status:"unavailable" when M26 is db-unbound (D8). Unlike the other boot seams it does NOT
    // throw — the cap rules warn-skip while degraded, never block.
    capProjection: buildM23CapProjectionAdapter(),
    // REAL for wageIndexForCcn / activeSequestrationPolicy (#250); hippsRateTable / chcHourlyRateCents stay
    // unbound — see this file's header for why the four are not one bundle.
    referenceData: buildM23ReferenceDataAdapter(
      db,
      () => unbound("BillingReferenceDataReader"),
      () => unbound("BillingReferenceDataReader"),
    ),
    ruleRegistry: createDefaultBillingRegistry(),
    outbox,
  };

  return buildClaimAssemblyService(db, seams);
}
