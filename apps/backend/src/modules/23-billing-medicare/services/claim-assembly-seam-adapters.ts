// apps/backend/src/modules/23-billing-medicare/services/claim-assembly-seam-adapters.ts — the
// `ClaimAssemblySeams` bindings that are genuinely real "wire an existing (or newly-added) reader" work
// (#250, #251), checked one at a time rather than assumed from `boot-assembly.ts`'s header. Every other
// declared-unbound seam in that file was investigated and found to need real new read-surface work in its
// OWNING module (a range-shaped or bulk-shaped query the module's published seam does not offer today) —
// see `boot-assembly.ts`'s header for the per-seam accounting. FOUR of these (#250) have no such gap: the
// fact either already lives on an M1-registry seam whose shape matches exactly, or on a table this module
// (or a sibling M23 table) already owns and already has a repository for. The FIVE M6 seams below (F-121,
// #251) needed exactly that owning-module read-surface addition — `claimAssemblyRangeContextForOrg`
// (`06-admission/seams/drizzle-store.ts`) — and this file is the adapter over it, not the read itself.
import { CMS_HOSPICE_MODIFIER_VALUE_SET, repositories } from "@wardenx/billing";
import type { LevelOfCare, NpiStatus, PhysicianResolution } from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import { getSeam } from "../../../bootstrap/index";
import type { ProviderCcnPort } from "../routes/write-service";
import type {
  AdmissionContextReader,
  BillableEncounterReader,
  BillingReferenceDataReader,
  CertificationReader,
  DateRange,
  ElectionPeriodReader,
  EvvComplianceReader,
  FaceToFaceReader,
  LevelOfCareReader,
  MdmEntityProvider,
  MedicarePrimaryResolution,
  PatientPayerReader,
  ProviderEntityDirectoryEntry,
  SignedEncountersReader,
  TerminologyProvider,
} from "./claim-assembly";

type BillingDb = repositories.BillingDb;

/**
 * The minimal M5 `PatientCoverageReader` surface this adapter consumes. M5 is NOT in M23's manifest
 * `dependsOn` ([1, 6, 8, 22, 38, 40]) — importing its typed `getPatientCoverageReader()` getter directly
 * would be a real compile edge `arch:boundaries` refuses, so this resolves through the untyped M1-registry
 * `getSeam` + a local cast, the exact `cap-projection-adapter.ts` (M26) no-edge pattern (ADR-0005).
 */
