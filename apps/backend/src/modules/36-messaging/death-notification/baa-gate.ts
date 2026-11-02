// apps/backend/src/modules/36-messaging/death-notification/baa-gate.ts - the BAA gate of the external death notice, over M40's BAA register
// (`mdm_baa_record`, written through POST /api/v1/mdm/baa). M40's own policy does NOT gate a funeral home by default (status `n_a`, which would read
// "active" even with no record, and would also hide an executed record). This disclosure is stricter and policy-independent: it needs a RECORDED,
// executed BAA in force as of now, decided by M40's own pure engine with the requirement forced on. No record, pending, expired or not yet effective
// => blocked. The caller treats a throw as blocked too (fail closed).
import { type BaaStore, decideBaaStatus } from "@chartwarden/mdm";

export type BaaRecordReader = Pick<BaaStore, "baaRecords">;

export function executedBaaGate(
  reader: () => BaaRecordReader,
): (orgId: string, kind: "funeral_home", entityId: string, asOf: Date) => Promise<boolean> {
  return async (orgId, kind, entityId, asOf) => {
    const records = await reader().baaRecords(orgId, kind, entityId);
    return decideBaaStatus({ requiredByPolicy: true, records, asOf }).status === "executed";
  };
}
