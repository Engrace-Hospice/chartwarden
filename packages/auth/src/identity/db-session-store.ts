import { schema } from "@wardenx/db";
import type { DbClient } from "@wardenx/db";
// @wardenx/auth · identity — DB-backed SessionContextStore (M2, AUTH-T05b, ADR-0033).
//
// Reads the M1 `session` table (where Better Auth writes the session + its additionalFields:
// activeOrganizationId, lastStepUpAt/Factor) so the SessionContextResolver resolves REAL sessions in
// production. Ownership-safe: it touches only the `session` table (the same M1 table the Better Auth
// drizzle adapter already reads/writes from this package) — it does NOT read M3's role/membership_role
// tables. `membershipId`/`roles` are enriched through an injected `ActorEnrichmentReader` (the M3-owned
// path: membership_role ⋈ role under RLS) when one is supplied; absent it (slice/tests), they stay empty
// and M3's effective-permission resolver still performs authorization independently (keyed userId+orgId).
import type {
  ActorEnrichment,
  ActorEnrichmentReader,
  OrgScope,
  StepUpFactor,
} from "@wardenx/types";
import { eq } from "drizzle-orm";
import {
  SESSION_CLASSES,
  type SessionClass,
  sessionAuditorStage,
  sessionEngagementId,
  sessionExternalActorId,
  sessionPinnedPatientId,
} from "./session-classes";
import type { SessionContextRecord, SessionContextStore } from "./session-seam";

/** The session-table columns this store reads. */
export interface SessionRow {
  readonly userId: string;
  readonly activeOrganizationId: string | null;
  readonly lastStepUpAt: Date | null;
  readonly lastStepUpFactor: string | null;
  /**
   * The §2.2.4 class. Read here because M16/M19/M31's ABAC predicates gate on it and nothing ever
   * carried it off the row — so those predicates saw an absent value, defaulted it to `staff`, and
   * denied unconditionally (F-030). Nullable in the type only: the column is NOT NULL DEFAULT 'staff'.
   */
  readonly sessionClass: string | null;
  /** `{ patientId }` for collaborator/funeral; `{ portalAccountId, patientId? }` for the portal classes. */
  readonly scope: unknown;
  /** Auditor-session window bounds (`session_scope_chk` requires both on an auditor row). */
  readonly engagementStart?: Date | null;
  readonly engagementEnd?: Date | null;
  /**
   * The joined `device_attestation` row this session points at (SecHardening §12.4), or null when the
   * session is bound to no device — the ordinary case for a browser session.
   *
   * The columns come from the ROW, never from the session's pointer: the pointer says which
   * attestation to look at and the row says whether it still holds. That split is the point — an
   * attestation revoked or expired AFTER the session was minted must stop satisfying the gate without
   * anyone having to find and rewrite the session.
   */
  readonly deviceAttestation: DeviceAttestationRow | null;
}

/** The `device_attestation` columns the liveness decision needs. */
export interface DeviceAttestationRow {
  /** The `device_attestation` row id — the session-bound device identity M18 binds a capture to. */
  readonly id?: string;
  readonly verdict: string;
  readonly verifiedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

/** Pure: map a `session` row to a context record, merging optional M3 actor enrichment. Pre-org
 *  sessions map organizationId to "" so the resolver's org guard (`organizationId === scope.orgId`)
 *  yields null for them. Enrichment is applied only for the session's active org. */
export function toSessionContextRecord(
  row: SessionRow,
  sessionId: string,
  enrichment?: ActorEnrichment | null,
  now: Date = new Date(),
): SessionContextRecord {
  const sessionClass = row.sessionClass ?? "staff";
  const patientId = scopeString(row.scope, "patientId");
  const externalActorId = scopeString(row.scope, "externalActorId");
  const engagementId = scopeString(row.scope, "engagementId");
  return {
    sessionId,
    userId: row.userId,
    membershipId: enrichment?.membershipId ?? null, // M3-owned path (membership_role/role) via the reader
    organizationId: row.activeOrganizationId ?? "",
    roles: enrichment?.roles ?? [], // authz still runs through M3's effective-permission resolver
    providerEntityIds: enrichment?.providerEntityIds ?? [],
    locationIds: enrichment?.locationIds ?? [],
    lastStepUpAt: row.lastStepUpAt ?? null,
    lastStepUpFactor: (row.lastStepUpFactor as StepUpFactor | null) ?? null,
    sessionClass, // column is NOT NULL DEFAULT 'staff'
    portalAccountId: scopeString(row.scope, "portalAccountId"),
    // Through the CLASS predicate, not straight off the column. `scope` is jsonb: a staff session
    // that somehow carries a `patientId` in it must still resolve to null, because what pins a
    // session is its class, not the presence of a key. `sessionPinnedPatientId` is the same
    // predicate `isSessionScopeValid` mirrors the DB CHECK with, so the read and the write agree.
    sessionPatientId: isSessionClass(sessionClass)
      ? sessionPinnedPatientId({
          sessionClass,
          scope: { ...(patientId ? { patientId } : {}) },
        })
      : null,
    deviceAttestation: liveDeviceAttestation(row.deviceAttestation, now),
    // Through the CLASS predicate for the same reason `sessionPatientId` is: this key is the
    // authorization subject of `external_triage_actor`, so a staff session that somehow carried an
    // `externalActorId` in its jsonb must read null rather than reach a vendor-scoped call.
    externalActorId: isSessionClass(sessionClass)
      ? sessionExternalActorId({
          sessionClass,
          scope: { ...(externalActorId ? { externalActorId } : {}) },
        })
      : null,
    // Class- and window-gated (GAP-093(c)): the auditor's own engagement, off the session row only.
    engagementId: isSessionClass(sessionClass)
      ? sessionEngagementId({
          sessionClass,
          scope: { ...(engagementId ? { engagementId } : {}) },
          engagementStart: row.engagementStart ?? null,
          engagementEnd: row.engagementEnd ?? null,
        })
      : null,
    // Class-gated and FAIL CLOSED: only an explicit `active` in the session's server-side scope is active.
    auditorStage: isSessionClass(sessionClass)
      ? sessionAuditorStage({
          sessionClass,
          scope: { auditorStage: scopeString(row.scope, "auditorStage") ?? "" },
        })
      : null,
  };
}

/**
 * The platform's verdict on the session's device, or null when there is not a LIVE attestation behind it.
 *
 * Three ways a pointer stops meaning "attested", and all three must read the same as no pointer at all:
 * the verdict is not `attested` (a recorded failure, or a revocation), the row has been revoked, or the
 * attestation window has run out. Returning `{ valid: false }` for those instead of null would be
 * equivalent at today's only reader — `deviceAttestationValid` denies on both — but it would quietly
 * make "this device failed the posture check" indistinguishable from "there is no device here", which is
 * the distinction a post-incident review is looking for.
 *
 * Expiry is checked HERE rather than in the query so it is unit-testable without a database, and so the
 * clock is an injected argument rather than whatever `now()` the connection happened to see.
 */
export function liveDeviceAttestation(
  row: DeviceAttestationRow | null | undefined,
  now: Date,
): {
  readonly valid: boolean;
  readonly verifiedAt?: string;
  readonly attestationId?: string;
} | null {
  if (!row) return null;
  if (row.verdict !== "attested") return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt === null || row.expiresAt.getTime() <= now.getTime()) return null;
  return {
    valid: true,
    ...(row.verifiedAt ? { verifiedAt: row.verifiedAt.toISOString() } : {}),
    // The id comes off the JOINED row (the session's own pointer), never off the request.
    ...(row.id ? { attestationId: row.id } : {}),
  };
}

