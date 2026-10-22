// apps/backend/__tests__/portal-inject.test.ts — M31 (Patient/Family Portal & Telehealth) HTTP-layer
// route-inventory smoke suite (TASK-050A, TEST-001 closure for Module 31).
//
// Module 31 had ZERO Fastify `.inject()` coverage before this file: `portal-abac-routes.test.ts`,
// `portal-lifecycle.test.ts`, `portal-read-surfaces.test.ts`, `portal-seams.test.ts`,
// `portal-telehealth.test.ts` and `portal-write-paths.test.ts` all exercise pure functions / the ABAC
// predicate builder directly, so a mis-wired guard, a typo'd permission key, or a schema that never reaches
// the handler is invisible to every one of them — only a real `inject()` through the FULL M1 middleware
// chain (auth → RBAC → ABAC → TypeBox → handler) catches that class of bug. This file is that pass, cloned
// from `orders-routes.test.ts` / the more recent `discipline-plans-inject.test.ts` `ROUTE_CASES` +
// `describe.each` shape (the current TASK-050A template, two batches of 14 modules in): `buildServer()`
// mounts the host, `mountM31Routes()` mounts the §4.1 fifty-three-route inventory over a hand-rolled
// in-memory `PortalStore` (M31 ships no `createInMemory*Backend`/`createInMemoryPortalStore` export the way
// M11 does — `createInMemoryM31SeamStores` in `seams/stores.ts` covers only the seven seam ports, not the
// extra owned-table route ops `PortalOwnedTableOps` needs, so this file owns its own fake, seeded through
// the SAME `PortalAbacResolver` shape the real §4.7 predicates consume via `buildPortalAbacResolverFromStore`).
// A fresh predicate registry is built per server from `buildPortalAbacPredicates` (the M11-T06 precedent);
// `step_up_recent` (M3's predicate, not M31's) is stubbed to always-pass so the six step-up routes' 2xx path
// is actually exercised.
//
// PORTAL AUTH SURFACE: unlike a plain staff module, M31 has TWO acting session shapes. Staff/admin routes
// (`/api/v1/admin/...`, the staff-side telehealth join/leave/stop-recording/end) run under the ordinary
// header-auth shim with no portal attributes (`actor.sessionClass` defaults `"staff"`, guards.ts's
// `ABAC_IN_ORG`). Patient/caregiver-facing routes (`/api/v1/portal/...`, the portal-side telehealth
// join/leave) need `request.context.attributes.sessionClass` ∈ {patient_portal, caregiver_portal,
// bereaved_portal} PLUS `.portalAccountId` / `.sessionPatientId` — the session anchors `actor.ts` reads
// (never a body/query field, §8.3.1). The header-auth shim below is extended with
// `x-test-session-class` / `x-test-portal-account` / `x-test-portal-patient` (the `bereavement-inject.test.ts`
// precedent for exactly this class of module-specific session attribute).
//
// This is a WIRING smoke test, not a re-test of the §7/§8 write-path or ABAC RULES (already pinned by the
// six pure-function suites above): the fake store applies each route's implied read/mutation directly rather
// than re-deriving M31's write-path guards, so every 2xx case exists to prove the route is MOUNTED, gated on
// the right §4.6 permission key + §4.7 ABAC predicate, and returns the documented status code.
//
// FOUR GENUINE FINDINGS surfaced while grounding this file in the real route source (the fourth via
// TASK-065/API-008, not the original TASK-050A grounding pass), ALL FOUR NOW FIXED at the source (see
// the dedicated "M31 route smoke — fixed findings" describe block below, which proves each fix rather
// than just documenting the old bug):
//
//   1. `POST /api/v1/portal/sessions/select-patient` — the whole point of this route is to bind the FIRST
//      patient a portal session is scoped to (§8.1/D2). Its `ABAC_GRANT` guard (routes/guards.ts) read its
//      `patientId` target from `context.attributes.sessionPatientId` — the SESSION — not the request BODY the
//      caller is trying to select, so a freshly-minted session (no patient selected yet) ALWAYS 403'd, even
//      for a valid active grant. Fixed by removing `ABAC_GRANT` from this one route (`session.routes.ts`):
//      the handler already independently re-derives and checks the exact same invariant, correctly, against
//      the body (`store.activeGrant(org, portalAccountId, patientId)` → `ForbiddenError` on no grant) — the
//      guard was both broken AND redundant with a check that was already right.
//   2. `POST /api/v1/portal/administrations/caregiver-attested` — `write.routes.ts`'s local `MedSummaryArm`
//      structural interface typed the medication-summary row's redaction flag as `redacted?: boolean`; the
//      real upstream DTO (`PortalMedicationSummary` in `@chartwarden/types`) names it `isRedacted`. Fixed by
//      deleting the local structural type and importing the real `MedicationOrderProvider`/
//      `PortalMedicationSummary` types instead, so a future rename can't silently drift again the same way.
//   3. `POST /api/v1/portal/documents/upload-init` — the route's own comment said magic-byte verification is
//      deferred to upload-complete, but it called `planDocumentUpload({ ..., magicBytes: [] })` and
//      `planDocumentUpload` unconditionally magic-byte-checked, so `magicBytesMatch(mime, [])` could never
//      match any allowed MIME signature and every upload-init call 415'd regardless of a valid file. Fixed
//      in `write-paths/document-upload.ts`: the magic-byte guard now SKIPS (does not fail) when `magicBytes`
//      is empty, honoring the two-phase design the function's own comment already promised — a caller that
//      DOES have real bytes still gets a real check.
//   4. `POST /api/v1/telehealth/webhooks/{daily-co,twilio-video}` — the handler verified the vendor HMAC
//      signature but only surfaced the result in the response BODY (`{received: ok}`), always replying
//      200. A bad signature is real vendor evidence (a wrong shared secret, a stale rotated key) and
//      dropping it into a 200 masks the misconfiguration from the vendor's own delivery-failure alerting.
//      Fixed in `telehealth.routes.ts`: a bad signature now replies 401; a valid one still 200s.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetBreakGlassChecker,
  resetRbacEngine,
  setBreakGlassChecker,
} from "@chartwarden/auth";
import type {
  ExternalGriefResource,
  ExternalGriefResourceReader,
  IsoInstant,
  MedicationOrderProvider,
  PatientId,
  PortalAccessGrantDigest,
  PortalAccountDigest,
  PortalScopeSet,
  TelehealthEndReason,
  TelehealthLifecycleState,
  TelehealthVisitDigest,
} from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, buildServer, registerSeam } from "../src/bootstrap/index";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import {
  type PortalAbacPorts,
  buildPortalAbacPredicates,
} from "../src/modules/31-portal/abac-predicates";
import {
  M31_PERMISSION_KEY_LIST,
  type PortalRouteDeps,
  type PortalStore,
  type TelehealthAdapterPort,
  buildPortalAbacResolverFromStore,
  mountM31Routes,
} from "../src/modules/31-portal/index";
import type { M17VisitForRoom } from "../src/modules/31-portal/telehealth/room-mint";
import { planDocumentUpload } from "../src/modules/31-portal/write-paths/document-upload";

// ── the header-auth test shim (the M11 `orders-routes.test.ts` precedent), extended with the portal
// session attributes M31's `actor.ts` reads (`bereavement-inject.test.ts`'s `x-test-portal-account`
// precedent, widened with a patient anchor + a session-class knob — M31 needs both). ──────────────────────
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const sessionClass = request.headers["x-test-session-class"];
  if (typeof sessionClass === "string" && sessionClass.length > 0) {
    request.context.attributes.sessionClass = sessionClass;
  }
  const portalAccount = request.headers["x-test-portal-account"];
  if (typeof portalAccount === "string" && portalAccount.length > 0) {
    request.context.attributes.portalAccountId = portalAccount;
  }
  const portalSession = request.headers["x-test-session-id"];
  if (typeof portalSession === "string" && portalSession.length > 0) {
    request.context.attributes.sessionId = portalSession;
  }
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  const engagement = request.headers["x-test-engagement"];
  if (typeof engagement === "string" && engagement.length > 0) {
    request.context.attributes.engagementId = engagement;
  }
  const portalPatient = request.headers["x-test-portal-patient"];
  if (typeof portalPatient === "string" && portalPatient.length > 0) {
    request.context.attributes.sessionPatientId = portalPatient;
  }
}

// ── fixed ids (the M15/M11-style valid-uuid-format constants) ──────────────────────────────────────────
const ORG = "org_a";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_USER_ID = "user-caregiver-1";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const GRANT_ID = "33333333-3333-4333-8333-333333333333";
const MED_ORDER_ID = "44444444-4444-4444-8444-444444444444";
const DOCUMENT_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UPLOAD_ID = "66666666-6666-4666-8666-666666666666";
const PREFERENCE_ID = "77777777-7777-4777-8777-777777777777";
const INVITATION_ID = "88888888-8888-4888-8888-888888888888";
const VISIT_ROOM_MINTED = "99999999-9999-4999-8999-999999999999";
const VISIT_ACTIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M17_VISIT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLINICIAN_MEMBERSHIP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = "2026-07-30T12:00:00.000Z";

