// apps/backend/src/modules/35-subscription/outbox-consumers/m5-patient-active-period.ts — the §4.12
// `patient-active-period-aggregator` binding over `m5.patient.deceased` / `m5.patient.merged`
// (F-172, #248). M35's own D21 names both; F-142/F-167 left them deferred on
// `PseudonymKeyProvider.activeKey()` having zero implementations — now built
// (`../pseudonym-key-provider.ts`). `m5.patient.created`/`.status_changed` (D21's other two
// `patient-active-period-aggregator` triggers) are OUT OF SCOPE for this pass — neither declares `m35`
// as a consumer on its catalog entry today, unlike `.deceased`/`.merged` (both carry `declaredConsumers:
// [..., "m35"]`), so binding them is a separate, unscoped catalog question this file does not answer.
//
// `.merged` ("Re-pseudonymize on merge target", §4.12): `corePatient.patientId` on this event IS the
// SURVIVOR (`events-by-m5.ts`'s own description — "`patientId` = the SURVIVOR/target,
// `sourcePatientId` = the duplicate folded away"), so the real action is simply ensuring the survivor
// has a `patient_active_period` row for the CURRENT period under the CURRENT key epoch — exactly
// `UsageMeteringService.recordPatientActive`'s existing shape, applied to the merge target's own raw id.
// The duplicate's (`sourcePatientId`) own historical rows are left untouched: they are a true historical
// fact (that pseudonym WAS active under that raw id, in those periods) and rewriting them would rewrite
// history rather than merge it — the `pseudonym-key-rotation` precedent ("historic rows are simply
// tagged with their original identity") applied to a merge instead of a rotation.
//
// `.deceased` ("Mark inactive with reason='died'", §4.12): stamps the CURRENT period's row with
// `becameInactiveAt`/`inactivityReason='died'` via `markPatientInactiveForOrg` — see that function's own
// header for why `wasActive` is deliberately untouched.
import type { DbClient } from "@wardenx/db";
import {
  type PseudonymKeyProvider,
  computeBillingPseudonym,
  toBillingYearMonth,
} from "@wardenx/subscription-billing";
import {
  createDrizzleActivePeriodStore,
  markPatientInactiveForOrg,
} from "../active-period-store-drizzle";

export const M35_PATIENT_ACTIVE_PERIOD_CONSUMER = {
  eventNames: ["m5.patient.deceased", "m5.patient.merged"] as const,
  consumerName: "m35.patient-active-period-aggregator",
} as const;

export interface PatientActivePeriodConsumerDeps {
  readonly db: DbClient;
  readonly keyProvider: PseudonymKeyProvider;
  readonly now?: () => Date;
}

function patientIdOf(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  return typeof p.patientId === "string" ? p.patientId : "";
}

function deceasedDateOf(payload: unknown): Date | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (typeof p.deceasedDate !== "string" || p.deceasedDate.length === 0) return null;
  const d = new Date(p.deceasedDate);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * M35's live `m5.patient.{deceased,merged}` binding (§4.12 `patient-active-period-aggregator`).
 */
export function buildM35PatientActivePeriodConsumer(deps: PatientActivePeriodConsumerDeps) {
  const now = deps.now ?? (() => new Date());
  const activePeriodStore = createDrizzleActivePeriodStore(deps.db);

  return {
    consumerName: M35_PATIENT_ACTIVE_PERIOD_CONSUMER.consumerName,
    consumerModule: "m35" as const,
    eventTypes: M35_PATIENT_ACTIVE_PERIOD_CONSUMER.eventNames,
    async handle(event: {
      readonly eventType: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const patientId = patientIdOf(event.payload);
      if (patientId.length === 0) return;

      const key = await deps.keyProvider.activeKey();

      if (event.eventType === "m5.patient.merged") {
        const patientPseudonym = computeBillingPseudonym(key.keyMaterial, patientId);
        const at = now();
        await activePeriodStore.upsertPatientActivePeriod({
          organizationId: event.organizationId,
          patientPseudonym,
          pseudonymKeyEpoch: key.keyEpoch,
          periodYearMonth: toBillingYearMonth(at),
          becameActiveAt: at,
        });
        return;
      }

      if (event.eventType === "m5.patient.deceased") {
        const deceasedAt = deceasedDateOf(event.payload);
        if (!deceasedAt) return; // malformed/missing date — nothing safe to stamp, refuse silently.
        const patientPseudonym = computeBillingPseudonym(key.keyMaterial, patientId);
        await markPatientInactiveForOrg(deps.db, {
          organizationId: event.organizationId,
          patientPseudonym,
          pseudonymKeyEpoch: key.keyEpoch,
          periodYearMonth: toBillingYearMonth(deceasedAt),
          becameInactiveAt: deceasedAt,
          reason: "died",
        });
      }
    },
  };
}
