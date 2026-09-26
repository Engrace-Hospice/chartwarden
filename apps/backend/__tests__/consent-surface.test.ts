// apps/backend/__tests__/consent-surface.test.ts — the M39 §4.1 routes beyond the original slice.
//
// consent-routes.test.ts covers the seven routes M39 shipped first (catalog, patient list, read,
// create-draft, sign, revoke, decision audit). This file covers the twenty that were missing — the
// tenant overlay, the version chain, draft editing, supersession, renewal, named recipients, DPOA
// agents, the expiry window, delegated access, the per-consent audit, and the admin/post-mortem
// paths — i.e. the surface behind M39's 8 tables that had no HTTP route at all.
//
// Every route is exercised through the FULL M1 chain via Fastify `inject`. STEP-UP is REAL here:
// `wireModuleSeams` installs the ABAC registry as the contract's evaluator and points
// `step_up_recent` at an M2 session-context store, so a write route with a stale step-up denies for
// the same reason it would in production — not because the predicate is missing.
import {
  abacRegistry,
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import {
  type ConsentDpoaAgentView,
  type ConsentRecipientView,
  type ConsentRecordView,
  type DelegatedAccessView,
  type EvalAuditRow,
  createInMemoryConsentRouteService,
} from "@wardenx/consent";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest } from "../src/bootstrap/seams/registry";
import { wireModuleSeams } from "../src/index";
import { registerConsentRoutes } from "../src/modules/39-consent/index";

const ORG = "org_a";
const PAT = "patient-1";
const DECEASED = "patient-deceased";
const SESSION = "sess-1";

/** Test-only auth shim. `sessionId` is what `step_up_recent` resolves the recency of. */
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["seed"];
  request.context.attributes = { ...request.context.attributes, sessionId: SESSION };
}

const PERMISSION_SEED = [
  { userId: "reader", permissions: ["consent.read_catalog", "consent.read"] },
  { userId: "historian", permissions: ["consent.read", "consent.read_history"] },
  { userId: "author", permissions: ["consent.author"] },
  { userId: "signer", permissions: ["consent.sign", "consent.revoke", "consent.read"] },
  { userId: "compliance", permissions: ["consent.read_eval_audit"] },
  { userId: "overlay_admin", permissions: ["consent.manage_overlay"] },
  { userId: "re_render_admin", permissions: ["consent.admin_re_render"] },
  { userId: "cascade_admin", permissions: ["consent.cascade_admin"] },
  { userId: "bereavement", permissions: ["consent.bereavement_outreach_author"] },
  { userId: "nobody", permissions: [] },
];

const ISO = (d: string) => `${d}T00:00:00.000Z`;

/** Expiry fixtures are RELATIVE to the wall clock — the window filter is a "days from now"
 *  question, so absolute dates would make these tests pass or fail depending on the calendar. */
const daysFromNow = (n: number) => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString();

function record(over: Partial<ConsentRecordView> & { id: string }): ConsentRecordView {
  return {
    organizationId: ORG,
    patientId: PAT,
    typeKey: "hipaa_release",
    grantorKind: "patient_self",
    captureMethod: "typed_signature_in_app",
    scopeDescriptor: { all: true },
    status: "active",
    version: 1,
    effectiveAt: ISO("2026-01-01"),
    expiresAt: null,
    signedAt: ISO("2026-01-01"),
    createdById: "author",
    supersedesConsentRecordId: null,
    renewedFromConsentRecordId: null,
    survivesDeath: false,
    ...over,
  };
}

function evalRow(n: number, consentRecordId: string): EvalAuditRow {
  return {
    id: `ea-${n.toString().padStart(3, "0")}`,
    organizationId: ORG,
    patientId: PAT,
    consentRecordId,
    typeKey: "hipaa_release",
    allowed: true,
    denyReason: null,
    callerModule: "m28",
    evaluatedAt: `2026-06-${(10 + n).toString().padStart(2, "0")}T00:00:00.000Z`,
  };
}

/**
 * Boot a server with the consent routes mounted.
 * @param stepUpAgeMs how long ago the session stepped up — under 5 minutes satisfies the gate;
 *                    `null` means never (the gate holds closed).
 */