// ── the in-memory M31 store (this file's own — `createInMemoryM31SeamStores` covers only the seven §4.3
// seam ports, not the `PortalOwnedTableOps` the §4.1 routes additionally need) ─────────────────────────────
function createFakePortalStore(): {
  readonly store: PortalStore;
  seedAccount(digest: PortalAccountDigest): void;
  seedGrant(digest: PortalAccessGrantDigest): void;
  seedVisit(digest: TelehealthVisitDigest): void;
  /** Every sealed reason the two #117 status-change routes handed the store, in call order. */
  readonly statusChangeReasons: { id: string; action: string; reasonCipher: string }[];
} {
  const accounts = new Map<string, PortalAccountDigest>();
  const grants = new Map<string, PortalAccessGrantDigest>();
  const visits = new Map<string, TelehealthVisitDigest>();
  const recording = new Map<string, { enabled: boolean; startedByUserId: string | null }>();
  /** GAP-095 — the sealed room columns + presence + vendor recording id the vendor-facing routes read. */
  const rooms = new Map<
    string,
    {
      vendorRoomIdCipher: string;
      vendorRoomUrlCipher: string;
      vendorRecordingId: string | null;
      patientLeftAt: string | null;
      clinicianLeftAt: string | null;
    }
  >();
  const statusChangeReasons: { id: string; action: string; reasonCipher: string }[] = [];

  const findActiveGrant = (
    portalAccountId: string,
    patientId: string,
  ): PortalAccessGrantDigest | null =>
    [...grants.values()].find(
      (g) =>
        g.portalAccountId === portalAccountId && g.patientId === patientId && g.revokedAt === null,
    ) ?? null;

  const store: PortalStore = {
    accounts: {
      async countByStatus() {
        const rows = [...accounts.values()];
        return {
          active: rows.filter((r) => r.status === "active").length,
          invited: rows.filter((r) => r.status === "invited").length,
          revoked: rows.filter((r) => r.status === "revoked").length,
          bereaved: rows.filter((r) => r.status === "bereaved").length,
        };
      },
      async accountsForPatient(_orgId, patientId: PatientId) {
        return [...grants.values()]
          .filter((g) => g.patientId === patientId && g.revokedAt === null)
          .map((g) => accounts.get(g.portalAccountId))
          .filter((a): a is PortalAccountDigest => a !== undefined);
      },
      async accountByUserId(_orgId, userId) {
        return [...accounts.values()].find((a) => a.userId === userId) ?? null;
      },
    },
    grants: {
      async activeGrantsForAccount(_orgId, portalAccountId) {
        return [...grants.values()].filter(
          (g) => g.portalAccountId === portalAccountId && g.revokedAt === null,
        );
      },
      async activeGrantForAccountAndPatient(_orgId, portalAccountId, patientId) {
        return findActiveGrant(portalAccountId, patientId);
      },
      async patientsWithActiveGrantsInOrg() {
        const byPatient = new Map<string, number>();
        for (const g of grants.values()) {
          if (g.revokedAt !== null) continue;
          byPatient.set(g.patientId, (byPatient.get(g.patientId) ?? 0) + 1);
        }
        return [...byPatient.entries()].map(([patientId, grantCount]) => ({
          patientId,
          grantCount,
        }));
      },
    },
    engagement: {
      async engagementForPatient(_orgId, patientId) {
        return {
          // GAP-093(d) — only the seeded patient has an account, so a view that read some OTHER id (the
          // engagement id, say) shows `false` here instead of a fixed `true`.
          hasActiveAccount: patientId === PATIENT,
          daysActive: 3,
          lastViewedAt: NOW as IsoInstant,
          messagesSent: 0,
          documentsViewed: 0,
          amendmentsSubmitted: 0,
          administrationsAttested: 0,
        };
      },
      async engagementMetricsForOrg() {
        return {
          accountsActive: accounts.size,
          accountsInvited: 0,
          accountsRevoked: 0,
          accountsBereaved: 0,
          patientsWithActiveGrant: grants.size,
          sessionsInWindow: 0,
        };
      },
    },
    telehealth: {
      async getById(_orgId, id) {
        return visits.get(id) ?? null;
      },
      async getByM17VisitId(_orgId, m17VisitId) {
        return [...visits.values()].find((v) => v.m17VisitId === m17VisitId) ?? null;
      },
      async metricsForOrg() {
        const rows = [...visits.values()];
        return {
          visitsTotal: rows.length,
          visitsCompletedClean: rows.filter((r) => r.lifecycleState === "ended_clean").length,
          visitsCompletedAborted: rows.filter((r) => r.lifecycleState === "ended_aborted").length,
          audioOnlyFallbackRate: 0,
          recordingRate: 0,
          vendorOutageDurationMin: 0,
        };
      },
      async minutesByTenant() {
        return { totalMinutes: 0, recordedMinutes: 0 };
      },
    },
    sessions: {
      async createSmartLaunchSession() {
        return { sessionId: "smart-session-1" };
      },
    },
    disclosures: {
      async disclosuresForPatient() {
        return [];
      },
    },
    async accountById(_orgId, id) {
      return accounts.get(id) ?? null;
    },
    async accountList() {
      return [...accounts.values()];
    },
    async recordLogin(_orgId, id) {
      return accounts.has(id);
    },
    async grantsForAccount(_orgId, portalAccountId) {
      return [...grants.values()].filter((g) => g.portalAccountId === portalAccountId);
    },
    async activeGrant(_orgId, portalAccountId, patientId) {
      return findActiveGrant(portalAccountId, patientId);
    },
    async suspendAccount(_orgId, _userId, id, reasonCipher) {
      const row = accounts.get(id);
      if (!row) return null;
      const updated = { ...row, status: "suspended" as const };
      accounts.set(id, updated);
      statusChangeReasons.push({ id, action: "suspend", reasonCipher });
      return updated;
    },
    async reinstateAccount(_orgId, _userId, id, reasonCipher) {
      const row = accounts.get(id);
      if (!row) return null;
      const updated = { ...row, status: "active" as const };
      accounts.set(id, updated);
      statusChangeReasons.push({ id, action: "reinstate", reasonCipher });
      return updated;
    },
    async telehealthById(_orgId, id) {
      return visits.get(id) ?? null;
    },
    async telehealthByM17VisitId(_orgId, m17VisitId) {
      return [...visits.values()].find((v) => v.m17VisitId === m17VisitId) ?? null;
    },
    async insertTelehealthVisitIfAbsent(_orgId, _userId, row) {
      if ([...visits.values()].some((v) => v.m17VisitId === row.m17VisitId)) return null;
      const digest: TelehealthVisitDigest = {
        telehealthVisitId: row.id as TelehealthVisitDigest["telehealthVisitId"],
        m17VisitId: row.m17VisitId as TelehealthVisitDigest["m17VisitId"],
        patientId: row.patientId as TelehealthVisitDigest["patientId"],
        assignedMembershipId:
          row.assignedMembershipId as TelehealthVisitDigest["assignedMembershipId"],
        lifecycleState: "room_minted",
        vendor: row.vendor,
        scheduledVisitSetting: row.scheduledVisitSetting,
        audioOnlyFallbackActive: false,
        visitStartedAt: null,
        visitEndedAt: null,
        totalDurationSec: null,
        endReason: null,
        linkedEncounterId: null,
      };
      visits.set(row.id, digest);
      rooms.set(row.id, {
        vendorRoomIdCipher: row.vendorRoomIdCipher,
        vendorRoomUrlCipher: row.vendorRoomUrlCipher,
        vendorRecordingId: null,
        patientLeftAt: null,
        clinicianLeftAt: null,
      });
      return digest;
    },
    async telehealthRoomFacts(_orgId, id) {
      if (!visits.has(id)) return null;
      return (
        rooms.get(id) ?? {
          vendorRoomIdCipher: `sealed:vendor_room_id:room-${id}`,
          vendorRoomUrlCipher: `sealed:vendor_room_url:https://vendor.invalid/room-${id}`,
          vendorRecordingId: null,
          patientLeftAt: null,
          clinicianLeftAt: null,
        }
      );
    },
    async telehealthList() {
      return [...visits.values()];
    },
    async telehealthRecordingState(_orgId, id) {
      if (!visits.has(id)) return null;
      return recording.get(id) ?? { enabled: false, startedByUserId: null };
    },
    async updateTelehealthLifecycle(_orgId, _userId, id, patch) {
      const row = visits.get(id);
      if (!row) return null;
      if (patch.recordingEnabled !== undefined || patch.recordingStartedByUserId !== undefined) {
        const prior = recording.get(id) ?? { enabled: false, startedByUserId: null };
        recording.set(id, {
          enabled: patch.recordingEnabled ?? prior.enabled,
          startedByUserId:
            patch.recordingStartedByUserId === undefined
              ? prior.startedByUserId
              : patch.recordingStartedByUserId,
        });
      }
      const priorRoom = (await store.telehealthRoomFacts("", id))!;
      rooms.set(id, {
        ...priorRoom,
        vendorRecordingId:
          patch.vendorRecordingId === undefined
            ? priorRoom.vendorRecordingId
            : patch.vendorRecordingId,
        patientLeftAt:
          patch.patientLeftAt === undefined
            ? priorRoom.patientLeftAt
            : (patch.patientLeftAt?.toISOString() ?? null),
        clinicianLeftAt:
          patch.clinicianLeftAt === undefined
            ? priorRoom.clinicianLeftAt
            : (patch.clinicianLeftAt?.toISOString() ?? null),
      });
      const updated: TelehealthVisitDigest = {
        ...row,
        lifecycleState: (patch.lifecycleState ?? row.lifecycleState) as TelehealthLifecycleState,
        audioOnlyFallbackActive: patch.audioOnlyFallbackActive ?? row.audioOnlyFallbackActive,
        visitStartedAt: patch.visitStartedAt
          ? (patch.visitStartedAt.toISOString() as IsoInstant)
          : row.visitStartedAt,
        visitEndedAt: patch.visitEndedAt
          ? (patch.visitEndedAt.toISOString() as IsoInstant)
          : row.visitEndedAt,
        endReason: (patch.endReason ?? row.endReason) as TelehealthEndReason | null,
        totalDurationSec: patch.totalDurationSec ?? row.totalDurationSec,
      };
      visits.set(id, updated);
      return updated;
    },
  };

  return {
    store,
    seedAccount: (digest) => accounts.set(digest.portalAccountId, digest),
    seedGrant: (digest) => grants.set(digest.grantId, digest),
    seedVisit: (digest) => visits.set(digest.telehealthVisitId, digest),
    statusChangeReasons,
  };
}

const SCOPE_SET: PortalScopeSet = {
  categories: {
    care_plan: true,
    medications: true,
    administrations: true,
    assessments: true,
    visits: true,
    documents: true,
    messages: true,
    supplies: true,
    triage: true,
    bereavement: true,
  },
  floorVersion: "v1",
};

const FAKE_TELEHEALTH_ADAPTER: TelehealthAdapterPort = {
  vendor: "daily_co",
  async mintParticipantToken() {
    return { token: "tok-1", expiresAt: NOW };
  },
  async endRoom() {},
  async startRecording() {
    return { vendorRecordingId: "rec-1" };
  },
  async stopRecording() {
    return { recordingUrl: "https://vendor.invalid/rec-1", durationSec: 120 };
  },
  verifyWebhookSignature() {
    return true;
  },
};

