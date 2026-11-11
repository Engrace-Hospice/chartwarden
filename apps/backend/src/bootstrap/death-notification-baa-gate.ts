// apps/backend/src/bootstrap/death-notification-baa-gate.ts - the BAA gate of the external death notice, over M40's BAA register (`mdm_baa_record`,
// written through POST /api/v1/mdm/baa). M40's own policy does NOT gate a funeral home by default (status `n_a`, which reads "active" even with no
// record, and would also hide an executed record). This disclosure is stricter and policy-independent: it needs a RECORDED, executed BAA in force as of
// now (executed on or before, not yet expired). No record, pending, expired or not yet effective => blocked; the caller treats a throw as blocked too.
// The in-force rule mirrors M40's `decideBaaStatus` (`activeAt`); the composition root may not import @chartwarden/mdm, so the shape is structural.
export interface BaaRecordRowLike {
  readonly baaStatus: string;
  readonly executedOn: string | null;
  readonly expiresOn: string | null;
}

export interface BaaRecordReader {
  baaRecords(
    orgId: string,
    kind: "funeral_home",
    canonicalId: string,
  ): Promise<readonly BaaRecordRowLike[]>;
}

const inForce = (r: BaaRecordRowLike, asOf: Date): boolean =>
  r.baaStatus === "executed" &&
  r.executedOn !== null &&
  new Date(r.executedOn) <= asOf &&
  (r.expiresOn === null || new Date(r.expiresOn) >= asOf);

export function executedBaaGate(
  reader: () => BaaRecordReader,
): (orgId: string, kind: "funeral_home", entityId: string, asOf: Date) => Promise<boolean> {
  return async (orgId, kind, entityId, asOf) =>
    (await reader().baaRecords(orgId, kind, entityId)).some((r) => inForce(r, asOf));
}