interface M5CoverageSeam {
  activeCoverageOfKind(input: {
    organizationId: string;
    patientId: string;
    coverageKind: string;
    onDate: string;
  }): Promise<{ id: string; rank: number; coverageKind: string } | null>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 1. patientPayer (M5) — real, over the registered PatientCoverageReader seam.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * M23's Medicare-primary gate (D15) needs "is Medicare FFS primary across the WHOLE window", while the M5
 * seam only answers "is a coverage of this kind in force ON one date" (`activeCoverageOfKind`). Checked
 * at BOTH range endpoints against the SAME coverage row (by `id`) rather than either endpoint alone: a
 * coverage that is medicare_ffs + rank 1 at `range.from` but has been superseded (a different row, a new
 * COB rank) by `range.to` is correctly NOT primary for the whole window. This does not see a rank change
 * strictly INSIDE the interior of the range — a real, stated limitation, not a silent one: M5 publishes no
 * range-shaped coverage query today, and adding one is exactly the kind of owning-module work the other
 * deferred seams below need too.
 */
export function buildM23PatientPayerAdapter(
  resolve: () => M5CoverageSeam = () => getSeam("PatientCoverageReader") as M5CoverageSeam,
): PatientPayerReader {
  return {
    async medicarePrimaryForRange(orgId, patientId, range) {
      const reader = resolve();
      const [atStart, atEnd] = await Promise.all([
        reader.activeCoverageOfKind({
          organizationId: orgId,
          patientId,
          coverageKind: "medicare_ffs",
          onDate: range.from,
        }),
        reader.activeCoverageOfKind({
          organizationId: orgId,
          patientId,
          coverageKind: "medicare_ffs",
          onDate: range.to,
        }),
      ]);
      if (!atStart || !atEnd || atStart.id !== atEnd.id) return null;
      const resolution: MedicarePrimaryResolution = {
        patientPayerId: atStart.id,
        medicarePrimary: atStart.rank === 1,
      };
      return resolution;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 2. mdm.resolveProviderEntity (M40 — CCN + MAC jurisdiction) — real, direct reads.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `ProviderEntityDirectoryEntry` needs THREE facts together (`ccn`, `macJurisdiction`, `cbsaCode`) and the
 * method can only return the whole object or `null` — it cannot honestly return two real fields and
 * fabricate the third. `ccn` is real (the `provider_entity` row, the exact query M23's own write-service
 * composition root already runs for the same purpose). `macJurisdiction` was investigated as "a genuine
 * missing fact — no column, no derivation anywhere" (#250's own scoping pass); that was WRONG, checked
 * against the schema rather than assumed: `mac_submitter_credential.mac_jurisdiction` is exactly this fact,
 * admin-set per provider entity during MAC portal onboarding (`packages/db/src/schema/billing/
 * mac-submitter-credential.ts`), unique per `providerEntityId`, with a real repository
 * (`MacSubmitterCredentialRepository.findByProviderEntity`) already reading the safe (cipher-free)
 * projection. A provider entity that has not yet been onboarded with a MAC submitter credential has no
 * jurisdiction to report — `null` overall, which the caller already turns into `PROVIDER_ENTITY_UNRESOLVED`
 * (422) at `claim-assembly.ts` line ~454-461, an accurate reading of that outcome, not a repurposing of it.
 *
 * `cbsaCode` is set to `null` unconditionally: traced every read of `pe.cbsaCode` in `claim-assembly.ts` —
 * there are none. The claim's actual CBSA comes from `wageIndex.cbsaCode` (the `wage_index_factor` row),
 * a completely separate read. `ProviderEntityDirectoryEntry.cbsaCode` is dead in this file; `null` is
 * therefore not a placeholder standing in for unknown data, it is an honest report of a field this method
 * has no consumer for.
 *
 * `provider_entity` is owned by Module 1 (Foundation), not M23 — `arch:tables` refuses this file reading
 * its Drizzle schema directly. Its CCN is resolved through the SAME injected `ProviderCcnPort` the M23
 * write-service already binds at the composition root (`write-service.ts`'s own doc: "M23 may not import
 * M40's [sic — M1's] package, so this is a typed PORT the composition root binds"), not a second,
 * duplicate cross-module edge.
 */
// This adapter is built ONCE at boot over the bare pooled `db` (`boot-assembly.ts` has no per-request
// handle to hand it) and then called from deep inside `assemble()`'s OWN `withOrgContext` transaction —
// but that transaction's scoped `tx` handle never reaches here, only the closed-over `orgId` argument
// every `ClaimAssemblySeams` method is deliberately designed to take. So each read below opens its OWN
// `withOrgContext(db, {organizationId: orgId, ...})` — the exact `admissionSchedulingContextForOrg` /
// `electionPeriodContextForOrg` (M6) "second wall behind RLS, org-explicit rather than ambient" pattern —
// instead of assuming the caller's ambient request context reaches an object built at boot time.
export function buildM23MdmProviderEntityAdapter(
  db: BillingDb,
  providerCcn: ProviderCcnPort,
): Pick<MdmEntityProvider, "resolveProviderEntity"> {
  return {
    async resolveProviderEntity(orgId, providerEntityId) {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        let ccn: string;
        try {
          ccn = await providerCcn.ccnForProviderEntity(tx, orgId, providerEntityId);
        } catch {
          // Not found / not visible under RLS in this org — the caller turns a null return into
          // PROVIDER_ENTITY_UNRESOLVED (422), the same outcome the port's own callers already reach.
          return null;
        }

        const macCredentials = new repositories.MacSubmitterCredentialRepository(tx);
        const credential = await macCredentials.findByProviderEntity(providerEntityId);
        if (!credential) return null;

        const entry: ProviderEntityDirectoryEntry = {
          ccn,
          macJurisdiction: credential.macJurisdiction,
          cbsaCode: null,
        };
        return entry;
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 3. admission / electionPeriods / certifications / faceToFace / levelOfCare (M6) — real, over M6's new
//    range-shaped seam function (F-121, #251).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The exact shape of M6's `claimAssemblyRangeContextForOrg` (`06-admission/seams/drizzle-store.ts`),
 * duplicated locally rather than imported — the SAME no-package-import posture as {@link M5CoverageSeam}
 * above: this file speaks M23's own `ClaimAssemblySeams` vocabulary, and the composition root is the only
 * place that is allowed to know both modules' shapes at once (`index.ts` binds this port directly to the
 * M6 function).
 */
export interface M6ClaimRangeReader {
  forRange(
    orgId: string,
    patientId: string,
    range: DateRange,
  ): Promise<{
    readonly admission: {
      readonly admissionId: string;
      readonly hospiceAdmissionDate: string;
      readonly dischargeDate: string | null;
      readonly dischargeReason: string | null;
      readonly deceasedDate: string | null;
      /** F-127 (#251) — `admission.hospice_physician_id` (M40), for `mdm.resolveClinicalParticipants`. */
      readonly hospicePhysicianId: string | null;
    };
    readonly electionPeriods: readonly {
      readonly electionPeriodId: string;
      readonly sequence: number;
      readonly effectiveFrom: string;
      readonly effectiveTo: string | null;
      readonly revoked: boolean;
      readonly revocationDate: string | null;
      /** F-127 (#251) — a SIGNED statement's `attending_physician_id` (M40), for
       *  `mdm.resolveClinicalParticipants`. */
      readonly attendingPhysicianId: string | null;
    }[];
    readonly certifications: readonly {
      readonly electionPeriodSequence: number;
      readonly ctiSigned: boolean;
      readonly ctiSignedDate: string | null;
      readonly attendingCosignRequired: boolean;
      readonly attendingCosigned: boolean;
    }[];
    readonly faceToFace: readonly {
      readonly electionPeriodSequence: number;
      readonly attested: boolean;
      readonly encounterDate: string | null;
    }[];
    readonly levelOfCarePeriods: readonly {
      readonly levelOfCarePeriodId: string;
      readonly levelOfCare: string;
      readonly from: string;
      readonly to: string;
      readonly chcDocumentedHours: number | null;
      readonly gipAdmissionCriteriaDocumented: boolean | null;
    }[];
  } | null>;
}

/**
 * F-121 (#251) — the five `ClaimAssemblySeams` M6 readers that were deferred as "a real new read-surface
 * addition to M6's OWN seam layer, not an M23-side adapter" (`boot-assembly.ts`'s header). That read-surface
 * is `claimAssemblyRangeContextForOrg`; this wraps its ONE bundled result into the five separate reader
 * shapes `assemble()` calls in sequence (`admission → electionPeriods → certifications/faceToFace/
 * levelOfCare`). Each of the five re-resolves the SAME range context independently — `ClaimAssemblySeams`
 * is built once at BOOT with no request-scoped cache to hang memoization off, and `POST /claims/assemble`
 * is not a hot path — so this trades a handful of redundant reads for not inventing cross-call state.
 *
 * `resolveAdmission` re-runs the range resolution and narrows to the `admission` slice; a null result
 * (no admission overlaps the range) is what `assemble()` turns into `PATIENT_NOT_ELECTED` (409).
 */
export function buildM23AdmissionRangeAdapters(reader: M6ClaimRangeReader): {
  readonly admission: AdmissionContextReader;
  readonly electionPeriods: ElectionPeriodReader;
  readonly certifications: CertificationReader;
  readonly faceToFace: FaceToFaceReader;
  readonly levelOfCare: LevelOfCareReader;
} {
  return {
    admission: {
      async resolveForRange(orgId, patientId, range) {
        const ctx = await reader.forRange(orgId, patientId, range);
        return ctx?.admission ?? null;
      },
    },
    electionPeriods: {
      async coveringRange(orgId, patientId, range) {
        const ctx = await reader.forRange(orgId, patientId, range);
        return ctx?.electionPeriods ?? [];
      },
    },
    certifications: {
      async forPatient(orgId, patientId, range) {
        const ctx = await reader.forRange(orgId, patientId, range);
        return ctx?.certifications ?? [];
      },
    },
    faceToFace: {
      async forPatient(orgId, patientId, range) {
        const ctx = await reader.forRange(orgId, patientId, range);
        return ctx?.faceToFace ?? [];
      },
    },
    levelOfCare: {
      async periodsInRange(orgId, patientId, range) {
        const ctx = await reader.forRange(orgId, patientId, range);
        return (ctx?.levelOfCarePeriods ?? []).map((p) => ({
          ...p,
          levelOfCare: p.levelOfCare as LevelOfCare,
        }));
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 4 & 5. referenceData.{wageIndexForCcn,activeSequestrationPolicy} — real, over M23's own tables.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `BillingReferenceDataReader` was documented as a single unit of "genuine new infrastructure" (#250's
 * scoping). Checked per method rather than accepted as a bundle (the F-099/F-101 lesson): two of its four
 * methods DO have a real, already-migrated, already-repositoried backing table and are bound here for
 * real; the other two (`hippsRateTable`, `chcHourlyRateCents`) stay `unbound()` in `boot-assembly.ts` —
 * `packages/billing/src/hipps/calculator.ts`'s own `HippsRateTable` doc carries a `TODO(CMS-fixture)`
 * admitting no CMS per-diem rate file has ever been loaded anywhere in this repository, and no table
 * exists to load one into. That absence is real and is NOT papered over by this file.
 *
 * `wageIndexForCcn` reads `wage_index_factor` — a real, migrated, PLATFORM-SHARED table
 * (`WageIndexFactorRepository.findByCcnAndFiscalYear`) whose own doc comment already names the exact
 * failure mode this binds to: "Returns `null` when CMS has not loaded a factor for that CCN/year (the
 * calculator then fails closed / surfaces a validation error)". The real annual CMS wage-index file has
 * never been loaded by the platform loader in any environment, BUT the table is not actually empty:
 * migration `0080_billing_m23_seed.sql` pre-seeds 5 REPRESENTATIVE placeholder rows for FY2026 (CCNs
 * 010001/050002/380001/450003/999999), its own `load_source_ref` explicitly marked "TODO(cms-fixture) …
 * not authoritative" — checked live rather than assumed empty (`m23-claim-assembly-seams.live.test.ts`
 * originally asserted null for CCN 999999 and got back that exact placeholder row instead). So this
 * resolves a REAL (if non-authoritative) factor for those 5 CCN/FY2026 pairs today, and `null` — the
 * documented, correctly-typed `WAGE_INDEX_UNAVAILABLE` (422) `claim-assembly.ts` already throws for it,
 * line ~464-470, not the generic `SEAM_UNBOUND` (503) infrastructure-absent signal — for every other
 * CCN/year. Binding the real table is what makes loading the actual annual CMS file turn assembly on
 * broadly, rather than requiring a second code change alongside that data load.
 *
 * `activeSequestrationPolicy` reads `sequestration_policy` — ORG-SCOPED, admin-settable through the real
 * `sequestration-policy.routes.ts` surface (an operational fact, never CMS-loaded), via
 * `SequestrationPolicyRepository.findEffectiveOn`.
 */
// Same boot-time-closure reasoning as the MDM adapter above: no ambient/`tx` handle reaches an object
// built once at boot, so each read opens its own explicit `withOrgContext`. `wage_index_factor`'s RLS is
// `SELECT USING (true)` (platform-shared, no org predicate) — its own repository header nonetheless says
// "the service still runs them under withOrgContext for uniformity", which this preserves; the org id used
// there is a fixed platform-reads sentinel since the read is not actually org-scoped.
const PLATFORM_READ_ORG = "00000000-0000-0000-0000-000000000000";

export function buildM23ReferenceDataAdapter(
  db: BillingDb,
  unboundHipps: BillingReferenceDataReader["hippsRateTable"],
  unboundChc: BillingReferenceDataReader["chcHourlyRateCents"],
): BillingReferenceDataReader {
  return {
    hippsRateTable: unboundHipps,
    chcHourlyRateCents: unboundChc,
    async wageIndexForCcn(ccn, fiscalYearStarting) {
      return withOrgContext(db, { organizationId: PLATFORM_READ_ORG, userId: "" }, async (tx) => {
        const wageIndexFactors = new repositories.WageIndexFactorRepository(tx);
        const row = await wageIndexFactors.findByCcnAndFiscalYear(ccn, fiscalYearStarting);
        if (!row) return null;
        return { factorDecimal: row.factorDecimal, cbsaCode: row.cbsaCode };
      });
    },
    async activeSequestrationPolicy(orgId, providerEntityId, serviceFrom) {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const sequestrationPolicies = new repositories.SequestrationPolicyRepository(tx);
        const row = await sequestrationPolicies.findEffectiveOn(providerEntityId, serviceFrom);
        if (!row) return null;
        return {
          sequestrationPolicyId: row.id,
          percentage: row.percentage,
          effectiveFrom: row.effectiveFrom,
          effectiveTo: row.effectiveTo,
        };
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 6 & 7. billableEncounters / signedEncounters (M8) — real, over M8's two new range-shaped seam functions
//    (F-122, #251).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The exact shape of M8's `billableEncountersInRangeForOrg` (`08-encounters/seams/drizzle-store.ts`),
 *  duplicated locally per the {@link M5CoverageSeam} no-package-import posture. */
export interface M8BillableEncountersReader {
  inRange(
    orgId: string,
    providerEntityId: string,
    patientId: string,
    range: DateRange,
  ): Promise<
    ReadonlyArray<{
      readonly encounterId: string;
      readonly billable: boolean;
      readonly reason?: string;
      readonly serviceDate: string;
    }>
  >;
}

/** The exact shape of M8's `signedEncounterSnapshotsInRangeForOrg`, duplicated locally for the same
 *  reason — its fields already match `SignedEncounterSnapshot` one-for-one, so no projection is needed
 *  beyond the port boundary itself. */
export interface M8SignedEncountersReader {
  inRange(
    orgId: string,
    patientId: string,
    range: DateRange,
  ): Promise<
    ReadonlyArray<{
      readonly encounterId: string;
      readonly serviceDate: string;
      readonly discipline: string;
      readonly signed: true;
      readonly cosignRequired: boolean;
      readonly cosigned: boolean;
      readonly durationMinutes: number;
    }>
  >;
}

/**
 * F-122 (#251) — `billableEncounters.forRange`. M8's `EncounterBillability` carries FOUR reasons
 * (`voided`/`volunteer_non_billable`/`late_entry_unattested`/`awaiting_cosignature`); M23's
 * `BillabilityState` collapses to three, keeping `awaiting_cosignature` as its own state (D10: those
 * visits are surfaced but excluded from lines, not treated the same as a voided/volunteer one) and folding
 * the other three reasons into `not_billable` — the collapse belongs here, at the M23 boundary, not in
 * M8's own vocabulary.
 */
export function buildM23BillableEncountersAdapter(
  reader: M8BillableEncountersReader,
): BillableEncounterReader {
  return {
    async forRange(orgId, providerEntityId, patientId, range) {
      const rows = await reader.inRange(orgId, providerEntityId, patientId, range);
      return rows.map((r) => ({
        encounterId: r.encounterId,
        serviceDate: r.serviceDate,
        billability: r.billable
          ? ("billable" as const)
          : r.reason === "awaiting_cosignature"
            ? ("awaiting_cosignature" as const)
            : ("not_billable" as const),
      }));
    },
  };
}

/**
 * F-122 (#251) — `signedEncounters.inWindow`. The M8 read already projects to exactly
 * `SignedEncounterSnapshot`'s shape, so this is a straight pass-through port — no field mapping, unlike
 * the billability collapse above.
 */
export function buildM23SignedEncountersAdapter(
  reader: M8SignedEncountersReader,
): Pick<SignedEncountersReader, "inWindow"> {
  return {
    async inWindow(orgId, patientId, window) {
      return reader.inRange(orgId, patientId, window);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 8. evvCompliance (M18) — real, bridging M8's encounter→visit link and M18's bulk compliance read
//    (F-123, #251).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The exact shape of M8's `encounterVisitIdsForOrg`, duplicated locally per the no-package-import
 *  posture — M23's manifest `dependsOn` does not even list M18, so this bridge MUST be composition-root
 *  injected rather than a direct cross-module read either side. */
export interface M8EncounterVisitIdsReader {
  forEncounters(
    orgId: string,
    encounterIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>>;
}

/** The exact shape of M18's `complianceStatesForVisitsForOrg`, duplicated locally for the same reason. */
export interface M18ComplianceStatesReader {
  forVisits(
    orgId: string,
    visitIds: readonly string[],
  ): Promise<
    ReadonlyMap<string, "compliant" | "documented_missing" | "unresolved_missing" | "not_required">
  >;
}

/**
 * F-123 (#251) — `evvCompliance.bracketsForEncounters`. M23's contract is ENCOUNTER-keyed; M18's published
 * `EvvComplianceReader.bracketStateForVisit` is VISIT-keyed, and the link between the two
 * (`encounter.visit_id`) is M8-owned — M18's manifest `dependsOn` is `[17]`, not `[8]`, so M18 itself
 * cannot resolve it. This adapter is the one place both facts meet: it asks M8 for the visit id behind
 * each encounter, then asks M18 for compliance state over the resulting visit ids in ONE bulk call.
 *
 * An encounter with NO visit (an ad-hoc note) maps to `not_required` — the same default M18's own
 * `classify()` uses for "no events, no resolution trail": an encounter with no M17 visit has no EVV path
 * to begin with, which is a different fact from "a visit exists but nothing was ever captured for it."
 */
export function buildM23EvvComplianceAdapter(
  m8VisitIds: M8EncounterVisitIdsReader,
  m18Compliance: M18ComplianceStatesReader,
): EvvComplianceReader {
  return {
    async bracketsForEncounters(orgId, encounterIds) {
      if (encounterIds.length === 0) return [];
      const visitIdByEncounter = await m8VisitIds.forEncounters(orgId, encounterIds);
      const visitIds = [...visitIdByEncounter.values()].filter((v): v is string => v !== null);
      const stateByVisit = await m18Compliance.forVisits(orgId, visitIds);
      return encounterIds.map((encounterId) => {
        const visitId = visitIdByEncounter.get(encounterId) ?? null;
        const bracketState =
          visitId === null ? "not_required" : (stateByVisit.get(visitId) ?? "not_required");
        return { encounterId, bracketState };
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 9. terminology (M38) — real, over the registered `TerminologyProvider` seam's bulk `expand()` (F-124,
//    #251).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The minimal M38 `TerminologyProvider.expand()` surface this adapter consumes, duplicated locally per
 * the no-package-import posture — the same shape {@link M5CoverageSeam} above uses. M38's
 * `TerminologyProvider` is already a registered M1-registry seam (`registerTerminologySeams`, M38-T05),
 * so — unlike the M6/M8/M18 bridges above, which needed brand-new bare functions the composition root has
 * no other way to reach — this needs no `boot-assembly.ts` port injection at all; it resolves through
 * `getSeam` exactly like {@link buildM23PatientPayerAdapter} does.
 */
export interface M38TerminologyReader {
  expand(
    valueSetId: string,
    opts: {
      readonly asOf?: Date;
      readonly includeTenantExtensions?: boolean;
      readonly orgId?: string;
    },
  ): AsyncIterable<{ readonly code: string }>;
}

/**
 * F-124 (#251) — `terminology.resolveForClaim`. #251's own scoping was right that this seam needs a
 * BULK, pre-resolved map with no codes given at fetch time, and wrong that the bridge needs a NEW M38
 * capability: `TerminologyProvider.expand(valueSetId)` (§4.5) already IS that bulk method — the "small
 * adapter, not a design task" framing #250 once used (wrongly) for a different seam turns out to be true
 * here, once the right M38 method is used.
 *
 * `valueSetMembership` resolves exactly ONE value set. Checked against every rule file in
 * `packages/billing/src/rules/`, not assumed: `modifier_codes_valid` is the ONLY one of the 19
 * platform-default rules that reads `ctx.terminology.valueSetMembership` (via `isMemberOf`), and
 * `CMS_HOSPICE_MODIFIER_VALUE_SET` is its only `valueSetId` (`defaultParameters`) — the platform boot
 * (`createDefaultBillingRegistry()`, no tenant/MAC rule-parameter overlay is read at assembly time today)
 * never asks this seam about a second value set. `includeTenantExtensions: true` is load-bearing, not a
 * default left on: a tenant may ADD a locally-valid modifier to the platform set (§7.6, add-only /
 * never-weaken) and omitting it here would report that tenant's own approved modifier as invalid on
 * every claim that carries it.
 *
 * `CMS_HOSPICE_MODIFIER_VALUE_SET` itself did not exist as a real value set anywhere before this pass
 * (F-124) — `modifier-codes.ts` referenced it and no migration, seed, or curation file ever defined it,
 * so `expand()` would have answered an empty iterable forever, same shape as the `hope_j_codes`/
 * `hospice_terminal_diagnosis` gap F-057 already documented and degrades honestly for. Two CMS-defined
 * hospice modifiers (GV, GW) are now curated in `@wardenx/terminology`'s seed alongside the platform's
 * other small, fully-enumerated reference sets (`level_of_care`, `place_of_service_q_codes`).
 *
 * `icd10Billable` is honestly `{}`. Traced rather than assumed: `icd10_sequencing` is the only reader of
 * this map, over `ctx.claim.icd10Sequence` — and `claim-assembly.ts`'s own line-assembly hardcodes
 * `icd10Sequence: []` on every claim it assembles today (no seam anywhere populates a diagnosis sequence
 * at assembly time; a separate, real M23-side gap this pass did not create and did not fix — it is not
 * part of #251's M38 item). With no diagnosis code ever on the claim to ask about, there is nothing to
 * bulk-resolve; `{}` is what a per-code map looks like with zero codes asked about, not a placeholder for
 * unknown data.
 */
export function buildM23TerminologyAdapter(
  resolve: () => M38TerminologyReader = () =>
    getSeam("TerminologyProvider") as M38TerminologyReader,
): TerminologyProvider {
  return {
    async resolveForClaim(orgId, asOfDate) {
      const reader = resolve();
      const asOf = new Date(`${asOfDate}T00:00:00Z`);
      const members: string[] = [];
      for await (const m of reader.expand(CMS_HOSPICE_MODIFIER_VALUE_SET, {
        asOf,
        includeTenantExtensions: true,
        orgId,
      })) {
        members.push(m.code);
      }
      return {
        valueSetMembership: { [CMS_HOSPICE_MODIFIER_VALUE_SET]: members },
        icd10Billable: {},
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 10. mdm.resolveClinicalParticipants (M6 → M40 bridge) — PARTIALLY real (F-127, #251).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The minimal M40 `MdmEntityProvider.resolvePhysician` surface this adapter consumes, duplicated locally
 * per the no-package-import posture. M40's `MdmEntityProvider` is already a registered M1-registry seam
 * (`registerMdmSeams`), so — the {@link buildM23TerminologyAdapter} shape again — this needs no
 * `boot-assembly.ts` port injection; it resolves through `getSeam`.
 */
export interface M40PhysicianReader {
  resolvePhysician(
    orgId: string,
    id: string,
  ): Promise<{
    readonly canonical: { readonly identifierValue: string | null };
    readonly status: "active" | "deactivated" | "provisional";
  } | null>;
}

/**
 * Resolve one physician id to `PhysicianResolution | null`, honestly. `null` when the admission/election
 * names no physician (nothing to resolve), when M40 has no canonical row for the id at all (an orphaned
 * reference — reported as "not identified" like the no-id case, since `PhysicianResolution | null` has no
 * third state to distinguish them), or when the canonical row is a `provisional` with no NPI confirmed yet
 * (`identifierValue: null` — `PhysicianResolution.npi` is required, and there is no NPI to report).
 *
 * `status` maps M40's three post-redirect states to NPPES vocabulary: `active`→`active`,
 * `deactivated`→`inactive`, `provisional`→`not_found` (M40 has a canonical row, but it has never been
 * matched against a confirmed NPPES enumeration, which is exactly what `not_found` means for this rule).
 * `NpiStatus`'s fourth value, `invalid`, is never produced here — `external_physician.npi`'s own CHECK
 * constraint (`npi ~ '^[0-9]{10}$'`) guarantees any non-null value M40 returns is already well-formed.
 *
 * `licenseUnexpiredOnServiceDates` is honestly `false`, ALWAYS, checked rather than assumed: M40's
 * canonical physician record (`external_physician.license_states`) carries which STATES a physician holds
 * a license in, never a per-state EXPIRY DATE — no table anywhere in this platform tracks one. `false` is
 * not a fabricated failure, it is the F-121 `chcDocumentedHours` reasoning transplanted here — "silence is
 * not compliance evidence" — and `physician-credentials.ts`'s own defect message was reworded (F-126,
 * #251) from "is expired" to "is not confirmed unexpired" so the rule never asserts a fact this seam
 * cannot back up.
 */
async function toPhysicianResolution(
  m40: M40PhysicianReader,
  orgId: string,
  physicianId: string | null,
): Promise<PhysicianResolution | null> {
  if (physicianId === null) return null;
  const resolved = await m40.resolvePhysician(orgId, physicianId);
  if (resolved === null || resolved.canonical.identifierValue === null) return null;
  const status: NpiStatus =
    resolved.status === "active"
      ? "active"
      : resolved.status === "deactivated"
        ? "inactive"
        : "not_found";
  return {
    npi: resolved.canonical.identifierValue,
    status,
    licenseUnexpiredOnServiceDates: false,
  };
}

/**
 * F-127 (#251) — `mdm.resolveClinicalParticipants`, checked precisely rather than left as one "genuinely
 * unbuilt" verdict. Physician IDENTITY is real: `admission.hospice_physician_id` /
 * (a SIGNED) `election_statement.attending_physician_id` are both M40 physician ids the M6 range read now
 * carries (extended alongside the F-121 shapes, over the SAME `m6ClaimRange` port — no new
 * `boot-assembly.ts` port needed), resolved through M40's real `resolvePhysician`. `placeOfService` stays
 * honestly `null` — checked against the whole schema, not assumed: no table anywhere (not `patient_address`,
 * whose `kind` enum distinguishes only `home`/`facility`/`mailing`/`temporary`/`prior` with no facility-type
 * taxonomy beneath `facility`; not M40's `CanonicalFacilityFields`, which carries `ccn`/`npi`/
 * `sendingFacilityCodes` and no site-type field) records which of home/ALF/SNF/hospital/IPU a patient is
 * currently receiving care in. That is genuine new infrastructure — a producer decision comparable to
 * `referenceData.hippsRateTable`'s CMS-fixture gap, not a wiring task — and is NOT invented here; guessing
 * a heuristic off `patient_address.kind` (`facility` could mean any of five different Q-code sites) would
 * be exactly the "guessed provider entity is a mis-stated cost report" mistake F-102 already named for a
 * different module. `place_of_service_consistency` (§4.5) therefore fails, honestly, for every claim until
 * a real producer exists — the rule's own `documentedPos === null` branch is the designed path for exactly
 * this, not a new blocker.
 */
export function buildM23ClinicalParticipantsAdapter(
  m6ClaimRange: M6ClaimRangeReader,
  resolveM40: () => M40PhysicianReader = () => getSeam("MdmEntityProvider") as M40PhysicianReader,
): Pick<MdmEntityProvider, "resolveClinicalParticipants"> {
  return {
    async resolveClinicalParticipants(orgId, patientId, asOf) {
      const ctx = await m6ClaimRange.forRange(orgId, patientId, { from: asOf, to: asOf });
      const hospicePhysicianId = ctx?.admission.hospicePhysicianId ?? null;
      const attendingPhysicianId = ctx?.electionPeriods[0]?.attendingPhysicianId ?? null;
      const m40Physicians = resolveM40();
      const [hospicePhysician, attending] = await Promise.all([
        toPhysicianResolution(m40Physicians, orgId, hospicePhysicianId),
        toPhysicianResolution(m40Physicians, orgId, attendingPhysicianId),
      ]);
      return { attending, hospicePhysician, placeOfService: null };
    },
  };
}