// ── server assembly (the M11/M15 `makeServer()` precedent) ─────────────────────────────────────────────
function makeServer(
  opts: {
    readonly medicationOrderRedacted?: boolean;
    readonly telehealthWebhookSignatureValid?: boolean;
    /** Make M36's care-team roster reconcile fail (the GAP-059 condition), so the send path's
     *  refusal-vs-disclosure behaviour can be asserted. */
    readonly careTeamSyncThrows?: boolean;
    /** Leave the #117 reason cipher UNBOUND, so suspend/reinstate refuse rather than record a status
     *  change with no reason. Bound by default — the composition root binds it. */
    readonly reasonCipherUnbound?: boolean;
    /** F-220 — bind the lazy room mint: the M17 visit the published reader returns, and whether the vendor
     *  adapter can `mintRoom` (absent ⇒ the fail-closed NOOP shape production has today). */
    readonly lazyMint?: { readonly visit: M17VisitForRoom | null; readonly vendorCanMint: boolean };
    /** GAP-006 — leave M5's amendment intake UNBOUND (submit/list must then refuse 503). */
    readonly amendmentIntakeUnbound?: boolean;
    /** GAP-092 — leave M13's caregiver-attestation write UNBOUND (the attest route must then refuse 503). */
    readonly caregiverAttestationUnbound?: boolean;
    /** GAP-092 — leave the provisioning services / M16 opt-out / M4 audit ports UNBOUND (503 on every write). */
    readonly provisioningUnbound?: boolean;
    /** GAP-095 — override pieces of the fake vendor adapter (spies / failures). */
    readonly telehealthAdapter?: Partial<TelehealthAdapterPort>;
    /** M31 staff-telehealth scope — what the M5 `CaseloadProvider` answers (`userId → patient ids`), or
     *  `"throws"` for an unreadable seam. Default: `staff_user` carries `PATIENT` (the seeded visits' patient). */
    readonly staffCaseload?: Readonly<Record<string, readonly string[]>> | "throws";
    /** GAP-093 — what M3's engagement reader answers for the auditor route (default: active). */
    readonly engagementActive?: boolean | "throws";
    /** GAP-093(d) — what M3's reader says the engagement COVERS (default: the one seeded patient). */
    readonly engagementCoverage?:
      | { tenantWide: boolean; patientIds: readonly string[] }
      | null
      | "throws";
  } = {},
) {
  const backend = createFakePortalStore();
  // GAP-006 — stands in for M5's `createDbPortalAmendmentIntake` (proven live in its own suite).
  const amendments: Array<{
    id: string;
    organizationId: string;
    patientId: string;
    requestedByUserId: string;
    portalAccountId: string;
    targetKind: string;
    targetRef: string;
    requestedChange: string;
  }> = [];
  const amendmentIntake = {
    async submit(input: Omit<(typeof amendments)[number], "id">) {
      const row = {
        ...input,
        id: `00000000-0000-4000-8000-${String(amendments.length + 1).padStart(12, "0")}`,
      };
      amendments.push(row);
      return { id: row.id, status: "pending" };
    },
    async listOwn(q: { organizationId: string; patientId: string; requestedByUserId: string }) {
      return amendments
        .filter(
          (a) =>
            a.organizationId === q.organizationId &&
            a.patientId === q.patientId &&
            a.requestedByUserId === q.requestedByUserId,
        )
        .map((a) => ({
          id: a.id,
          targetKind: a.targetKind,
          requestedChange: a.requestedChange,
          status: "pending",
          submittedAt: NOW,
          slaDueAt: NOW,
          decidedAt: null,
        }));
    },
  };

  // GAP-092 — stands in for M13's `buildPortalCaregiverAttestationPort` (the real write is proven in M13's suite).
  const caregiverWrites: Array<Record<string, unknown>> = [];
  const caregiverAttestation = {
    async record(input: Record<string, unknown>) {
      caregiverWrites.push(input);
      return {
        administrationId: "99999999-9999-4999-8999-999999999999",
        status: "pending_caregiver_review",
      };
    },
  };

  // GAP-092 — thin stand-ins for the provisioning services (each is proven against its own fake DB in
  // `gap-092-m31-provisioning.test.ts`); the route layer's own logic runs for real around them.
  const provisioningCalls: Array<{ op: string; input: unknown }> = [];
  const provisioning = {
    preferences: {
      async list() {
        return { channels: [{ channel: "email", enabled: true }] };
      },
      async update(input: unknown) {
        provisioningCalls.push({ op: "preferences.update", input });
        return { channels: [] };
      },
    },
    uploads: {
      async begin(input: {
        mimeType: string;
        expectedByteSize: number;
        patientDischargedReadOnly: boolean;
        organizationId: string;
        patientId: string;
        portalAccountId: string;
      }) {
        // the real §7.8 gate, so the route's 415 / 413 / 403 behaviour is still exercised end to end
        planDocumentUpload({
          orgId: input.organizationId,
          patientId: input.patientId as never,
          portalAccountId: input.portalAccountId,
          byteSize: input.expectedByteSize,
          declaredMime: input.mimeType,
          magicBytes: [],
          patientDischargedReadOnly: input.patientDischargedReadOnly,
        });
        provisioningCalls.push({ op: "uploads.begin", input });
        return {
          uploadId: UPLOAD_ID,
          contentPath: `/api/v1/portal/documents/uploads/${UPLOAD_ID}/content`,
          expiresAt: NOW,
        };
      },
      async stage(input: { bytes: Buffer }) {
        provisioningCalls.push({ op: "uploads.stage", input });
        return { uploadId: UPLOAD_ID, status: "staged" as const, byteSize: input.bytes.byteLength };
      },
      async complete(input: unknown) {
        provisioningCalls.push({ op: "uploads.complete", input });
        return {
          uploadId: UPLOAD_ID,
          status: "received" as const,
          documentId: "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0",
          intakeBatchId: "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0",
        };
      },
    },
    invitations: {
      async issue(input: { patientId: string; relationship: string }) {
        provisioningCalls.push({ op: "invitations.issue", input });
        return {
          invitationId: "11111111-aaaa-4aaa-8aaa-111111111111",
          portalAccountId: ACCOUNT,
          status: "invited" as const,
          expiresAt: NOW,
          inviteUrl: null,
        };
      },
      async list() {
        return [
          {
            invitationId: "11111111-aaaa-4aaa-8aaa-111111111111",
            relationship: "family_caregiver",
            status: "outstanding" as const,
            issuedAt: NOW,
            expiresAt: NOW,
          },
        ];
      },
      async revoke(organizationId: string, actingUserId: string, invitationId: string) {
        provisioningCalls.push({
          op: "invitations.revoke",
          input: { organizationId, actingUserId, invitationId },
        });
      },
      async accept(token: string) {
        provisioningCalls.push({ op: "invitations.accept", input: token });
        return {
          portalAccountId: ACCOUNT,
          patientId: PATIENT,
          grantKind: "family_caregiver" as const,
          status: "active" as const,
          replayed: false,
        };
      },
    },
  };
  const bereavementOptOut = {
    async optOut(input: unknown) {
      provisioningCalls.push({ op: "bereavement.optOut", input });
      return { contactsOptedOut: 1, alreadyOptedOut: 0 };
    },
  };
  const accountAudit = {
    async viewsForUser(input: unknown) {
      provisioningCalls.push({ op: "audit.views", input });
      return { items: [], nextCursor: null };
    },
  };

  backend.seedAccount({
    portalAccountId: ACCOUNT,
    userId: ACCOUNT_USER_ID,
    relationship: "family_caregiver",
    status: "active",
    activatedAt: NOW,
    lastActiveAt: NOW,
  });
  backend.seedGrant({
    grantId: GRANT_ID,
    portalAccountId: ACCOUNT,
    patientId: PATIENT,
    grantKind: "family_caregiver",
    scopeSet: SCOPE_SET,
    grantedAt: NOW,
    revokedAt: null,
  });
  backend.seedVisit({
    telehealthVisitId: VISIT_ROOM_MINTED,
    m17VisitId: M17_VISIT_ID,
    patientId: PATIENT,
    assignedMembershipId: CLINICIAN_MEMBERSHIP,
    lifecycleState: "room_minted",
    vendor: "daily_co",
    scheduledVisitSetting: "patient_home_with_video",
    audioOnlyFallbackActive: false,
    visitStartedAt: null,
    visitEndedAt: null,
    totalDurationSec: null,
    endReason: null,
    linkedEncounterId: null,
  });
  backend.seedVisit({
    telehealthVisitId: VISIT_ACTIVE,
    m17VisitId: `${M17_VISIT_ID}-active`,
    patientId: PATIENT,
    assignedMembershipId: CLINICIAN_MEMBERSHIP,
    lifecycleState: "in_progress",
    vendor: "daily_co",
    scheduledVisitSetting: "patient_home_with_video",
    audioOnlyFallbackActive: false,
    visitStartedAt: NOW,
    visitEndedAt: null,
    totalDurationSec: null,
    endReason: null,
    linkedEncounterId: null,
  });

  // seams M31 reads through `getSeam` — deny-stubs fail every OTHER read route closed to a 200-with-empty
  // view (by design, see the file banner), so only the three seams below need a real fake registered.
  __resetSeamsForTest();
  const fakeMedicationOrderProvider = {
    async getPortalMedicationSummary() {
      return {
        summary: [
          {
            medicationOrderId: MED_ORDER_ID,
            displayName: "Morphine sulfate 10mg/mL",
            instructions: "0.5mL sublingual every 4 hours as needed for pain",
            status: "active",
            isRedacted: opts.medicationOrderRedacted ?? false,
          },
        ],
      };
    },
  };
  registerSeam(
    "MedicationOrderProvider",
    fakeMedicationOrderProvider as unknown as MedicationOrderProvider,
  );
  const messagingCalls = {
    sendMessage: 0,
    listMessages: 0,
    lastListInput: null as unknown,
    lastSyncInput: null as unknown,
  };
  const fakeMessagingProvider = {
    async syncCareTeamChannel(orgId: string, patientId: string, portalUserId?: string) {
      if (opts.careTeamSyncThrows) throw new Error("care-team roster reconcile failed");
      messagingCalls.lastSyncInput = { orgId, patientId, portalUserId };
      return { channelId: "channel-1" };
    },
    async openChannel() {
      return { channelId: "channel-1" };
    },
    async sendMessage() {
      messagingCalls.sendMessage += 1;
      return { messageId: "msg-1" };
    },
    async listMessages(_orgId: string, input: unknown) {
      messagingCalls.listMessages += 1;
      messagingCalls.lastListInput = input;
      return {
        messages: [
          {
            messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            authorUserId: "caregiver_user",
            body: "Synthetic portal message",
            createdAt: NOW,
          },
        ],
      };
    },
  };
  registerSeam("MessagingProvider", fakeMessagingProvider);
  const staffCaseload = opts.staffCaseload ?? { staff_user: [PATIENT] };
  registerSeam("CaseloadProvider", {
    async isInCaseload(q: { userId: string; patientId: string }) {
      if (staffCaseload === "throws") throw new Error("caseload seam unreadable");
      return (staffCaseload[q.userId] ?? []).includes(q.patientId);
    },
    async caseloadPatientIds(q: { userId: string }) {
      if (staffCaseload === "throws") throw new Error("caseload seam unreadable");
      return staffCaseload[q.userId] ?? [];
    },
  });
  const fakeExternalGriefResourceReader: ExternalGriefResourceReader = {
    async resourcesForOrg(): Promise<readonly ExternalGriefResource[]> {
      return [];
    },
  };
  registerSeam("ExternalGriefResourceReader", fakeExternalGriefResourceReader);

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "caregiver_user",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M31_PERMISSION_KEY_LIST],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "staff_user",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M31_PERMISSION_KEY_LIST],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "staff_two",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M31_PERMISSION_KEY_LIST],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "auditor_user",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M31_PERMISSION_KEY_LIST],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "no_perms_user",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }],
    },
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server (the M11-T06 precedent — the shared registry would otherwise
  // close over a PRIOR test's backend). The six §4.7 predicates M31 owns, built over THIS backend's
  // resolver, plus a permissive `step_up_recent` stub (M3's predicate, not M31's) so the six step-up
  // routes' 2xx path is actually exercised rather than left permanently 403.
  const resolver = buildPortalAbacResolverFromStore(backend.store);
  const ports: PortalAbacPorts = {
    async consentActive() {
      return true;
    },
    async bereavedWindowOpen() {
      return true;
    },
    async primaryCaregiverUserId() {
      return ACCOUNT_USER_ID;
    },
    async patientResidenceState() {
      return "TX"; // a one-party recording-consent state — simplifies the recording-consent 2xx path
    },
    async engagementActive() {
      if (opts.engagementActive === "throws") throw new Error("engagement reader unreadable");
      return opts.engagementActive ?? true;
    },
  };
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildPortalAbacPredicates({ resolver, ports, now: () => new Date(NOW) }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async () => true);
  // M7's REAL shared `caseload_or_scope` (nine modules bind this name) over the same CaseloadProvider
  // fake — GAP-093 composes it on the staff invitation routes, so the suite must run the real rule.
  reg.register(
    "caseload_or_scope",
    buildCarePlanAbacPredicates({
      resolver: {
        async loadPlan() {
          return null;
        },
        async loadProblem() {
          return null;
        },
        async loadVersion() {
          return null;
        },
      } as never,
      isInCaseload: async (q) => {
        if (staffCaseload === "throws") throw new Error("caseload seam unreadable");
        return (staffCaseload[q.userId] ?? []).includes(q.patientId);
      },
    }).caseload_or_scope as never,
  );
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  const mintedRooms: { telehealthVisitId: string }[] = [];
  const telehealth: TelehealthAdapterPort = {
    ...(opts.telehealthWebhookSignatureValid === false
      ? { ...FAKE_TELEHEALTH_ADAPTER, verifyWebhookSignature: () => false }
      : FAKE_TELEHEALTH_ADAPTER),
    ...(opts.telehealthAdapter ?? {}),
    ...(opts.lazyMint?.vendorCanMint
      ? {
          async mintRoom(input: { telehealthVisitId: string }) {
            mintedRooms.push({ telehealthVisitId: input.telehealthVisitId });
            return { vendorRoomId: "room-xyz", vendorRoomUrl: "https://vendor.invalid/room-xyz" };
          },
        }
      : {}),
  };
  const deps: PortalRouteDeps = {
    store: backend.store,
    telehealth,
    engagementReader: {
      async engagementScope() {
        if (opts.engagementCoverage === "throws") throw new Error("engagement reader unreadable");
        return opts.engagementCoverage === undefined
          ? { tenantWide: false, patientIds: [PATIENT] }
          : opts.engagementCoverage;
      },
    },
    now: () => new Date(NOW),
    ...(opts.amendmentIntakeUnbound ? {} : { amendmentIntake }),
    ...(opts.caregiverAttestationUnbound ? {} : { caregiverAttestation }),
    ...(opts.provisioningUnbound
      ? {}
      : { provisioning: provisioning as never, bereavementOptOut, accountAudit }),
    roomCipher: {
      async encrypt(_org: string, column: string, plaintext: string) {
        return `sealed:${column}:${plaintext}`;
      },
      async decrypt(_org: string, column: string, envelope: string) {
        const prefix = `sealed:${column}:`;
        if (!envelope.startsWith(prefix)) throw new Error("foreign envelope");
        return envelope.slice(prefix.length);
      },
    },
    ...(opts.lazyMint
      ? {
          visitReader: {
            async visitForOrg(orgId: string, visitId: string) {
              const v = opts.lazyMint?.visit ?? null;
              return v && v.id === visitId && v.organizationId === orgId ? v : null;
            },
          },
        }
      : {}),
    ...(opts.reasonCipherUnbound
      ? {}
      : {
          reasonCipher: {
            async encrypt(_org, plaintext) {
              return `sealed:${plaintext}`;
            },
          },
        }),
  };
  mountM31Routes(app, deps);
  return {
    app,
    backend,
    messagingCalls,
    amendments,
    mintedRooms,
    caregiverWrites,
    provisioningCalls,
  };
}

const CAREGIVER = {
  "x-test-user": "caregiver_user",
  "x-test-org": ORG,
  "x-test-roles": "portal_caregiver",
  "x-test-session-class": "caregiver_portal",
  "x-test-portal-account": ACCOUNT,
  "x-test-portal-patient": PATIENT,
};
const CAREGIVER_NO_PATIENT_SELECTED = {
  "x-test-user": "caregiver_user",
  "x-test-org": ORG,
  "x-test-roles": "portal_caregiver",
  "x-test-session-class": "caregiver_portal",
  "x-test-portal-account": ACCOUNT,
};
const STAFF = { "x-test-user": "staff_user", "x-test-org": ORG, "x-test-roles": "registered_nurse" };
const STAFF_ORG_WIDE = { ...STAFF, "x-test-roles": "medical_director" };
const ENGAGEMENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const AUDITOR = {
  "x-test-user": "auditor_user",
  "x-test-org": ORG,
  "x-test-roles": "auditor",
  "x-test-session-class": "auditor",
  "x-test-engagement": ENGAGEMENT,
};
const NO_PERMS_CAREGIVER = {
  "x-test-user": "no_perms_user",
  "x-test-org": ORG,
  "x-test-roles": "portal_caregiver",
  "x-test-session-class": "caregiver_portal",
  "x-test-portal-account": ACCOUNT,
  "x-test-portal-patient": PATIENT,
};

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  __resetSeamsForTest();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  __resetSeamsForTest();
});