function makeServer(stepUpAgeMs: number | null = 60_000) {
  const { service, data } = createInMemoryConsentRouteService({
    records: [
      record({ id: "c-active" }),
      record({ id: "c-draft", status: "draft", signedAt: null, effectiveAt: null, version: 0 }),
      record({ id: "c-expired", status: "expired" }),
      record({ id: "c-v1", status: "superseded" }),
      record({ id: "c-v2", status: "superseded", supersedesConsentRecordId: "c-v1", version: 2 }),
      record({ id: "c-v3", supersedesConsentRecordId: "c-v2", version: 3 }),
      record({ id: "c-portal", typeKey: "portal_access" }),
      record({ id: "c-dpoa", typeKey: "dpoa_healthcare", status: "draft", signedAt: null }),
      record({ id: "c-past", expiresAt: daysFromNow(-5) }),
      record({ id: "c-soon", expiresAt: daysFromNow(10) }),
      record({ id: "c-later", expiresAt: daysFromNow(45) }),
      record({ id: "c-far", expiresAt: daysFromNow(300) }),
      record({ id: "c-survivor", typeKey: "media_release", survivesDeath: true }),
    ],
    evalAudit: [1, 2, 3].map((n) => evalRow(n, "c-active")),
    renewalCycles: [
      {
        id: "cycle-1",
        organizationId: ORG,
        sourceConsentRecordId: "c-expired",
        patientId: PAT,
        status: "open",
        cycleStartedAt: ISO("2026-06-01"),
        nextActionDueAt: ISO("2026-06-20"),
        closedAt: null,
        closedReason: null,
        resolvedConsentRecordId: null,
        assignedToMembershipId: null,
      },
    ],
    delegatedAccess: [
      {
        id: "del-active",
        organizationId: ORG,
        patientId: PAT,
        consentRecordId: "c-active",
        consentRecordRecipientId: null,
        delegateUserId: null,
        delegateCaregiverId: "care-1",
        scope: "view_only_full",
        effectiveFrom: ISO("2026-01-01"),
        effectiveUntil: null,
        portalSessionClass: "caregiver_portal",
        revokedAt: null,
        active: true,
      },
      {
        id: "del-revoked",
        organizationId: ORG,
        patientId: PAT,
        consentRecordId: "c-active",
        consentRecordRecipientId: null,
        delegateUserId: null,
        delegateCaregiverId: "care-2",
        scope: "view_only_minimal",
        effectiveFrom: ISO("2026-01-01"),
        effectiveUntil: null,
        portalSessionClass: "caregiver_portal",
        revokedAt: ISO("2026-03-01"),
        active: false,
      },
    ],
    deceasedPatientIds: [DECEASED],
  });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  // Real step-up: the boot hook installs the ABAC registry as the evaluator and resolves
  // `step_up_recent` from this session's recency (abac-step-up-boot.test.ts owns that contract).
  const { store: sessionStore } = createInMemorySessionContextStore([
    {
      providerEntityIds: [],
      locationIds: [],
      sessionClass: "staff",
      portalAccountId: null,
      sessionPatientId: null,
      sessionId: SESSION,
      userId: "signer",
      membershipId: "mem-1",
      organizationId: ORG,
      roles: ["seed"],
      lastStepUpAt: stepUpAgeMs === null ? null : new Date(Date.now() - stepUpAgeMs),
      lastStepUpFactor: stepUpAgeMs === null ? null : "webauthn",
    },
  ]);
  wireModuleSeams({ sessionContextStore: sessionStore });

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerConsentRoutes(app, { service });
  return { app, service, data };
}

const h = (user: string) => ({ "x-test-user": user, "x-test-org": ORG, "x-test-roles": "seed" });

