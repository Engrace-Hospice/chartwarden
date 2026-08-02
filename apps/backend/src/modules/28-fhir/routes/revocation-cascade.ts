// apps/backend/src/modules/28-fhir/routes/revocation-cascade.ts — W-FHIR-12, the client revocation cascade.
//
// §2.4 — revoking or suspending a `fhir_client` must ALSO stop everything the client had in flight: its
// active `fhir_client_session` rows (so a leaked bearer token dies immediately, not at its 15-minute TTL)
// and its `accepted`/`in_progress` `fhir_bulk_export_job` rows (so a running export cannot keep minting
// NDJSON for a client the operator just cut off). The FSM's `FHIR_CLIENT_CASCADE_ON_ENTRY` names the two
// statuses whose ENTRY runs this (`suspended`, `revoked`); this module is the cascade itself.
//
// It is a PURE orchestration over an injected port so it unit-tests without a database (W-FHIR-12): the
// store's real revoke/suspend path binds the Drizzle port and runs the cascade inside the SAME transaction
// as the status write, so a client cannot be left `revoked` with a live session (the M20 cascade posture).

/** The narrow data port the cascade composes over (Drizzle in prod; in-memory in the §7 test). */
export interface FhirRevocationCascadePort {
  /** The `jti`s of the client's still-live (unexpired, unrevoked) sessions. */
  activeSessionJtisForClient(organizationId: string, clientId: string): Promise<readonly string[]>;
  /** Mark one session revoked (idempotent — a second revoke of the same jti is a no-op). */
  revokeSession(organizationId: string, clientId: string, jti: string): Promise<void>;
  /** The ids of the client's in-flight (`accepted`/`in_progress`) bulk-export jobs. */
  inflightJobIdsForClient(organizationId: string, clientId: string): Promise<readonly string[]>;
  /** Cancel one in-flight job (`status='cancelled'`). */
  cancelJob(organizationId: string, jobId: string): Promise<void>;
}

/** What the cascade did — surfaced on the admin response and asserted by the §7 test. */
export interface FhirRevocationCascadeResult {
  readonly sessionsRevoked: number;
  readonly jobsCancelled: number;
}

/**
 * Cascade a client revoke/suspend: revoke every live session, cancel every in-flight export.
 *
 * Order is not load-bearing (the two sets are disjoint resources), but BOTH must run — a caller that
 * revoked sessions and forgot the jobs would leave an export streaming a cut-off client's charts.
 */
export async function cascadeClientRevocation(
  organizationId: string,
  clientId: string,
  port: FhirRevocationCascadePort,
): Promise<FhirRevocationCascadeResult> {
  const jtis = await port.activeSessionJtisForClient(organizationId, clientId);
  for (const jti of jtis) {
    await port.revokeSession(organizationId, clientId, jti);
  }
  const jobIds = await port.inflightJobIdsForClient(organizationId, clientId);
  for (const jobId of jobIds) {
    await port.cancelJob(organizationId, jobId);
  }
  return { sessionsRevoked: jtis.length, jobsCancelled: jobIds.length };
}
