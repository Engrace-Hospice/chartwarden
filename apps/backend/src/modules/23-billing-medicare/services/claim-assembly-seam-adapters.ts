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
import { repositories } from "@wardenx/billing";
import type { LevelOfCare } from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import { getSeam } from "../../../bootstrap/index";
import type { ProviderCcnPort } from "../routes/write-service";
import type {
  AdmissionContextReader,
  BillingReferenceDataReader,
  CertificationReader,
  DateRange,
  ElectionPeriodReader,
  FaceToFaceReader,
  LevelOfCareReader,
  MdmEntityProvider,
  MedicarePrimaryResolution,
  PatientPayerReader,
  ProviderEntityDirectoryEntry,
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
    };
    readonly electionPeriods: readonly {
      readonly electionPeriodId: string;
      readonly sequence: number;
      readonly effectiveFrom: string;
      readonly effectiveTo: string | null;
      readonly revoked: boolean;
      readonly revocationDate: string | null;
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