beforeEach(() => {
  __resetSeamsForTest();
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M39 §4.1 — the surface behind the previously route-less tables", () => {
  it("the step-up harness is real (the boot hook installed step_up_recent)", () => {
    makeServer();
    expect(abacRegistry.has("step_up_recent")).toBe(true);
  });

  // ── 2. tenant_consent_type_overlay ────────────────────────────────────────────────────────────
  describe("route 2 — POST /consent-types/overlay (tighten-only, §7.6)", () => {
    it("publishes a TIGHTER overlay (201) and stores it against the org", async () => {
      const { app, data } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consent-types/overlay",
        headers: h("overlay_admin"),
        payload: {
          typeKey: "hipaa_release",
          tighterExpirationSeconds: 30 * 24 * 3600, // shorter than the 365-day floor
          tighterCaptureMethods: ["notarized"],
          jurisdictionCodeRequired: true,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.typeKey).toBe("hipaa_release");
      expect(data.overlays).toHaveLength(1);
      await app.close();
    });

    it("refuses a LOOSENING overlay with 422 — a longer term than the platform floor", async () => {
      const { app, data } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consent-types/overlay",
        headers: h("overlay_admin"),
        payload: { typeKey: "hipaa_release", tighterExpirationSeconds: 10 * 365 * 24 * 3600 },
      });
      expect(res.statusCode).toBe(422);
      expect(data.overlays).toHaveLength(0); // nothing published
      await app.close();
    });

    it("refuses a capture method outside the platform floor (loosen) with 422", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consent-types/overlay",
        headers: h("overlay_admin"),
        payload: { typeKey: "hipaa_release", tighterReminderCadence: ["7_days"] }, // drops 4 floor reminders
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("denies without consent.manage_overlay (403) — the key had no route before", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consent-types/overlay",
        headers: h("author"),
        payload: { typeKey: "hipaa_release" },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("denies a stale step-up (403) even with consent.manage_overlay", async () => {
      const { app } = makeServer(null); // never stepped up
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consent-types/overlay",
        headers: h("overlay_admin"),
        payload: { typeKey: "hipaa_release" },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  // ── 5. version chain ──────────────────────────────────────────────────────────────────────────
  describe("route 5 — GET /consents/:id/version-chain (D1 + D13 ancestry)", () => {
    it("walks the supersession chain oldest-first", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/consents/c-v3/version-chain",
        headers: h("historian"),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.supersedes.map((r: ConsentRecordView) => r.id)).toEqual([
        "c-v1",
        "c-v2",
      ]);
      await app.close();
    });

    it("requires consent.read_history — plain consent.read is not enough (403)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/consents/c-v3/version-chain",
        headers: h("reader"),
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  // ── 7 + 9. draft editing vs supersession (D1 append-only) ─────────────────────────────────────
  describe("routes 7 + 9 — a draft is edited in place; a signed consent is SUPERSEDED", () => {
    it("PATCH edits a draft (200)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/consents/c-draft",
        headers: h("author"),
        payload: { captureMethod: "notarized" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.captureMethod).toBe("notarized");
      await app.close();
    });

    it("PATCH refuses an ACTIVE consent (409) — an edit to a signed consent is a supersession", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/consents/c-active",
        headers: h("author"),
        payload: { captureMethod: "notarized" },
      });
      expect(res.statusCode).toBe(409);
      await app.close();
    });

    it("supersede mints a NEW active row and flips the prior to superseded (201)", async () => {
      const { app, data } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-active/supersede",
        headers: h("signer"),
        payload: {
          scopeDescriptor: { all: false },
          captureMethod: "notarized",
          grantorKind: "patient_self",
          captureEvidence: {
            notaryCertificateDocumentId: "11111111-1111-4111-8111-111111111111",
          },
        },
      });
      expect(res.statusCode).toBe(201);
      const next = res.json().data;
      expect(next.supersedesConsentRecordId).toBe("c-active");
      expect(next.status).toBe("active");
      expect(data.records.find((r) => r.id === "c-active")?.status).toBe("superseded");
      await app.close();
    });

    it("supersede refuses a DRAFT (409) — only an ACTIVE row may be superseded (D1)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-draft/supersede",
        headers: h("signer"),
        payload: {
          scopeDescriptor: {},
          captureMethod: "notarized",
          grantorKind: "patient_self",
          captureEvidence: {
            notaryCertificateDocumentId: "11111111-1111-4111-8111-111111111111",
          },
        },
      });
      // 409, not 422: the request is well-formed, the RECORD is in the wrong state.
      expect(res.statusCode).toBe(409);
      await app.close();
    });
  });

  // ── 11–13. consent_record_recipient ───────────────────────────────────────────────────────────
  describe("routes 11–13 — named recipients (D6)", () => {
    it("adds a recipient to a per-recipient consent (201) and lists it active", async () => {
      const { app } = makeServer();
      const add = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-active/recipients",
        headers: h("author"),
        payload: {
          recipientKind: "free_text",
          recipientFreeText: "Dr. Alvarez, community cardiology",
          recipientDisplayName: "Dr. Alvarez",
        },
      });
      expect(add.statusCode).toBe(201);

      const list = await app.inject({
        method: "GET",
        url: "/api/v1/consents/c-active/recipients",
        headers: h("reader"),
      });
      expect(list.json().data).toHaveLength(1);
      expect(list.json().data[0].active).toBe(true);
      await app.close();
    });

    it("refuses a recipient on a CATEGORICAL consent type (422, D6)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-portal/recipients", // portal_access is categorical
        headers: h("author"),
        payload: {
          recipientKind: "free_text",
          recipientFreeText: "somebody at all",
          recipientDisplayName: "Somebody",
        },
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("refuses a non-free_text recipient with no entity FK (422)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-active/recipients",
        headers: h("author"),
        payload: { recipientKind: "pharmacy", recipientDisplayName: "Corner Pharmacy" },
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("removal flips active=false but KEEPS the row (a past authorization stays in the record)", async () => {
      const { app } = makeServer();
      const add = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-active/recipients",
        headers: h("author"),
        payload: {
          recipientKind: "free_text",
          recipientFreeText: "Dr. Alvarez, community cardiology",
          recipientDisplayName: "Dr. Alvarez",
        },
      });
      const recipientId = add.json().data.id;

      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/consents/c-active/recipients/${recipientId}`,
        headers: h("author"),
        payload: { removedReasonText: "patient withdrew this disclosure" },
      });
      expect(del.statusCode).toBe(200);
      expect(del.json().data.active).toBe(false);

      const list = await app.inject({
        method: "GET",
        url: "/api/v1/consents/c-active/recipients",
        headers: h("reader"),
      });
      const rows = list.json().data as ConsentRecipientView[];
      expect(rows).toHaveLength(1); // still there, historically
      expect(rows[0]?.removedReasonText).toBe("patient withdrew this disclosure");

      // A second removal is refused rather than silently re-stamping the timestamp.
      const again = await app.inject({
        method: "DELETE",
        url: `/api/v1/consents/c-active/recipients/${recipientId}`,
        headers: h("author"),
        payload: { removedReasonText: "again" },
      });
      expect(again.statusCode).toBe(409);
      await app.close();
    });
  });

  // ── 14–17. consent_record_dpoa_agent ──────────────────────────────────────────────────────────
  describe("routes 14–17 — named DPOA agents (D5)", () => {
    const agent = {
      agentKind: "primary",
      agentName: "Marta Reyes",
      agentRelationship: "daughter",
      agentContact: { phone: "555-0100" },
      scopeKind: "healthcare_full",
      activationCondition: "upon_physician_determination",
      termKind: "indefinite",
    };

    it("names a primary agent (201) and lists it active", async () => {
      const { app } = makeServer();
      const add = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-dpoa/dpoa-agents",
        headers: h("author"),
        payload: agent,
      });
      expect(add.statusCode).toBe(201);

      const list = await app.inject({
        method: "GET",
        url: "/api/v1/consents/c-dpoa/dpoa-agents",
        headers: h("reader"),
      });
      expect((list.json().data as ConsentDpoaAgentView[])[0]?.active).toBe(true);
      await app.close();
    });

    it("refuses a SECOND active primary (422) — the D5 ≤1-per-kind rule, not a 23505", async () => {
      const { app } = makeServer();
      await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-dpoa/dpoa-agents",
        headers: h("author"),
        payload: agent,
      });
      const dup = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-dpoa/dpoa-agents",
        headers: h("author"),
        payload: { ...agent, agentName: "Someone Else" },
      });
      expect(dup.statusCode).toBe(422);
      await app.close();
    });

    it("refuses an agent on a non-DPOA consent type (422)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-active/dpoa-agents", // hipaa_release is per-recipient
        headers: h("author"),
        payload: agent,
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("PATCH narrows an agent's scope, and `remove` retires them", async () => {
      const { app } = makeServer();
      const add = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-dpoa/dpoa-agents",
        headers: h("author"),
        payload: agent,
      });
      const agentId = add.json().data.id;

      const narrow = await app.inject({
        method: "PATCH",
        url: `/api/v1/consents/c-dpoa/dpoa-agents/${agentId}`,
        headers: h("author"),
        payload: { scopeKind: "healthcare_end_of_life_only" },
      });
      expect(narrow.statusCode).toBe(200);
      expect(narrow.json().data.scopeKind).toBe("healthcare_end_of_life_only");

      const retire = await app.inject({
        method: "PATCH",
        url: `/api/v1/consents/c-dpoa/dpoa-agents/${agentId}`,
        headers: h("author"),
        payload: { remove: true },
      });
      expect(retire.json().data.active).toBe(false);
      await app.close();
    });

    it("a DPOA consent cannot be SIGNED without exactly one active primary (422)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-dpoa/sign",
        headers: h("signer"),
        payload: { captureEvidence: { typedSignatureName: "Marta Reyes" } },
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("route 17 resolves the patient's active primary across their active DPOA consents", async () => {
      const { app } = makeServer();
      // Name the agent, then sign the consent so it becomes active.
      await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-dpoa/dpoa-agents",
        headers: h("author"),
        payload: agent,
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-dpoa/sign",
        headers: h("signer"),
        payload: { captureEvidence: { typedSignatureName: "Marta Reyes" } },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${PAT}/dpoa/active-primary`,
        headers: h("reader"),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.agentName).toBe("Marta Reyes");
      await app.close();
    });

    it("returns null when the patient has no active primary agent", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${PAT}/dpoa/active-primary`,
        headers: h("reader"),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toBeNull();
      await app.close();
    });
  });

  // ── 18–20. expiry window + renewal ────────────────────────────────────────────────────────────
  describe("routes 18–20 — the expiry window and the D13 renewal chain", () => {
    it("returns only FUTURE expiries inside the window, soonest first, with a day countdown", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${PAT}/expiring-consents?windowDays=90&pageSize=10`,
        headers: h("reader"),
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json().data as Array<{ id: string; daysUntilExpiry: number }>;
      const ids = rows.map((r) => r.id);
      expect(ids).toEqual(["c-soon", "c-later"]); // soonest first
      expect(ids).not.toContain("c-past"); // already elapsed — not "expiring"
      expect(ids).not.toContain("c-far"); // 300 days out — outside a 90-day window
      expect(rows[0]?.daysUntilExpiry).toBe(10);
      await app.close();
    });

    it("is cursor-paginated, never offset (§4.12)", async () => {
      const { app } = makeServer();
      const page1 = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${PAT}/expiring-consents?windowDays=365&pageSize=1`,
        headers: h("reader"),
      });
      const body1 = page1.json();
      expect(body1.data).toHaveLength(1);
      expect(body1.data[0].id).toBe("c-soon");
      expect(typeof body1.nextCursor).toBe("string");

      const page2 = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${PAT}/expiring-consents?windowDays=365&pageSize=1&cursor=${encodeURIComponent(body1.nextCursor)}`,
        headers: h("reader"),
      });
      expect(page2.json().data[0].id).toBe("c-later"); // strictly after the cursor, no overlap
      await app.close();
    });

    it("renews an EXPIRED consent (201) and closes the open cycle as `renewed`", async () => {
      const { app, data } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-expired/renew",
        headers: h("signer"),
        payload: {
          scopeDescriptor: { all: true },
          captureMethod: "typed_signature_in_app",
          grantorKind: "patient_self",
          captureEvidence: { typedSignatureName: "Patient Example" },
        },
      });
      expect(res.statusCode).toBe(201);
      const next = res.json().data;
      expect(next.renewedFromConsentRecordId).toBe("c-expired");
      expect(next.supersedesConsentRecordId).toBeNull(); // renewal is NOT supersession

      const cycle = data.renewalCycles.find((c) => c.id === "cycle-1");
      expect(cycle?.status).toBe("renewed");
      expect(cycle?.resolvedConsentRecordId).toBe(next.id);
      await app.close();
    });

    it("refuses renewing an ACTIVE consent (422) — that is a supersession, not a renewal", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-active/renew",
        headers: h("signer"),
        payload: {
          scopeDescriptor: {},
          captureMethod: "typed_signature_in_app",
          grantorKind: "patient_self",
          captureEvidence: { typedSignatureName: "Patient Example" },
        },
      });
      expect(res.statusCode).toBe(409);
      await app.close();
    });

    it("route 19 lists the record's renewal cycles", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/consents/c-expired/renewal-cycle",
        headers: h("reader"),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data[0].status).toBe("open");
      await app.close();
    });
  });

  // ── 21. delegated_access ──────────────────────────────────────────────────────────────────────
  it("route 21 — delegated-access rows carry a derived `active` (a revoked grant is inactive)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PAT}/delegated-access`,
      headers: h("reader"),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as DelegatedAccessView[];
    expect(rows.find((r) => r.id === "del-active")?.active).toBe(true);
    expect(rows.find((r) => r.id === "del-revoked")?.active).toBe(false);
    await app.close();
  });

  // ── 22. per-consent decision audit ────────────────────────────────────────────────────────────
  it("route 22 — the per-CONSENT decision audit is scoped to that record and cursor-paginated", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/consents/c-active/eval-audit?pageSize=2",
      headers: h("compliance"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(2);
    expect((res.json().data as EvalAuditRow[]).every((r) => r.consentRecordId === "c-active")).toBe(
      true,
    );
    expect(typeof res.json().nextCursor).toBe("string");
    await app.close();
  });

  // ── 24, 28–30. admin + post-mortem ────────────────────────────────────────────────────────────
  describe("routes 24, 28–30 — admin re-render, post-mortem, cascade retry", () => {
    it("route 24 accepts a re-render for a SIGNED consent (202) and refuses one for a draft", async () => {
      const { app } = makeServer();
      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-active/document/re-render",
        headers: h("re_render_admin"),
      });
      expect(ok.statusCode).toBe(202);
      expect(ok.json().data.eventType).toBe("m39.consent.signed");

      const draft = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-draft/document/re-render",
        headers: h("re_render_admin"),
      });
      expect(draft.statusCode).toBe(409);
      await app.close();
    });

    it("route 28 verdicts which consents survive death (D13)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/consents/post-mortem-eligible/${PAT}`,
        headers: h("reader"),
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json().data as Array<{ consentId: string; terminatesOnDeath: boolean }>;
      // media_release with survives_death=true is preserved; a hipaa_release terminates.
      expect(rows.find((r) => r.consentId === "c-survivor")?.terminatesOnDeath).toBe(false);
      expect(rows.find((r) => r.consentId === "c-active")?.terminatesOnDeath).toBe(true);
      await app.close();
    });

    it("route 29 captures bereavement outreach for a DECEASED patient (201)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consents/bereavement-outreach",
        headers: h("bereavement"),
        payload: {
          patientId: DECEASED,
          grantorKind: "bereaved_person_self",
          captureMethod: "typed_signature_in_app",
          scopeDescriptor: { outreachChannels: ["mail"] },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.typeKey).toBe("bereavement_outreach_consent");
      await app.close();
    });

    it("route 29 refuses bereavement capture for a LIVING patient (422, D14)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consents/bereavement-outreach",
        headers: h("bereavement"),
        payload: {
          patientId: PAT, // not deceased
          grantorKind: "bereaved_person_self",
          captureMethod: "typed_signature_in_app",
          scopeDescriptor: {},
        },
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("route 29 refuses a non-bereaved grantor (422)", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consents/bereavement-outreach",
        headers: h("bereavement"),
        payload: {
          patientId: DECEASED,
          grantorKind: "patient_self",
          captureMethod: "typed_signature_in_app",
          scopeDescriptor: {},
        },
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("route 30 sweeps a stuck cascade and lands it in partial_failed once the budget is spent", async () => {
      const { app, service } = makeServer();
      // Revoke through the service so a cascade exists (the route needs step-up we already have).
      service.revokeConsent(
        ORG,
        "c-active",
        {
          actorIsStaff: true,
          revokedByKind: "staff",
          reasonText: "x".repeat(40),
          evidenceDocumentId: "doc-1",
          revokedById: "signer",
        },
        new Date().toISOString(),
      );

      let last: { status: string; attempts: number; pendingConsumers: string[] } | undefined;
      for (let i = 0; i < 6; i += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/consents/c-active/cascade/retry",
          headers: h("cascade_admin"),
        });
        expect(res.statusCode).toBe(202);
        last = res.json().data;
      }
      // Five attempts is the budget (CASCADE_MAX_ATTEMPTS) — the sixth is terminal, and the
      // unacked consumers are reported rather than silently dropped.
      expect(last?.status).toBe("partial_failed");
      expect(last?.pendingConsumers.length).toBeGreaterThan(0);
      await app.close();
    });

    it("route 30 denies without consent.cascade_admin (403) — the key had no route before", async () => {
      const { app } = makeServer();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/consents/c-active/cascade/retry",
        headers: h("author"),
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });
});