// ── §4.1 401 / 403 / 422 boundary cases ──────────────────────────────────────────────────────────────────
describe("M31 route smoke — the M1 boundary", () => {
  it("401s with no session at all", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/portal/sessions/current" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403s a permission-gated route for a portal session holding NO M31 grants", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions/current",
      headers: NO_PERMS_CAREGIVER,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("422s a malformed body from an otherwise-authorized caller (TypeBox validation, M1 envelope)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/messages/send",
      headers: { ...CAREGIVER, "idempotency-key": "k-422" },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  // Code review 2026-08-14 — the send path used to wrap `syncCareTeamChannel` in a bare `try {} catch {}`
  // and carry on. A failed roster reconcile means the `care_team` channel's membership is stale, which
  // includes clinicians M5 has since REMOVED from the care team — so swallowing the error turned a
  // reconciliation failure into a PHI disclosure. Refusing the send is the only safe outcome.
  it("REFUSES the send when the care-team roster reconcile fails (no message written)", async () => {
    const { app, messagingCalls } = makeServer({ careTeamSyncThrows: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/messages/send",
      headers: { ...CAREGIVER, "idempotency-key": "k-sync-fail" },
      payload: { body: "Is Dad's morphine dose still the same?" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(messagingCalls.sendMessage).toBe(0);
    await app.close();
  });

  it("sends normally when the roster reconcile succeeds (the fix does not break the happy path)", async () => {
    const { app, messagingCalls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/messages/send",
      headers: { ...CAREGIVER, "idempotency-key": "k-sync-ok" },
      payload: { body: "Is Dad's morphine dose still the same?" },
    });
    expect(res.statusCode).toBe(200);
    expect(messagingCalls.sendMessage).toBe(1);
    await app.close();
  });

  it("resolves portal history from the session patient and returns a narrow M36 projection", async () => {
    const { app, messagingCalls } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/messages/history?cursor=opaque&limit=12&channelId=attacker-choice",
      headers: CAREGIVER,
    });
    expect(res.statusCode).toBe(200);
    expect(messagingCalls.listMessages).toBe(1);
    expect(messagingCalls.lastSyncInput).toEqual({
      orgId: ORG,
      patientId: PATIENT,
      portalUserId: "caregiver_user",
    });
    expect(messagingCalls.lastListInput).toMatchObject({
      channelId: "channel-1",
      userId: "caregiver_user",
      cursor: "opaque",
      limit: 12,
      direction: "backward",
    });
    expect(res.json()).toEqual({
      messages: [
        {
          messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          body: "Synthetic portal message",
          sentAt: NOW,
          direction: "outgoing",
          senderLabel: "You",
        },
      ],
    });
    expect(res.body).not.toContain("authorUserId");
    await app.close();
  });
});

// ── one legitimately-authorized 2xx call per route (the bulk of the file) ──────────────────────────────
interface RouteCase {
  readonly label: string;
  readonly method: "GET" | "POST" | "PATCH";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly payload?: Record<string, unknown>;
  readonly expectStatus: number;
}

const IDEMP = (key: string) => ({ "idempotency-key": key });

const ROUTE_CASES: readonly RouteCase[] = [
  // 1–4 — the portal session surface.
  {
    label: "1 POST /portal/sessions/select-patient",
    method: "POST",
    url: "/api/v1/portal/sessions/select-patient",
    headers: CAREGIVER,
    payload: { patientId: PATIENT },
    expectStatus: 200,
  },
  {
    label: "2 GET /portal/sessions/current",
    method: "GET",
    url: "/api/v1/portal/sessions/current",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "3 POST /portal/sessions/logout",
    method: "POST",
    url: "/api/v1/portal/sessions/logout",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "4 POST /portal/sessions/step-up",
    method: "POST",
    url: "/api/v1/portal/sessions/step-up",
    headers: CAREGIVER,
    payload: { totpCode: "123456" },
    expectStatus: 200,
  },

  // 5–23 — the lay-language read surfaces (every one fails CLOSED to an empty 200 view when its upstream
  // seam is a deny-stub, EXCEPT bereavement/resources which 501s on a missing seam — see makeServer()).
  {
    label: "5 GET /portal/care-summary",
    method: "GET",
    url: "/api/v1/portal/care-summary",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "6 GET /portal/care-plan/summary",
    method: "GET",
    url: "/api/v1/portal/care-plan/summary",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "7 GET /portal/discipline-plans/summary",
    method: "GET",
    url: "/api/v1/portal/discipline-plans/summary",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "8 GET /portal/visits/upcoming",
    method: "GET",
    url: "/api/v1/portal/visits/upcoming",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "9 GET /portal/visits/history",
    method: "GET",
    url: "/api/v1/portal/visits/history",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "10 GET /portal/medications/active",
    method: "GET",
    url: "/api/v1/portal/medications/active",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "11 GET /portal/administrations/recent",
    method: "GET",
    url: "/api/v1/portal/administrations/recent",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "12 GET /portal/assessments/trend",
    method: "GET",
    url: "/api/v1/portal/assessments/trend",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "13 GET /portal/hope/timepoints",
    method: "GET",
    url: "/api/v1/portal/hope/timepoints",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "14 GET /portal/orders/non-medication",
    method: "GET",
    url: "/api/v1/portal/orders/non-medication",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "15 GET /portal/supplies/upcoming",
    method: "GET",
    url: "/api/v1/portal/supplies/upcoming",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "16 GET /portal/triage-entries",
    method: "GET",
    url: "/api/v1/portal/triage-entries",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "17 GET /portal/triage-entries/me",
    method: "GET",
    url: "/api/v1/portal/triage-entries/me",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "18 GET /portal/documents",
    method: "GET",
    url: "/api/v1/portal/documents",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "19 GET /portal/documents/:documentId/download-url",
    method: "GET",
    url: `/api/v1/portal/documents/${DOCUMENT_ID}/download-url`,
    // F-225 — no M22 reader is registered in this harness (deny-stub) ⇒ fail CLOSED: 503, never a 200 with
    // an empty url (the old behaviour, which let M4's read-audit record a read that disclosed nothing).
    headers: { ...CAREGIVER, "x-test-session-id": SESSION_ID },
    expectStatus: 503,
  },
  {
    label: "20 GET /portal/messages/channel",
    method: "GET",
    url: "/api/v1/portal/messages/channel",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "20b GET /portal/messages/history",
    method: "GET",
    url: "/api/v1/portal/messages/history?limit=30",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "21 GET /portal/notification-preferences",
    method: "GET",
    url: "/api/v1/portal/notification-preferences",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "22 GET /portal/bereavement/program",
    method: "GET",
    url: "/api/v1/portal/bereavement/program",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "23 GET /portal/bereavement/resources",
    method: "GET",
    url: "/api/v1/portal/bereavement/resources",
    headers: CAREGIVER,
    expectStatus: 200,
  },

  // 24–31 — the write surfaces.
  {
    label: "24 POST /portal/administrations/caregiver-attested",
    method: "POST",
    url: "/api/v1/portal/administrations/caregiver-attested",
    headers: { ...CAREGIVER, ...IDEMP("k24") },
    payload: {
      medicationOrderId: MED_ORDER_ID,
      administeredAt: NOW,
      administeredAmount: 0.5,
      administeredUnit: "mL",
      route: "sublingual",
      caregiverAttestationText: "Given as scheduled; patient tolerated well.",
    },
    expectStatus: 202,
  },
  {
    label: "25 POST /portal/documents/upload-init",
    method: "POST",
    url: "/api/v1/portal/documents/upload-init",
    headers: { ...CAREGIVER, ...IDEMP("k25") },
    payload: { purpose: "other", mimeType: "application/pdf", expectedByteSize: 1024 },
    expectStatus: 200,
  },
  {
    label: "26 POST /portal/documents/upload-complete/:uploadId",
    method: "POST",
    url: `/api/v1/portal/documents/upload-complete/${UPLOAD_ID}`,
    headers: { ...CAREGIVER, ...IDEMP("k26") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "27 POST /portal/amendments/submit",
    method: "POST",
    url: "/api/v1/portal/amendments/submit",
    headers: { ...CAREGIVER, ...IDEMP("k27") },
    payload: {
      targetKind: "patient_demographic",
      requestedChange: "Correct the date of birth to 1950-01-01.",
    },
    expectStatus: 202,
  },
  {
    label: "28 GET /portal/amendments",
    method: "GET",
    url: "/api/v1/portal/amendments",
    headers: CAREGIVER,
    expectStatus: 200,
  },
  {
    label: "29 POST /portal/messages/send",
    method: "POST",
    url: "/api/v1/portal/messages/send",
    headers: { ...CAREGIVER, ...IDEMP("k29") },
    payload: { body: "Hello, just checking in on dad today." },
    expectStatus: 200,
  },
  {
    label: "30 PATCH /portal/notification-preferences/:id",
    method: "PATCH",
    url: `/api/v1/portal/notification-preferences/${PREFERENCE_ID}`,
    headers: CAREGIVER,
    payload: { enabled: true },
    expectStatus: 200,
  },
  {
    label: "31 POST /portal/bereavement/opt-out",
    method: "POST",
    url: "/api/v1/portal/bereavement/opt-out",
    headers: { ...CAREGIVER, ...IDEMP("k31") },
    payload: {},
    expectStatus: 200,
  },

  // 32–40 — telehealth (portal-side join/leave, staff-side join/leave/record/end, the two vendor webhooks).
  {
    label: "32 POST /portal/telehealth/visits/:visitId/join",
    method: "POST",
    url: `/api/v1/portal/telehealth/visits/${VISIT_ROOM_MINTED}/join`,
    headers: { ...CAREGIVER, ...IDEMP("k32") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "33 POST /portal/telehealth/visits/:visitId/leave",
    method: "POST",
    url: `/api/v1/portal/telehealth/visits/${VISIT_ROOM_MINTED}/leave`,
    headers: { ...CAREGIVER, ...IDEMP("k33") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "34 POST /telehealth/visits/:visitId/join (clinician)",
    method: "POST",
    url: `/api/v1/telehealth/visits/${VISIT_ROOM_MINTED}/join`,
    headers: { ...STAFF, ...IDEMP("k34") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "35 POST /telehealth/visits/:visitId/leave (clinician)",
    method: "POST",
    url: `/api/v1/telehealth/visits/${VISIT_ROOM_MINTED}/leave`,
    headers: { ...STAFF, ...IDEMP("k35") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "36 POST /telehealth/visits/:visitId/start-recording",
    method: "POST",
    url: `/api/v1/telehealth/visits/${VISIT_ROOM_MINTED}/start-recording`,
    headers: { ...STAFF, ...IDEMP("k36") },
    payload: { acknowledgesStateRules: true, acknowledgesPatientConsent: true },
    expectStatus: 200,
  },
  {
    label: "37 POST /telehealth/visits/:visitId/stop-recording",
    method: "POST",
    url: `/api/v1/telehealth/visits/${VISIT_ROOM_MINTED}/stop-recording`,
    headers: { ...STAFF, ...IDEMP("k37") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "38 POST /telehealth/visits/:visitId/end",
    method: "POST",
    url: `/api/v1/telehealth/visits/${VISIT_ACTIVE}/end`,
    headers: { ...STAFF, ...IDEMP("k38") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "39 POST /telehealth/webhooks/daily-co",
    method: "POST",
    url: "/api/v1/telehealth/webhooks/daily-co",
    headers: {},
    payload: { type: "recording.ready" },
    expectStatus: 200,
  },
  {
    label: "40 POST /telehealth/webhooks/twilio-video",
    method: "POST",
    url: "/api/v1/telehealth/webhooks/twilio-video",
    headers: {},
    payload: { type: "recording.ready" },
    expectStatus: 200,
  },

  // 41–53 — the staff admin surface.
  {
    label: "41 POST /admin/portal-invitations",
    method: "POST",
    url: "/api/v1/admin/portal-invitations",
    headers: { ...STAFF, ...IDEMP("k41") },
    payload: {
      patientId: PATIENT,
      relationship: "family_caregiver",
      inviteeDisplayName: "Jane Roe",
      inviteeEmail: "jane.roe@example.com",
      proposedScopeSet: ["care_plan", "medications"],
    },
    expectStatus: 202,
  },
  {
    label: "42 GET /admin/portal-invitations",
    method: "GET",
    url: "/api/v1/admin/portal-invitations",
    headers: STAFF,
    expectStatus: 200,
  },
  {
    label: "43 POST /admin/portal-invitations/:id/revoke",
    method: "POST",
    url: `/api/v1/admin/portal-invitations/${INVITATION_ID}/revoke`,
    headers: { ...STAFF, ...IDEMP("k43") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "44 POST /admin/portal-accounts/:id/invite-bereaved",
    method: "POST",
    url: `/api/v1/admin/portal-accounts/${ACCOUNT}/invite-bereaved`,
    headers: { ...STAFF, ...IDEMP("k44") },
    payload: {
      bereavedContactId: PATIENT,
      inviteeDisplayName: "John Doe",
      inviteeEmail: "john.doe@example.com",
    },
    expectStatus: 202,
  },
  {
    label: "45 POST /admin/portal-accounts/:id/suspend",
    method: "POST",
    url: `/api/v1/admin/portal-accounts/${ACCOUNT}/suspend`,
    headers: { ...STAFF, ...IDEMP("k45") },
    payload: { reason: "caregiver requested account suspension" },
    expectStatus: 200,
  },
  {
    label: "46 POST /admin/portal-accounts/:id/reinstate",
    method: "POST",
    url: `/api/v1/admin/portal-accounts/${ACCOUNT}/reinstate`,
    headers: { ...STAFF, ...IDEMP("k46") },
    // Used to send `{}` and expect 200 — which is exactly the defect: the route publishes `reason` as
    // required and read nothing, so the empty body sailed through (#117).
    payload: { reason: "credential compromise resolved; access restored" },
    expectStatus: 200,
  },
  {
    label: "47 GET /admin/portal-accounts",
    method: "GET",
    url: "/api/v1/admin/portal-accounts",
    headers: STAFF,
    expectStatus: 200,
  },
  {
    label: "48 GET /admin/portal-accounts/:id/access-grants",
    method: "GET",
    url: `/api/v1/admin/portal-accounts/${ACCOUNT}/access-grants`,
    headers: STAFF,
    expectStatus: 200,
  },
  {
    label: "49 GET /admin/portal-accounts/:id/audit-views",
    method: "GET",
    url: `/api/v1/admin/portal-accounts/${ACCOUNT}/audit-views`,
    headers: STAFF,
    expectStatus: 200,
  },
  {
    label: "50 GET /admin/telehealth/visits",
    method: "GET",
    url: "/api/v1/admin/telehealth/visits",
    headers: STAFF,
    expectStatus: 200,
  },
  {
    label: "51 GET /admin/telehealth/visits/:id",
    method: "GET",
    url: `/api/v1/admin/telehealth/visits/${VISIT_ROOM_MINTED}`,
    headers: STAFF,
    expectStatus: 200,
  },
  {
    label: "52 POST /admin/telehealth/visits/:id/halt-recording",
    method: "POST",
    url: `/api/v1/admin/telehealth/visits/${VISIT_ROOM_MINTED}/halt-recording`,
    headers: { ...STAFF, ...IDEMP("k52") },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "53 GET /auditor/portal-engagement/:engagementId",
    method: "GET",
    url: `/api/v1/auditor/portal-engagement/${ENGAGEMENT}`,
    headers: AUDITOR,
    expectStatus: 200,
  },
];

describe.each(ROUTE_CASES)("M31 route smoke — $label", (c) => {
  it(`reaches its handler and returns ${c.expectStatus}`, async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: c.method,
      url: c.url,
      headers: c.headers,
      payload: c.payload,
    });
    expect(res.statusCode).toBe(c.expectStatus);
    await app.close();
  });
});

// ── the three genuine findings from grounding this file in the real route source, now fixed (see the file
//    banner) — these prove the FIX, not just document the old bug ─────────────────────────────────────────
describe("M31 route smoke — fixed findings", () => {
  it("fix #1: select-patient succeeds on a FRESH session with no patient pre-selected (was: always 403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/sessions/select-patient",
      headers: CAREGIVER_NO_PATIENT_SELECTED,
      payload: { patientId: PATIENT },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activePatientId).toBe(PATIENT);
    await app.close();
  });

  it("fix #1b: select-patient still refuses a patient the account has no active grant for (403, not a rubber stamp)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/sessions/select-patient",
      headers: CAREGIVER_NO_PATIENT_SELECTED,
      payload: { patientId: "99999999-9999-4999-8999-999999999999" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("fix #2: caregiver-attested-administration now refuses (410) an order M12 marked redacted", async () => {
    const { app } = makeServer({ medicationOrderRedacted: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/administrations/caregiver-attested",
      headers: { ...CAREGIVER, ...IDEMP("k-finding-2") },
      payload: {
        medicationOrderId: MED_ORDER_ID,
        administeredAt: NOW,
        administeredAmount: 0.5,
        administeredUnit: "mL",
        route: "sublingual",
        caregiverAttestationText: "Given as scheduled; patient tolerated well.",
      },
    });
    // Reading the real `isRedacted` field, the order is correctly seen as inactive-for-attestation.
    expect(res.statusCode).toBe(410);
    expect(res.json().error?.code ?? res.json().code).toBe("ORDER_INACTIVE");
    await app.close();
  });

  it("fix #3 / GAP-092: a valid PDF declaration passes validation (not 415) and returns the content route, not a placeholder URL", async () => {
    const { app, provisioningCalls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/documents/upload-init",
      headers: { ...CAREGIVER, ...IDEMP("k-finding-3") },
      payload: { purpose: "other", mimeType: "application/pdf", expectedByteSize: 2048 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().signedUploadUrl).toBe(
      `/api/v1/portal/documents/uploads/${res.json().uploadId}/content`,
    );
    expect(res.json().signedUploadUrl).not.toContain("invalid");
    expect(provisioningCalls[0]).toMatchObject({
      op: "uploads.begin",
      input: { portalAccountId: ACCOUNT, patientId: PATIENT, expectedByteSize: 2048 },
    });
    await app.close();
  });

  it("GAP-092: the content PUT reaches the staging service with the raw bytes; complete hands off to intake", async () => {
    const { app, provisioningCalls } = makeServer();
    const bytes = Buffer.from("%PDF-1.7 test");
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/portal/documents/uploads/${UPLOAD_ID}/content`,
      headers: { ...CAREGIVER, "content-type": "application/pdf" },
      payload: bytes,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ status: "staged", byteSize: bytes.byteLength });
    const staged = provisioningCalls.find((c) => c.op === "uploads.stage");
    expect((staged?.input as { bytes: Buffer }).bytes.equals(bytes)).toBe(true);

    const done = await app.inject({
      method: "POST",
      url: `/api/v1/portal/documents/upload-complete/${UPLOAD_ID}`,
      headers: { ...CAREGIVER, ...IDEMP("k-092-complete") },
      payload: {},
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ uploadId: UPLOAD_ID, status: "received" });
    await app.close();
  });

  it("GAP-092: every provisioning write refuses 503 when the services are unbound (no fake success)", async () => {
    const { app } = makeServer({ provisioningUnbound: true });
    const calls: Array<[string, string, Record<string, unknown>, Record<string, string>]> = [
      [
        "POST",
        "/api/v1/portal/documents/upload-init",
        { purpose: "other", mimeType: "application/pdf", expectedByteSize: 10 },
        CAREGIVER,
      ],
      ["PATCH", "/api/v1/portal/notification-preferences/sms", { enabled: true }, CAREGIVER],
      ["POST", "/api/v1/portal/bereavement/opt-out", {}, CAREGIVER],
      [
        "POST",
        "/api/v1/admin/portal-invitations/11111111-aaaa-4aaa-8aaa-111111111111/revoke",
        {},
        STAFF,
      ],
    ];
    for (const [i, [method, url, payload, headers]] of calls.entries()) {
      const res = await app.inject({
        method: method as "POST" | "PATCH",
        url,
        headers: { ...headers, ...IDEMP(`k-092-503-${i}`) },
        payload,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
    }
    await app.close();
  });

  it("GAP-092: notification-preference PATCH passes the id-or-channel and the update through", async () => {
    const { app, provisioningCalls } = makeServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/portal/notification-preferences/sms",
      headers: { ...CAREGIVER, ...IDEMP("k-092-pref") },
      payload: { enabled: true, quietHoursStartHour: 22, quietHoursEndHour: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(provisioningCalls.find((c) => c.op === "preferences.update")?.input).toMatchObject({
      portalAccountId: ACCOUNT,
      idOrChannel: "sms",
      update: { enabled: true, quietHoursStartHour: 22, quietHoursEndHour: 7 },
    });
    await app.close();
  });

  it("GAP-092: the opt-out is the M16 port's call for the SESSION's account, never a bare ok", async () => {
    const { app, provisioningCalls } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/bereavement/opt-out",
      headers: { ...CAREGIVER, ...IDEMP("k-092-optout") },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, contactsOptedOut: 1 });
    expect(provisioningCalls.find((c) => c.op === "bereavement.optOut")?.input).toMatchObject({
      portalAccountId: ACCOUNT,
    });
    await app.close();
  });

  it("GAP-092: the public accept route needs no session and hands the token to provisioning", async () => {
    const { app, provisioningCalls } = makeServer();
    const token = `${ORG}.${"A".repeat(43)}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/invitations/accept",
      headers: {},
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "active", grantKind: "family_caregiver" });
    expect(provisioningCalls.find((c) => c.op === "invitations.accept")?.input).toBe(token);
    await app.close();
  });

  it("GAP-092: caregiver-attested lands in the M13 port with the attested dose and the portal account as session", async () => {
    const { app, caregiverWrites } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/administrations/caregiver-attested",
      headers: { ...CAREGIVER, ...IDEMP("k-092-a") },
      payload: {
        medicationOrderId: MED_ORDER_ID,
        administeredAt: NOW,
        administeredAmount: 0.5,
        administeredUnit: "mL",
        route: "sublingual",
        caregiverAttestationText: "Given as scheduled; patient tolerated well.",
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "pending_caregiver_review" });
    expect(caregiverWrites).toHaveLength(1);
    expect(caregiverWrites[0]).toMatchObject({
      medicationOrderId: MED_ORDER_ID,
      caregiverSessionId: ACCOUNT,
      doseAmount: 0.5,
      doseUnit: "mL",
      route: "sublingual",
    });
    await app.close();
  });

  it("GAP-092: caregiver-attested refuses 503 when M13's write is unbound (no fake 202)", async () => {
    const { app } = makeServer({ caregiverAttestationUnbound: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/administrations/caregiver-attested",
      headers: { ...CAREGIVER, ...IDEMP("k-092-b") },
      payload: {
        medicationOrderId: MED_ORDER_ID,
        administeredAt: NOW,
        administeredAmount: 0.5,
        administeredUnit: "mL",
        route: "sublingual",
        caregiverAttestationText: "Given as scheduled; patient tolerated well.",
      },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("fix #3b: upload-init still refuses a MIME outside the allowlist (415, not a rubber stamp)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/documents/upload-init",
      headers: { ...CAREGIVER, ...IDEMP("k-finding-3b") },
      payload: { purpose: "other", mimeType: "application/zip", expectedByteSize: 2048 },
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it("fix #4: a telehealth webhook with a bad vendor signature now 401s (was: 200 with received:false, TASK-065/API-008)", async () => {
    const { app } = makeServer({ telehealthWebhookSignatureValid: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/telehealth/webhooks/daily-co",
      headers: {},
      payload: { type: "recording.ready" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ received: false });
    await app.close();
  });

  it("fix #4b: a telehealth webhook with a valid vendor signature still 200s (not a rubber stamp)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/telehealth/webhooks/daily-co",
      headers: {},
      payload: { type: "recording.ready" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    await app.close();
  });
});

describe("M31 §4.1 — the account status-change reason is read, sealed and stored (#117)", () => {
  it("suspend seals the reason and hands it to the store", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/portal-accounts/${ACCOUNT}/suspend`,
      headers: { ...STAFF, ...IDEMP("k117-a") },
      payload: { reason: "suspected credential compromise reported by the family" },
    });
    expect(res.statusCode).toBe(200);
    expect(backend.statusChangeReasons).toEqual([
      {
        id: ACCOUNT,
        action: "suspend",
        reasonCipher: "sealed:suspected credential compromise reported by the family",
      },
    ]);
  });

  it("reinstate seals its own reason — the two are not one write with two names", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/portal-accounts/${ACCOUNT}/reinstate`,
      headers: { ...STAFF, ...IDEMP("k117-b") },
      payload: { reason: "compromise investigated and closed; access restored" },
    });
    expect(res.statusCode).toBe(200);
    expect(backend.statusChangeReasons[0]?.action).toBe("reinstate");
    expect(backend.statusChangeReasons[0]?.reasonCipher).toBe(
      "sealed:compromise investigated and closed; access restored",
    );
  });

  // The regression this issue is: an empty body used to return 200 and suspend the account anyway.
  for (const [label, payload] of [
    ["an empty body", {}],
    ["a reason below the published minimum", { reason: "no" }],
  ] as const) {
    it(`refuses ${label} and changes nothing`, async () => {
      const { app, backend } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/admin/portal-accounts/${ACCOUNT}/suspend`,
        headers: { ...STAFF, ...IDEMP(`k117-${label}`) },
        payload,
      });
      expect(res.statusCode).toBe(422);
      expect(backend.statusChangeReasons).toEqual([]);
    });
  }

  it("refuses with 503 when no cipher is bound, rather than recording a status change with no reason", async () => {
    const { app, backend } = makeServer({ reasonCipherUnbound: true });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/portal-accounts/${ACCOUNT}/suspend`,
      headers: { ...STAFF, ...IDEMP("k117-unbound") },
      payload: { reason: "suspected credential compromise reported by the family" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error?.code).toBe("PORTAL_REASON_CIPHER_UNBOUND");
    // The account is untouched — a refusal, not a partial write.
    expect(backend.statusChangeReasons).toEqual([]);
  });
});

// ── F-220 (#248) — the LAZY telehealth room mint on the first clinician join of a `telephonic` visit ────
describe("M31 §4.1 — lazy telehealth room mint on clinician join (F-220)", () => {
  const M17_VISIT = "33333333-3333-4333-8333-333333333333";
  const telephonicVisit: M17VisitForRoom = {
    id: M17_VISIT,
    organizationId: ORG,
    patientId: PATIENT,
    providerEntityId: "44444444-4444-4444-8444-444444444444",
    locationId: null,
    assignedMembershipId: "55555555-5555-4555-8555-555555555555",
    visitSetting: "telephonic",
    scheduledStartedAt: NOW,
    status: "published",
  };
  const join = (app: ReturnType<typeof makeServer>["app"], key: string, id = M17_VISIT) =>
    app.inject({
      method: "POST",
      url: `/api/v1/telehealth/visits/${id}/join`,
      headers: { ...STAFF, ...IDEMP(key) },
    });

  it("mints the room on the first join, seals both columns, and is idempotent on the second join", async () => {
    const { app, backend } = makeServer({
      lazyMint: { visit: telephonicVisit, vendorCanMint: true },
    });
    const first = await join(app, "f220-a");
    expect(first.statusCode).toBe(200);
    const rooms = await backend.store.telehealthList("org_a");
    expect(rooms.filter((r) => r.m17VisitId === M17_VISIT)).toHaveLength(1);
    const minted = rooms.find((r) => r.m17VisitId === M17_VISIT);
    expect(minted?.lifecycleState).toBe("clinician_joined");
    expect(minted?.scheduledVisitSetting).toBe("telephonic");

    // The second join — by the M17 id again, then by the now-existing telehealth id — mints nothing new.
    expect((await join(app, "f220-b")).statusCode).toBe(200);
    expect((await join(app, "f220-c", minted?.telehealthVisitId)).statusCode).toBe(200);
    expect(
      (await backend.store.telehealthList("org_a")).filter((r) => r.m17VisitId === M17_VISIT),
    ).toHaveLength(1);
  });

  it("404s for a visit that is not telephonic, is terminal, or is unknown — and writes no row", async () => {
    for (const visit of [
      { ...telephonicVisit, visitSetting: "patient_home" },
      { ...telephonicVisit, status: "cancelled" },
      null,
    ]) {
      const { app, backend } = makeServer({ lazyMint: { visit, vendorCanMint: true } });
      expect((await join(app, "f220-ne")).statusCode).toBe(404);
      expect(
        (await backend.store.telehealthList("org_a")).some((r) => r.m17VisitId === M17_VISIT),
      ).toBe(false);
    }
  });

  it("fails CLOSED with 503 when no vendor adapter can mint (production today) — no half-written row", async () => {
    const { app, backend } = makeServer({
      lazyMint: { visit: telephonicVisit, vendorCanMint: false },
    });
    const res = await join(app, "f220-503");
    expect(res.statusCode).toBe(503);
    expect(res.json().error?.code).toBe("TELEHEALTH_VENDOR_UNAVAILABLE");
    expect(
      (await backend.store.telehealthList("org_a")).some((r) => r.m17VisitId === M17_VISIT),
    ).toBe(false);
  });

  it("without the lazy-mint deps bound, an unknown id is still a plain 404 (behaviour unchanged)", async () => {
    const { app } = makeServer();
    expect((await join(app, "f220-legacy")).statusCode).toBe(404);
  });

  it("never mints for a visit of another tenant", async () => {
    const { app, backend } = makeServer({
      lazyMint: { visit: { ...telephonicVisit, organizationId: "org_b" }, vendorCanMint: true },
    });
    expect((await join(app, "f220-xorg")).statusCode).toBe(404);
    expect(
      (await backend.store.telehealthList("org_a")).some((r) => r.m17VisitId === M17_VISIT),
    ).toBe(false);
  });
});

// F-225 (#248) — the download route: governed-version resolution, the session-sourced mint args, and the
// ONE indistinguishable refusal. (The §164.528 `document_access_log` row + the M4 read-audit row are proven
// against real Postgres in `f225-portal-document-access-log.live.test.ts`.)
describe("M31 download-url — F-225", () => {
  const VERSION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const URL_ = `/api/v1/portal/documents/${DOCUMENT_ID}/download-url`;
  const HEADERS = { ...CAREGIVER, "x-test-session-id": SESSION_ID };

  function bindReader(opts: {
    resolve?: () => Promise<{ documentVersionId: string } | null>;
    mint?: () => Promise<{ url: string; expiresAt: string } | { denied: true; reason: string }>;
  }) {
    const calls: { resolve: unknown[]; mint: unknown[] } = { resolve: [], mint: [] };
    registerSeam("PortalDocumentReader", {
      async documentsForPatient() {
        return [];
      },
      async resolvePortalDocumentVersion(args: unknown) {
        calls.resolve.push(args);
        return opts.resolve ? opts.resolve() : { documentVersionId: VERSION_ID };
      },
      async mintPortalDownloadUrl(args: unknown) {
        calls.mint.push(args);
        return opts.mint
          ? opts.mint()
          : { url: "https://objects.example/x?sig=1", expiresAt: "2026-07-30T13:00:00.000Z" };
      },
    } as never);
    return calls;
  }

  it("resolves the governed version, mints with the SESSION's account/session/patient, and returns the url", async () => {
    const { app } = makeServer();
    const calls = bindReader({});
    const res = await app.inject({ method: "GET", url: URL_, headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      url: "https://objects.example/x?sig=1",
      expiresAt: "2026-07-30T13:00:00.000Z",
      patientId: PATIENT,
    });
    expect(calls.resolve).toEqual([
      { organizationId: ORG, patientId: PATIENT, documentId: DOCUMENT_ID },
    ]);
    expect(calls.mint).toEqual([
      {
        organizationId: ORG,
        patientId: PATIENT,
        documentVersionId: VERSION_ID,
        portalAccountId: ACCOUNT,
        portalSessionId: SESSION_ID,
      },
    ]);
    await app.close();
  });

  it("an unresolvable document, a denial and a malformed id are ALL the same 404 (no gate oracle) and never a 200", async () => {
    for (const [resolve, mint, url] of [
      [async () => null, undefined, URL_],
      [undefined, async () => ({ denied: true as const, reason: "not_owner" }), URL_],
      [undefined, async () => ({ denied: true as const, reason: "sud_consent_absent" }), URL_],
      [undefined, undefined, "/api/v1/portal/documents/not-a-uuid/download-url"],
    ] as const) {
      const { app } = makeServer();
      const calls = bindReader({ resolve, mint });
      const res = await app.inject({ method: "GET", url, headers: HEADERS });
      expect(res.statusCode).toBe(404);
      expect(res.json().url).toBeUndefined();
      if (url !== URL_) expect(calls.mint).toEqual([]);
      await app.close();
    }
  });

  it("a mint/ledger failure is a 503, not a 200 with an empty url", async () => {
    const { app } = makeServer();
    bindReader({
      mint: async () => {
        throw new Error("ledger down");
      },
    });
    const res = await app.inject({ method: "GET", url: URL_, headers: HEADERS });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("a portal session with no session id is refused (403) before any M22 call", async () => {
    const { app } = makeServer();
    const calls = bindReader({});
    const res = await app.inject({ method: "GET", url: URL_, headers: CAREGIVER });
    expect(res.statusCode).toBe(403);
    expect(calls.resolve).toEqual([]);
    await app.close();
  });
});

describe("GAP-006 — portal §164.526 amendment submit reaches M5", () => {
  const submit = {
    targetKind: "patient_demographic",
    requestedChange: "Correct the date of birth to 1950-01-01.",
  };

  it("submit creates exactly one M5 amendment row and returns its real id; the list reads it back", async () => {
    const { app, amendments } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/amendments/submit",
      headers: { ...CAREGIVER, ...IDEMP("gap006-a") },
      payload: submit,
    });
    expect(res.statusCode).toBe(202);
    expect(amendments).toHaveLength(1);
    expect(amendments[0]).toMatchObject({
      organizationId: ORG,
      patientId: PATIENT,
      requestedByUserId: "caregiver_user",
      portalAccountId: ACCOUNT,
      requestedChange: submit.requestedChange,
    });
    expect(res.json()).toEqual({ amendmentRequestRefId: amendments[0]?.id, status: "pending" });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/portal/amendments",
      headers: CAREGIVER,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([
      expect.objectContaining({ id: amendments[0]?.id, requestedChange: submit.requestedChange }),
    ]);
    await app.close();
  });

  it("a retried submit under the same Idempotency-Key replays the first answer — one M5 row, not two", async () => {
    const { app, amendments } = makeServer();
    const send = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/portal/amendments/submit",
        headers: { ...CAREGIVER, ...IDEMP("gap006-retry") },
        payload: submit,
      });
    const first = await send();
    const retry = await send();
    expect(first.statusCode).toBe(202);
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual(first.json());
    expect(amendments).toHaveLength(1);
    await app.close();
  });

  it("a demographic amendment targets the SESSION patient — another id in targetRef → 422, nothing stored", async () => {
    const { app, amendments } = makeServer();
    const foreign = await app.inject({
      method: "POST",
      url: "/api/v1/portal/amendments/submit",
      headers: { ...CAREGIVER, ...IDEMP("gap006-demo-foreign") },
      payload: { ...submit, targetRef: "99999999-9999-4999-8999-999999999999" },
    });
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json().error.code).toBe("AMENDMENT_TARGET_INVALID");
    expect(amendments).toHaveLength(0);

    const own = await app.inject({
      method: "POST",
      url: "/api/v1/portal/amendments/submit",
      headers: { ...CAREGIVER, ...IDEMP("gap006-demo-own") },
      payload: submit,
    });
    expect(own.statusCode).toBe(202);
    expect(amendments[0]?.targetRef).toBe(PATIENT); // a verified ref, not a free-form label
    await app.close();
  });

  describe("encounter_narrative — targetRef must be one of the session patient's signed encounters (M8)", () => {
    const OWN_ENCOUNTER = "33333333-3333-4333-8333-333333333301";
    const OTHER_PATIENTS_ENCOUNTER = "33333333-3333-4333-8333-333333333302";
    const narrative = (targetRef?: string) => ({
      targetKind: "encounter_narrative",
      requestedChange: "The visit note says I fell; I did not fall.",
      ...(targetRef ? { targetRef } : {}),
    });
    const bindEncounterReader = () =>
      registerSeam("SignedEncountersReader", {
        async signedEncountersForPatientSince(_org: string, patientId: string) {
          // Only the session patient's encounters come back; the other id belongs to someone else.
          return patientId === PATIENT ? [{ encounterId: OWN_ENCOUNTER, patientId: PATIENT }] : [];
        },
      } as never);

    it("the session patient's own encounter → 202, stored as the verified targetRef", async () => {
      const { app, amendments } = makeServer();
      bindEncounterReader();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/portal/amendments/submit",
        headers: { ...CAREGIVER, ...IDEMP("gap006-n-own") },
        payload: narrative(OWN_ENCOUNTER),
      });
      expect(res.statusCode).toBe(202);
      expect(amendments[0]).toMatchObject({
        targetKind: "encounter_narrative",
        targetRef: OWN_ENCOUNTER,
      });
      await app.close();
    });

    it("another patient's encounter → 422, nothing stored", async () => {
      const { app, amendments } = makeServer();
      bindEncounterReader();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/portal/amendments/submit",
        headers: { ...CAREGIVER, ...IDEMP("gap006-n-foreign") },
        payload: narrative(OTHER_PATIENTS_ENCOUNTER),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("AMENDMENT_TARGET_INVALID");
      expect(amendments).toHaveLength(0);
      await app.close();
    });

    it("no visit named (the portal form has no picker) → stored against the session patient, not unverified", async () => {
      const { app, amendments } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/portal/amendments/submit",
        headers: { ...CAREGIVER, ...IDEMP("gap006-n-none") },
        payload: narrative(),
      });
      expect(res.statusCode).toBe(202);
      expect(amendments[0]).toMatchObject({
        targetKind: "encounter_narrative",
        targetRef: PATIENT,
      });
      await app.close();
    });

    it("M8's reader unavailable → 503, never an unverified row", async () => {
      const { app, amendments } = makeServer(); // no SignedEncountersReader bound → deny-stub throws
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/portal/amendments/submit",
        headers: { ...CAREGIVER, ...IDEMP("gap006-n-down") },
        payload: narrative(OWN_ENCOUNTER),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("AMENDMENT_TARGET_UNVERIFIABLE");
      expect(amendments).toHaveLength(0);
      await app.close();
    });
  });

  it("with no M5 intake bound, submit and list refuse 503 — never a fake 'submitted'", async () => {
    const { app } = makeServer({ amendmentIntakeUnbound: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/amendments/submit",
      headers: { ...CAREGIVER, ...IDEMP("gap006-b") },
      payload: submit,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("AMENDMENT_INTAKE_UNAVAILABLE");
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/portal/amendments",
      headers: CAREGIVER,
    });
    expect(list.statusCode).toBe(503);
    await app.close();
  });
});

// ── GAP-094: portal telehealth join/leave is bound to the SESSION's granted patient ─────────────────────────
describe("M31 telehealth — portal join/leave authorization (GAP-094)", () => {
  const OTHER_PATIENT = "33333333-3333-4333-8333-333333333333";
  const OTHER_VISIT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const seedOtherPatientVisit = (backend: ReturnType<typeof makeServer>["backend"]): void =>
    backend.seedVisit({
      telehealthVisitId: OTHER_VISIT,
      m17VisitId: `${M17_VISIT_ID}-other`,
      patientId: OTHER_PATIENT,
      assignedMembershipId: CLINICIAN_MEMBERSHIP,
      lifecycleState: "room_minted",
      vendor: "daily_co",
      scheduledVisitSetting: "patient_home_with_video",
      audioOnlyFallbackActive: false,
      visitStartedAt: null,
      visitEndedAt: null,
      totalDurationSec: null,
      endReason: null,
      linkedEncounterId: null,
    });

  it.each(["join", "leave"])(
    "404s a portal %s of ANOTHER patient's visit in the same org and leaves its lifecycle untouched",
    async (verb) => {
      const { app, backend } = makeServer();
      seedOtherPatientVisit(backend);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/portal/telehealth/visits/${OTHER_VISIT}/${verb}`,
        headers: { ...CAREGIVER, ...IDEMP(`k-094-${verb}`) },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect((await backend.store.telehealthById(ORG, OTHER_VISIT))?.lifecycleState).toBe(
        "room_minted",
      );
      await app.close();
    },
  );

  it.each(["join", "leave"])(
    "refuses a portal %s when the session has no selected patient",
    async (verb) => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/portal/telehealth/visits/${VISIT_ROOM_MINTED}/${verb}`,
        headers: { ...CAREGIVER_NO_PATIENT_SELECTED, ...IDEMP(`k-094-np-${verb}`) },
        payload: {},
      });
      expect([403, 404]).toContain(res.statusCode);
      await app.close();
    },
  );

  it("refuses a portal join once the grant is revoked (ABAC_GRANT on the route)", async () => {
    const { app, backend } = makeServer();
    backend.seedGrant({
      grantId: GRANT_ID,
      portalAccountId: ACCOUNT,
      patientId: PATIENT,
      grantKind: "family_caregiver",
      scopeSet: SCOPE_SET,
      grantedAt: NOW,
      revokedAt: NOW,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/portal/telehealth/visits/${VISIT_ROOM_MINTED}/join`,
      headers: { ...CAREGIVER, ...IDEMP("k-094-revoked") },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect((await backend.store.telehealthById(ORG, VISIT_ROOM_MINTED))?.lifecycleState).toBe(
      "room_minted",
    );
    await app.close();
  });

  it("still lets the granted patient's own session join its own visit", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/portal/telehealth/visits/${VISIT_ROOM_MINTED}/join`,
      headers: { ...CAREGIVER, ...IDEMP("k-094-own") },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ── M31 (adjacent to GAP-094): the STAFF telehealth routes are scoped to the visit's STORED patient ────────
describe("M31 telehealth — staff join/leave/record/end authorization (caseload_or_scope)", () => {
  const OTHER_PATIENT = "33333333-3333-4333-8333-333333333333";
  const OTHER_VISIT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const ABSENT_VISIT = "dddddddd-dddd-4ddd-8ddd-eeeeeeeeeeee";
  const seedOtherPatientVisit = (backend: ReturnType<typeof makeServer>["backend"]): void =>
    backend.seedVisit({
      telehealthVisitId: OTHER_VISIT,
      m17VisitId: `${M17_VISIT_ID}-other`,
      patientId: OTHER_PATIENT,
      assignedMembershipId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      lifecycleState: "room_minted",
      vendor: "daily_co",
      scheduledVisitSetting: "patient_home_with_video",
      audioOnlyFallbackActive: false,
      visitStartedAt: null,
      visitEndedAt: null,
      totalDurationSec: null,
      endReason: null,
      linkedEncounterId: null,
    });
  const post = (
    app: ReturnType<typeof makeServer>["app"],
    verb: string,
    id: string,
    key: string,
    headers: Record<string, string> = STAFF,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/telehealth/visits/${id}/${verb}`,
      headers: { ...headers, ...IDEMP(key) },
      payload:
        verb === "start-recording"
          ? { acknowledgesStateRules: true, acknowledgesPatientConsent: true }
          : {},
    });

  it.each(["join", "leave", "stop-recording", "end"])(
    "404s a staff %s of a visit whose patient is NOT on the caller's caseload, changing nothing",
    async (verb) => {
      const { app, backend } = makeServer();
      seedOtherPatientVisit(backend);
      const res = await post(app, verb, OTHER_VISIT, `k-staff-x-${verb}`);
      expect(res.statusCode).toBe(404);
      expect((await backend.store.telehealthById(ORG, OTHER_VISIT))?.lifecycleState).toBe(
        "room_minted",
      );
      await app.close();
    },
  );

  it("404s a staff start-recording of a cross-patient visit and starts no recording", async () => {
    const { app, backend } = makeServer();
    seedOtherPatientVisit(backend);
    const res = await post(app, "start-recording", OTHER_VISIT, "k-staff-x-rec");
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("answers an ABSENT visit and a foreign one identically (404, same body shape)", async () => {
    const { app, backend } = makeServer();
    seedOtherPatientVisit(backend);
    const absent = await post(app, "join", ABSENT_VISIT, "k-staff-absent");
    const foreign = await post(app, "join", OTHER_VISIT, "k-staff-foreign");
    expect(absent.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error?.code).toBe(absent.json().error?.code);
    await app.close();
  });

  it("lets a caseload clinician join and leave their OWN patient's visit", async () => {
    const { app, backend } = makeServer();
    const joined = await post(app, "join", VISIT_ROOM_MINTED, "k-staff-own-j");
    expect(joined.statusCode).toBe(200);
    expect((await backend.store.telehealthById(ORG, VISIT_ROOM_MINTED))?.lifecycleState).toBe(
      "clinician_joined",
    );
    expect((await post(app, "leave", VISIT_ROOM_MINTED, "k-staff-own-l")).statusCode).toBe(200);
    await app.close();
  });

  it("lets an org-wide role join a visit with no caseload lookup at all", async () => {
    const { app, backend } = makeServer({ staffCaseload: "throws" });
    seedOtherPatientVisit(backend);
    const res = await post(app, "join", OTHER_VISIT, "k-staff-wide", STAFF_ORG_WIDE);
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("lets the visit's ASSIGNED clinician in without a caseload row", async () => {
    const { app, backend } = makeServer({ staffCaseload: {} });
    seedOtherPatientVisit(backend);
    const res = await post(app, "join", OTHER_VISIT, "k-staff-assigned", {
      ...STAFF,
      "x-test-membership": "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it.each(["join", "leave", "end", "stop-recording"])(
    "fails CLOSED (404) on %s when the caseload seam throws",
    async (verb) => {
      const { app, backend } = makeServer({ staffCaseload: "throws" });
      const res = await post(app, verb, VISIT_ROOM_MINTED, `k-staff-throw-${verb}`);
      expect(res.statusCode).toBe(404);
      expect((await backend.store.telehealthById(ORG, VISIT_ROOM_MINTED))?.lifecycleState).toBe(
        "room_minted",
      );
      await app.close();
    },
  );

  describe("lazy mint by M17 visit id", () => {
    const M17_VISIT = "33333333-3333-4333-8333-333333333334";
    const telephonic: M17VisitForRoom = {
      id: M17_VISIT,
      organizationId: ORG,
      patientId: OTHER_PATIENT,
      providerEntityId: "44444444-4444-4444-8444-444444444444",
      locationId: null,
      assignedMembershipId: "55555555-5555-4555-8555-555555555555",
      visitSetting: "telephonic",
      scheduledStartedAt: NOW,
      status: "published",
    };

    it("mints NO room and writes NO row for an in-org visit of a patient outside the caller's caseload", async () => {
      const { app, backend, mintedRooms } = makeServer({
        lazyMint: { visit: telephonic, vendorCanMint: true },
      });
      const res = await post(app, "join", M17_VISIT, "k-staff-lazy-x");
      expect(res.statusCode).toBe(404);
      expect(mintedRooms).toHaveLength(0);
      expect(
        (await backend.store.telehealthList(ORG)).some((r) => r.m17VisitId === M17_VISIT),
      ).toBe(false);
      await app.close();
    });

    it("still mints for a caller whose caseload holds that visit's patient", async () => {
      const { app, mintedRooms } = makeServer({
        lazyMint: { visit: telephonic, vendorCanMint: true },
        staffCaseload: { staff_user: [OTHER_PATIENT] },
      });
      const res = await post(app, "join", M17_VISIT, "k-staff-lazy-ok");
      expect(res.statusCode).toBe(200);
      expect(mintedRooms).toHaveLength(1);
      await app.close();
    });
  });
});

// ── GAP-093: staff invitations are caseload-scoped, stop-recording is starter-only, the auditor view is
//    engagement-scoped ──────────────────────────────────────────────────────────────────────────────────
describe("M31 GAP-093 — staff invitation routes (caseload_or_scope over a resolved patient)", () => {
  const OTHER_PATIENT = "33333333-3333-4333-8333-333333333333";
  const issueBody = (patientId: string) => ({
    patientId,
    relationship: "family_caregiver",
    inviteeDisplayName: "Jane Roe",
    inviteeEmail: "jane.roe@example.com",
    proposedScopeSet: ["care_plan"],
  });
  const issue = (
    app: ReturnType<typeof makeServer>["app"],
    patientId: string,
    key: string,
    headers: Record<string, string> = STAFF,
  ) =>
    app.inject({
      method: "POST",
      url: "/api/v1/admin/portal-invitations",
      headers: { ...headers, ...IDEMP(key) },
      payload: issueBody(patientId),
    });
  const inviteBereaved = (
    app: ReturnType<typeof makeServer>["app"],
    accountId: string,
    key: string,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/admin/portal-accounts/${accountId}/invite-bereaved`,
      headers: { ...STAFF, ...IDEMP(key) },
      payload: {
        bereavedContactId: PATIENT,
        inviteeDisplayName: "John Doe",
        inviteeEmail: "john.doe@example.com",
      },
    });

  it("404s an invitation for a patient OFF the caller's caseload", async () => {
    const { app } = makeServer();
    expect((await issue(app, OTHER_PATIENT, "k093-i1")).statusCode).toBe(404);
    await app.close();
  });

  it("202s an invitation for a patient ON the caller's caseload", async () => {
    const { app } = makeServer();
    expect((await issue(app, PATIENT, "k093-i2")).statusCode).toBe(202);
    await app.close();
  });

  it("202s an org-wide role for any patient, with no caseload lookup", async () => {
    const { app } = makeServer({ staffCaseload: "throws" });
    expect((await issue(app, OTHER_PATIENT, "k093-i3", STAFF_ORG_WIDE)).statusCode).toBe(202);
    await app.close();
  });

  it("fails CLOSED (404) when the caseload seam throws", async () => {
    const { app } = makeServer({ staffCaseload: "throws" });
    expect((await issue(app, PATIENT, "k093-i4")).statusCode).toBe(404);
    await app.close();
  });

  it("is not satisfiable by a break-glass grant (a mutating route)", async () => {
    const { app } = makeServer();
    setBreakGlassChecker(() => ({ eventId: "bg-1" }));
    try {
      const res = await issue(app, OTHER_PATIENT, "k093-i5");
      expect(res.statusCode).toBe(404);
    } finally {
      resetBreakGlassChecker();
      await app.close();
    }
  });

  it("invite-bereaved: resolves the patient from the ACCOUNT'S grants, never the body", async () => {
    const onCaseload = makeServer();
    expect((await inviteBereaved(onCaseload.app, ACCOUNT, "k093-b1")).statusCode).toBe(202);
    await onCaseload.app.close();

    const offCaseload = makeServer({ staffCaseload: { staff_user: [OTHER_PATIENT] } });
    expect((await inviteBereaved(offCaseload.app, ACCOUNT, "k093-b2")).statusCode).toBe(404);
    await offCaseload.app.close();
  });

  it("invite-bereaved: an absent account, or one with no grants, is a 404", async () => {
    const { app } = makeServer();
    const absent = "99999999-0000-4000-8000-999999999999";
    expect((await inviteBereaved(app, absent, "k093-b3")).statusCode).toBe(404);
    await app.close();
  });
});

describe("M31 GAP-093 — stop-recording is starter-only", () => {
  const startAs = (app: ReturnType<typeof makeServer>["app"], user: string, key: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/telehealth/visits/${VISIT_ROOM_MINTED}/start-recording`,
      headers: { ...STAFF, "x-test-user": user, ...IDEMP(key) },
      payload: { acknowledgesStateRules: true, acknowledgesPatientConsent: true },
    });
  const stopAs = (app: ReturnType<typeof makeServer>["app"], user: string, key: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/telehealth/visits/${VISIT_ROOM_MINTED}/stop-recording`,
      headers: { ...STAFF, "x-test-user": user, ...IDEMP(key) },
      payload: {},
    });
  const both = { staff_user: [PATIENT], staff_two: [PATIENT] };

  it("lets the clinician who started the recording stop it", async () => {
    const { app, backend } = makeServer({ staffCaseload: both });
    expect((await startAs(app, "staff_user", "k093-s1")).statusCode).toBe(200);
    expect((await stopAs(app, "staff_user", "k093-s2")).statusCode).toBe(200);
    expect((await backend.store.telehealthRecordingState(ORG, VISIT_ROOM_MINTED))?.enabled).toBe(
      false,
    );
    await app.close();
  });

  it("403s a DIFFERENT caseload clinician stopping it, leaving the recording on", async () => {
    const { app, backend } = makeServer({ staffCaseload: both });
    expect((await startAs(app, "staff_user", "k093-s3")).statusCode).toBe(200);
    expect((await stopAs(app, "staff_two", "k093-s4")).statusCode).toBe(403);
    expect((await backend.store.telehealthRecordingState(ORG, VISIT_ROOM_MINTED))?.enabled).toBe(
      true,
    );
    await app.close();
  });

  it("records the starter from the SESSION, not the body", async () => {
    const { app, backend } = makeServer({ staffCaseload: both });
    await startAs(app, "staff_two", "k093-s5");
    expect(
      (await backend.store.telehealthRecordingState(ORG, VISIT_ROOM_MINTED))?.startedByUserId,
    ).toBe("staff_two");
    await app.close();
  });

  it("is an idempotent 200 when nothing is recording, for any in-scope clinician", async () => {
    const { app } = makeServer({ staffCaseload: both });
    expect((await stopAs(app, "staff_two", "k093-s6")).statusCode).toBe(200);
    await app.close();
  });

  it("an unknown starter falls back to the visit's ASSIGNED clinician only", async () => {
    const { app, backend } = makeServer({ staffCaseload: both });
    await backend.store.updateTelehealthLifecycle(ORG, "seed", VISIT_ROOM_MINTED, {
      recordingEnabled: true,
      recordingRequested: true,
    });
    expect((await stopAs(app, "staff_two", "k093-s7")).statusCode).toBe(403);
    const assigned = await app.inject({
      method: "POST",
      url: `/api/v1/telehealth/visits/${VISIT_ROOM_MINTED}/stop-recording`,
      headers: { ...STAFF, "x-test-membership": CLINICIAN_MEMBERSHIP, ...IDEMP("k093-s8") },
      payload: {},
    });
    expect(assigned.statusCode).toBe(200);
    await app.close();
  });
});

describe("M31 — ending a recording drops recording_requested with recording_enabled", () => {
  // The DB CHECK telehealth_visit_recording_requires_enabled refuses `requested` without `enabled`; the
  // in-memory store cannot enforce it, so pin the patch the routes send.
  it("stop-recording patches recordingEnabled:false AND recordingRequested:false", async () => {
    const { app, backend } = makeServer({ staffCaseload: { staff_user: [PATIENT] } });
    const spy = vi.spyOn(backend.store, "updateTelehealthLifecycle");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/telehealth/visits/${VISIT_ROOM_MINTED}/stop-recording`,
      headers: { ...STAFF, ...IDEMP("k-rr-stop") },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      ORG,
      expect.anything(),
      VISIT_ROOM_MINTED,
      expect.objectContaining({ recordingEnabled: false, recordingRequested: false }),
    );
    await app.close();
  });

  it("admin halt-recording patches recordingEnabled:false AND recordingRequested:false", async () => {
    const { app, backend } = makeServer();
    const spy = vi.spyOn(backend.store, "updateTelehealthLifecycle");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/telehealth/visits/${VISIT_ROOM_MINTED}/halt-recording`,
      headers: { ...STAFF, ...IDEMP("k-rr-halt") },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      ORG,
      expect.anything(),
      VISIT_ROOM_MINTED,
      expect.objectContaining({ recordingEnabled: false, recordingRequested: false }),
    );
    await app.close();
  });
});

describe("M31 GAP-093 — auditor engagement view is engagement-scoped", () => {
  const get = (
    app: ReturnType<typeof makeServer>["app"],
    id: string,
    headers: Record<string, string> = AUDITOR,
  ) => app.inject({ method: "GET", url: `/api/v1/auditor/portal-engagement/${id}`, headers });

  it("200s an auditor inside the active engagement the route names", async () => {
    const { app } = makeServer();
    expect((await get(app, ENGAGEMENT)).statusCode).toBe(200);
    await app.close();
  });

  it("returns ONLY the covered patients' data (GAP-093(d))", async () => {
    const { app } = makeServer();
    const res = await get(app, ENGAGEMENT);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasActiveAccount: true, daysActive: 3 });
    await app.close();
  });

  it("does not read the engagement id as a patient, nor patients outside the engagement", async () => {
    const OTHER_PATIENT = "99999999-0000-4000-8000-999999999999";
    const { app } = makeServer({
      engagementCoverage: { tenantWide: false, patientIds: [OTHER_PATIENT] },
    });
    const res = await get(app, ENGAGEMENT);
    expect(res.statusCode).toBe(200);
    expect(res.json().hasActiveAccount).toBe(false); // PATIENT is not covered ⇒ not read
    await app.close();
  });

  it("403s when M3 says the engagement is not live, and fails CLOSED when the coverage read throws", async () => {
    for (const engagementCoverage of [null, "throws"] as const) {
      const { app } = makeServer({ engagementCoverage });
      expect((await get(app, ENGAGEMENT)).statusCode).toBe(403);
      await app.close();
    }
  });

  it("403s an auditor naming a DIFFERENT engagement than their session's", async () => {
    const { app } = makeServer();
    expect((await get(app, "ffffffff-0000-4000-8000-ffffffffffff")).statusCode).toBe(403);
    await app.close();
  });

  it("403s an auditor whose engagement is not active (closed / outside its window)", async () => {
    const { app } = makeServer({ engagementActive: false });
    expect((await get(app, ENGAGEMENT)).statusCode).toBe(403);
    await app.close();
  });

  it("fails CLOSED (403) when the engagement reader throws", async () => {
    const { app } = makeServer({ engagementActive: "throws" });
    expect((await get(app, ENGAGEMENT)).statusCode).toBe(403);
    await app.close();
  });

  it("403s a session that carries no engagement anchor", async () => {
    const { app } = makeServer();
    const { "x-test-engagement": _drop, ...noAnchor } = AUDITOR;
    expect((await get(app, ENGAGEMENT, noAnchor)).statusCode).toBe(403);
    await app.close();
  });

  it("403s a STAFF session on the auditor route even in the same org", async () => {
    const { app } = makeServer();
    expect((await get(app, ENGAGEMENT, STAFF)).statusCode).toBe(403);
    await app.close();
  });
});

describe("M31 telehealth — the lifecycle reaches the vendor (GAP-095)", () => {
  const postStaff = (
    app: ReturnType<typeof makeServer>["app"],
    verb: string,
    key: string,
    payload: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/telehealth/visits/${VISIT_ROOM_MINTED}/${verb}`,
      headers: { ...STAFF, ...IDEMP(key) },
      payload,
    });

  it("join returns the DECRYPTED vendor room url, not a placeholder", async () => {
    const { app } = makeServer();
    const res = await postStaff(app, "join", "k095-join");
    expect(res.statusCode).toBe(200);
    expect(res.json().vendorJoinUrl).toBe(`https://vendor.invalid/room-${VISIT_ROOM_MINTED}`);
    expect(res.json().vendorJoinUrl).not.toContain("telehealth.invalid");
    await app.close();
  });

  it("join refuses 503 and leaves the lifecycle untouched when the token cannot be minted", async () => {
    const { app, backend } = makeServer({
      telehealthAdapter: {
        async mintParticipantToken() {
          throw new Error("vendor down");
        },
      },
    });
    const res = await postStaff(app, "join", "k095-join-down");
    expect(res.statusCode).toBe(503);
    expect((await backend.store.telehealthById(ORG, VISIT_ROOM_MINTED))?.lifecycleState).toBe(
      "room_minted",
    );
    await app.close();
  });

  it("join refuses 503 for the fail-closed NOOP shape (empty token) instead of returning a dead room", async () => {
    const { app, backend } = makeServer({
      telehealthAdapter: {
        async mintParticipantToken() {
          return { token: "", expiresAt: NOW };
        },
      },
    });
    expect((await postStaff(app, "join", "k095-join-noop")).statusCode).toBe(503);
    expect((await backend.store.telehealthById(ORG, VISIT_ROOM_MINTED))?.lifecycleState).toBe(
      "room_minted",
    );
    await app.close();
  });

  it("leave persists the departure, and a re-join clears it", async () => {
    const { app, backend } = makeServer();
    await postStaff(app, "join", "k095-l-join");
    expect((await postStaff(app, "leave", "k095-l-leave")).statusCode).toBe(200);
    expect(
      (await backend.store.telehealthRoomFacts(ORG, VISIT_ROOM_MINTED))?.clinicianLeftAt,
    ).not.toBeNull();
    await postStaff(app, "join", "k095-l-rejoin");
    expect(
      (await backend.store.telehealthRoomFacts(ORG, VISIT_ROOM_MINTED))?.clinicianLeftAt,
    ).toBeNull();
    await app.close();
  });

  it("end closes the VENDOR room by its decrypted id and records who was still present", async () => {
    const endRoom = vi.fn(async () => {});
    const { app, backend } = makeServer({ telehealthAdapter: { endRoom } });
    await postStaff(app, "join", "k095-e-join");
    await postStaff(app, "leave", "k095-e-leave");
    const res = await postStaff(app, "end", "k095-e-end");
    expect(res.statusCode).toBe(200);
    expect(endRoom).toHaveBeenCalledWith(`room-${VISIT_ROOM_MINTED}`);
    const ended = await backend.store.telehealthById(ORG, VISIT_ROOM_MINTED);
    expect(ended?.lifecycleState).toBe("ended_aborted");
    expect(ended?.endReason).toBe("both_dropped");
    await app.close();
  });

  it("end reports 503 when the vendor cannot close the room, but the local close is kept and a retry re-calls the vendor", async () => {
    let fail = true;
    const endRoom = vi.fn(async () => {
      if (fail) throw new Error("vendor down");
    });
    const { app, backend } = makeServer({ telehealthAdapter: { endRoom } });
    await postStaff(app, "join", "k095-r-join");
    expect((await postStaff(app, "end", "k095-r-end1")).statusCode).toBe(503);
    expect((await backend.store.telehealthById(ORG, VISIT_ROOM_MINTED))?.lifecycleState).toBe(
      "ended_aborted",
    );
    fail = false;
    expect((await postStaff(app, "end", "k095-r-end2")).statusCode).toBe(200);
    expect(endRoom).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("start-recording addresses the vendor ROOM id and keeps the vendor recording id; stop-recording stops that recording", async () => {
    const startRecording = vi.fn(async () => ({ vendorRecordingId: "rec-77" }));
    const stopRecording = vi.fn(async () => ({
      recordingUrl: "https://vendor.invalid/r",
      durationSec: 1,
    }));
    const { app, backend } = makeServer({ telehealthAdapter: { startRecording, stopRecording } });
    const started = await postStaff(app, "start-recording", "k095-rec-1", {
      acknowledgesStateRules: true,
      acknowledgesPatientConsent: true,
    });
    expect(started.statusCode).toBe(200);
    expect(startRecording).toHaveBeenCalledWith(`room-${VISIT_ROOM_MINTED}`);
    expect(
      (await backend.store.telehealthRoomFacts(ORG, VISIT_ROOM_MINTED))?.vendorRecordingId,
    ).toBe("rec-77");
    const stopped = await postStaff(app, "stop-recording", "k095-rec-2");
    expect(stopped.statusCode).toBe(200);
    expect(stopRecording).toHaveBeenCalledWith(`room-${VISIT_ROOM_MINTED}`, "rec-77");
    expect(
      (await backend.store.telehealthRoomFacts(ORG, VISIT_ROOM_MINTED))?.vendorRecordingId,
    ).toBeNull();
    await app.close();
  });
});