/** One string field out of the `scope` jsonb, or null. Never throws on a malformed/absent value. */
function scopeString(
  scope: unknown,
  key: "portalAccountId" | "patientId" | "externalActorId" | "engagementId" | "auditorStage",
): string | null {
  if (typeof scope !== "object" || scope === null) return null;
  const value = (scope as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Is this column value one of the enum's labels? A row written by a NEWER migration than this
 *  build knows about is not — and an unrecognised class pins nothing, which is the closed end. */
function isSessionClass(value: string): value is SessionClass {
  return (SESSION_CLASSES as readonly string[]).includes(value);
}

/**
 * Build a SessionContextStore over the live M1 `session` table. When an `ActorEnrichmentReader` is
 * supplied (production, the M3 Drizzle reader), the resolved actor's `membershipId`/`roles` are filled
 * for the request's org scope; without it the record keeps the empty defaults (slice/tests).
 */
export function createDbSessionContextStore(
  db: DbClient,
  enrich?: ActorEnrichmentReader,
): SessionContextStore {
  return {
    async read(scope: OrgScope, sessionId): Promise<SessionContextRecord | null> {
      const rows = await db
        .select({
          userId: schema.sessions.userId,
          activeOrganizationId: schema.sessions.activeOrganizationId,
          lastStepUpAt: schema.sessions.lastStepUpAt,
          lastStepUpFactor: schema.sessions.lastStepUpFactor,
          sessionClass: schema.sessions.sessionClass,
          scope: schema.sessions.scope,
          engagementStart: schema.sessions.engagementStart,
          engagementEnd: schema.sessions.engagementEnd,
          // SecHardening §12.4 — joined, not a second round trip: this runs on every authenticated
          // request. LEFT so a session with no device (every browser session) still resolves.
          attId: schema.deviceAttestations.id,
          attVerdict: schema.deviceAttestations.verdict,
          attVerifiedAt: schema.deviceAttestations.verifiedAt,
          attExpiresAt: schema.deviceAttestations.expiresAt,
          attRevokedAt: schema.deviceAttestations.revokedAt,
        })
        .from(schema.sessions)
        .leftJoin(
          schema.deviceAttestations,
          eq(schema.deviceAttestations.id, schema.sessions.deviceAttestationId),
        )
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      // Enrich only when the session is bound to the requested org (the resolver's guard rejects a
      // mismatch anyway; this avoids an off-scope membership lookup).
      const enrichment =
        enrich && row.activeOrganizationId === scope.orgId
          ? await enrich.read(scope, row.userId)
          : null;
      return toSessionContextRecord(
        {
          ...row,
          deviceAttestation:
            row.attVerdict === null
              ? null
              : {
                  ...(row.attId ? { id: row.attId } : {}),
                  verdict: row.attVerdict,
                  verifiedAt: row.attVerifiedAt,
                  expiresAt: row.attExpiresAt,
                  revokedAt: row.attRevokedAt,
                },
        },
        sessionId,
        enrichment,
      );
    },
  };
}
