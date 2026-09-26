// apps/backend/__tests__/remittance-inject.test.ts — M25 (Remittance & Denials) HTTP-layer smoke suite
// (TASK-050A / TEST-001).
//
// M25 had ZERO Fastify `.inject()` coverage before this file: `25-remittance/__tests__/consumers-jobs.test.ts`,
// `25-remittance/__tests__/wiring.test.ts` and `25-remittance/domain/__tests__/domain.test.ts` all exercise
// pure functions / wiring directly, so a mis-wired guard, a typo'd permission key, or a TypeBox schema that
// never reaches the handler is invisible to every one of them — only a real `inject()` through the FULL M1
// middleware chain (auth → RBAC → ABAC → TypeBox → handler) catches that class of bug. This file is that
// pass, cloned from `orders-routes.test.ts` (the reference implementation for this effort) via the
// `discipline-plans-inject.test.ts` (M15) precedent: `buildServer()` mounts the host, `mountM25Routes()`
// mounts the five §4.1 route plugins (remittance/denials/appeals/taxonomy/internal — 31 routes total) over a
// hand-rolled in-memory `{ readService, writeService }` pair (M25 ships no `createInMemory*Backend` the way
// M11's orders module does, so this file is that backend, scoped to this file only), the REAL Authorization
// Contract gates every route on the real §4.6 permission keys, and the two §4.7 ABAC predicates M25 owns
// (`claim_assigned_to_actor`, `appeal_within_deadline`) are built with the module's own `buildM25AbacPredicates`
// over a resolver closed on this same in-memory store. A permissive `step_up_recent` stub is registered
// alongside them (this file's own fresh predicate registry, never the shared boot one) so the override /
// close-write-off / appeal-submit routes' `requireStepUp` gate has a real PASSING path here, matching the M15
// precedent's rationale.
//
// The acting test user carries the `billing_manager` role, one of M25's `BROAD_DENIAL_SCOPE_ROLES`
// (abac-predicates.ts) — this satisfies `claim_assigned_to_actor`'s oversight-role branch without this file
// having to seed a matching `assigneeMembershipId` on every denial-worklist route, exactly the way a real
// billing manager's session would. `appeal_within_deadline` has no such role bypass (D6/D7's hard T-0 block
// applies to everyone), so the in-memory abac resolver loads a real (dynamically future-dated) deadline for
// the seeded appeal case.
//
// The business RULES (the auto-match strategies, the two-tier posting routing, the denial/appeal state
// machines, the appeal-tier deadline clock) are already pinned by the pure-domain suite
// (`domain/__tests__/domain.test.ts`) and the (still-partial) live-RLS suite; this file does not re-derive
// them. Its in-memory service intentionally skips that logic (no state-machine validation, no version
// conflict enforcement) so it can focus on what only `inject()` can prove: every one of the thirty-one routes
// reaches its handler with the RIGHT permission key, the RIGHT ABAC composition, and a body that TypeBox
// actually validates — a 401 with no session, a 403 with no grant, a 422 on a malformed body, and one
// legitimately-authorized 2xx call per route.
import { FormatRegistry } from "@sinclair/typebox";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { NotFoundError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";

// DEVIATION (documented, not fixed here — out of scope, module source is off-limits for this file):
// `routes/m25-typebox.ts` is the only module `*-typebox.ts` in the whole backend that does NOT
// self-register the "uuid" / "date-time" TypeBox format checkers via `FormatRegistry.Set` the way EVERY
// other module's typebox file does (see e.g. `15-discipline-care-plans/routes/m15-typebox.ts`,
// `19-oncall/routes/m19-typebox.ts`, `11-orders/routes/orders-typebox.ts` — all guard with
// `FormatRegistry.Has` then `.Set`). `@sinclair/typebox`'s `FormatRegistry` is a process-wide singleton, so
// in a FULL boot (every module's routes mounted) some other module's typebox import happens to have already
// registered these two checkers by the time an M25 request validates a body — but that is a SILENT,
// un-enforced cross-module dependency: mounting M25's routes in isolation (exactly what this file does, and
// what M25-T06 §4.1's own inventory implies should be independently testable) proves every `format: "uuid"`
// / `format: "date-time"` field in `m25-typebox.ts` rejects a well-formed value with "Unknown format" until
// some unrelated module happens to import first. Registered here (idempotently) to unblock this suite; the
// real fix belongs in `m25-typebox.ts` itself.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type M25ReadService,
  type M25WriteService,
  M25_PERMISSION_KEY_LIST,
  type ReadingM25AbacResolver,
  buildM25AbacPredicates,
  mountM25Routes,
} from "../src/modules/25-remittance/index";
import type {
  AppealDetail,
  TaxonomyMergedView,
} from "../src/modules/25-remittance/routes/read-service";

// ── the header-auth shim (the M7/M11/M15 precedent), extended with the extra `request.context.attributes`
// M25's actor layer + the `/internal/...` seam read: `membershipId` (write attribution, M25WriteActor),
// `stepUpRecent` (the write-actor shape) and the PRINCIPAL KIND (internal.routes.ts's SYSTEM_PRINCIPAL lock).
//
// F-030 — this shim used to stamp a boolean `systemPrincipal` attribute, "unlike M15's string
// `actorKind`", and the routes read the same boolean. Nothing in production has ever written
// `systemPrincipal`: `actorKind` is the stamped principal-kind fact, and the two names never met, so
// the /internal seam refused every caller including the M23 service-to-service calls it exists for.
// The shim now stamps what the authenticate hook stamps — a string `actorKind` — and the routes read
// that, so the positive cases below exercise the fact production actually assembles.
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  request.context.attributes.stepUpRecent = true;
  request.context.attributes.actorKind =
    request.headers["x-test-system-principal"] === "true" ? "system" : "user";
}

// ── fixed ids (the M7/M11/M15 style — distinct, valid-`uuid`-format constants) ────────────────────────────
const ORG = "org_a";
const ADVICE = "11111111-1111-4111-8111-111111111111";
const LINE = "22222222-2222-4222-8222-222222222222";
const CLAIM = "33333333-3333-4333-8333-333333333333";
const DENIAL = "44444444-4444-4444-8444-444444444444";
const APPEAL = "55555555-5555-4555-8555-555555555555";
const PROVIDER_ENTITY = "66666666-6666-4666-8666-666666666666";
const DOCUMENT = "77777777-7777-4777-8777-777777777777";
const PATIENT = "88888888-8888-4888-8888-888888888888";
const RN_MEMBERSHIP = "99999999-9999-4999-8999-999999999999";
const ADJUSTMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PR_ROW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CARC = "45";
const NOW = "2026-07-30T12:00:00.000Z";
// The appeal.submit route's `appeal_within_deadline` ABAC (D6/D7) evaluates against REAL wall-clock time
// (`new Date()`), not the fixed `NOW` fixture instant — a static past/near date would rot this suite as
// real time advances. Dynamically far-future instead.
const FUTURE_DEADLINE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

// ── the in-memory M25 backend (this file's own — M25 ships no `createInMemory*Backend`) ────────────────
function createM25Backend(): {
  readonly readService: M25ReadService;
  readonly writeService: M25WriteService;
  readonly abacResolver: ReadingM25AbacResolver;
} {
  const advices = new Map<
    string,
    {
      id: string;
      providerEntityId: string;
      payerId: string;
      payerKind: string;
      paymentMethod: string;
      totalPaymentAmount: string;
      parseStatus: string;
      receivedAt: string;
    }
  >();
  const lines = new Map<
    string,
    {
      id: string;
      remittanceAdviceId: string;
      claimId: string | null;
      clp02StatusCode: number;
      clp03TotalChargeAmount: string;
      clp04TotalPaymentAmount: string;
      clp05PatientResponsibilityAmount: string;
      matchState: string;
      matchStrategy: string | null;
      matchConfidence: number | null;
      receivedAt: string;
    }
  >();
  const denials = new Map<
    string,
    {
      id: string;
      providerEntityId: string;
      claimId: string | null;
      carcCode: string;
      rarcCode: string | null;
      category: string;
      source: string;
      state: string;
      assigneeMembershipId: string | null;
      openedAt: string;
      agingBucketDays: number;
      agingBucketLabel: "0-7" | "8-15" | "16-30" | "31-60" | "61-90" | "91+";
      dollarValue: string;
      taxonomyStatus: string;
      version: number;
    }
  >();
  const appeals = new Map<string, AppealDetail>();
  const taxonomy = new Map<string, TaxonomyMergedView>();
  const prLedger: Array<{
    id: string;
    patientId: string;
    prAmount: string;
    status: string;
    recordedAt: string;
  }> = [];

  advices.set(ADVICE, {
    id: ADVICE,
    providerEntityId: PROVIDER_ENTITY,
    payerId: "payer-medicare-a",
    payerKind: "medicare_a",
    paymentMethod: "eft",
    totalPaymentAmount: "1200.00",
    parseStatus: "parsed",
    receivedAt: NOW,
  });

  lines.set(LINE, {
    id: LINE,
    remittanceAdviceId: ADVICE,
    claimId: null,
    clp02StatusCode: 1,
    clp03TotalChargeAmount: "1500.00",
    clp04TotalPaymentAmount: "1200.00",
    clp05PatientResponsibilityAmount: "300.00",
    matchState: "unmatched",
    matchStrategy: null,
    matchConfidence: null,
    receivedAt: NOW,
  });

  denials.set(DENIAL, {
    id: DENIAL,
    providerEntityId: PROVIDER_ENTITY,
    claimId: CLAIM,
    carcCode: CARC,
    rarcCode: null,
    category: "coding",
    source: "835",
    state: "open",
    assigneeMembershipId: null,
    openedAt: NOW,
    agingBucketDays: 3,
    agingBucketLabel: "0-7",
    dollarValue: "300.00",
    taxonomyStatus: "mapped",
    version: 1,
  });

  appeals.set(APPEAL, {
    id: APPEAL,
    denialCaseId: DENIAL,
    claimId: CLAIM,
    tier: "redetermination",
    state: "draft",
    decisionOutcome: null,
    tierDeadlineAt: FUTURE_DEADLINE,
    version: 1,
    appealPacketDocumentId: null,
    submittedAt: null,
    decidedAt: null,
    events: [],
  });

  taxonomy.set(CARC, {
    carcCode: CARC,
    rarcCode: null,
    category: "coding",
    plainLanguage: "Charge exceeds the fee schedule allowable amount.",
    suggestedAction: null,
    ownerRole: null,
    severity: null,
    hasOverlay: false,
    overlayVersion: null,
  });

  prLedger.push({
    id: PR_ROW,
    patientId: PATIENT,
    prAmount: "300.00",
    status: "open",
    recordedAt: NOW,
  });

  const readService: M25ReadService = {
    async listAdvices(_actor, _filters, _cursor, _limit) {
      return { items: [...advices.values()], nextCursor: null };
    },
    async getAdvice(_actor, id) {
      return advices.get(id) ?? null;
    },
    async listLines(_actor, _filters, _cursor, _limit) {
      return { items: [...lines.values()], nextCursor: null };
    },
    async getLine(_actor, id) {
      return lines.get(id) ?? null;
    },
    async listUnmatched(_actor, _providerEntityId, _cursor, _limit) {
      return {
        items: [...lines.values()].filter((l) => l.matchState === "unmatched"),
        nextCursor: null,
      };
    },
    async denialWorklist(_actor, _filters, _cursor, _limit) {
      return { items: [...denials.values()], nextCursor: null };
    },
    async getDenial(_actor, id) {
      return denials.get(id) ?? null;
    },
    async listAppeals(_actor, _filters, _cursor, _limit) {
      return { items: [...appeals.values()], nextCursor: null };
    },
    async getAppeal(_actor, id) {
      return appeals.get(id) ?? null;
    },
    async taxonomyView(_actor, carcCode) {
      return (
        taxonomy.get(carcCode) ?? {
          carcCode,
          rarcCode: null,
          category: "unknown",
          plainLanguage: "",
          suggestedAction: null,
          ownerRole: null,
          severity: null,
          hasOverlay: false,
          overlayVersion: null,
        }
      );
    },
    async denialMetrics(_actor) {
      return {
        agingBucketCounts: { "0-7": 1, "8-15": 0, "16-30": 0, "31-60": 0, "61-90": 0, "91+": 0 },
        openCount: 1,
        totalDollarOpen: "300.00",
      };
    },
    async prLedger(_actor, patientId) {
      return patientId ? prLedger.filter((r) => r.patientId === patientId) : prLedger;
    },
  };

  const writeService: M25WriteService = {
    async replayAdvice(_actor, adviceId) {
      if (!advices.has(adviceId)) throw new NotFoundError("remittance advice not found");
    },
    async manualMatch(_actor, lineId, input) {
      const row = lines.get(lineId);
      if (!row) throw new NotFoundError("remittance line not found");
      lines.set(lineId, {
        ...row,
        claimId: input.proposedClaimId,
        matchState: "manual_matched",
        matchStrategy: "manual",
      });
    },
    async overrideAdjustment(_actor, adjustmentId, _input) {
      void adjustmentId;
    },
    async assignDenial(_actor, id, input, _ifMatch) {
      const row = denials.get(id);
      if (!row) throw new NotFoundError("denial case not found");
      const updated = {
        ...row,
        assigneeMembershipId: input.assigneeMembershipId,
        version: row.version + 1,
      };
      denials.set(id, updated);
      return { id, version: updated.version };
    },
    async startDenial(_actor, id, _ifMatch) {
      const row = denials.get(id);
      if (!row) throw new NotFoundError("denial case not found");
      const updated = { ...row, state: "in_progress", version: row.version + 1 };
      denials.set(id, updated);
      return { id, version: updated.version };
    },
    async escalateDenial(_actor, id, _input, _ifMatch) {
      const row = denials.get(id);
      if (!row) throw new NotFoundError("denial case not found");
      const updated = { ...row, state: "escalated", version: row.version + 1 };
      denials.set(id, updated);
      return { id, version: updated.version };
    },
    async resolveDenial(_actor, id, _input, _ifMatch) {
      const row = denials.get(id);
      if (!row) throw new NotFoundError("denial case not found");
      const updated = { ...row, state: "resolved", version: row.version + 1 };
      denials.set(id, updated);
      return { id, version: updated.version };
    },
    async closeDenial(_actor, id, _ifMatch) {
      const row = denials.get(id);
      if (!row) throw new NotFoundError("denial case not found");
      const updated = { ...row, state: "closed", version: row.version + 1 };
      denials.set(id, updated);
      return { id, version: updated.version };
    },
    async closeWriteOffDenial(_actor, id, _input, _ifMatch) {
      const row = denials.get(id);
      if (!row) throw new NotFoundError("denial case not found");
      const updated = { ...row, state: "closed_written_off", version: row.version + 1 };
      denials.set(id, updated);
      return { id, version: updated.version };
    },
    async reopenDenial(_actor, id, _input, _ifMatch) {
      const row = denials.get(id);
      if (!row) throw new NotFoundError("denial case not found");
      const updated = { ...row, state: "open", version: row.version + 1 };
      denials.set(id, updated);
      return { id, version: updated.version };
    },
    async createAppeal(_actor, denialCaseId, input) {
      const id = `${denialCaseId}-appeal-new`;
      const row: AppealDetail = {
        id,
        denialCaseId,
        claimId: CLAIM,
        tier: input.tier ?? "redetermination",
        state: "draft",
        decisionOutcome: null,
        tierDeadlineAt: FUTURE_DEADLINE,
        version: 1,
        appealPacketDocumentId: null,
        submittedAt: null,
        decidedAt: null,
        events: [],
      };
      appeals.set(id, row);
      return { id, version: 1 };
    },
    async attachAppealDocument(_actor, id, documentId, _ifMatch) {
      const row = appeals.get(id);
      if (!row) throw new NotFoundError("appeal case not found");
      const updated = { ...row, appealPacketDocumentId: documentId, version: row.version + 1 };
      appeals.set(id, updated);
      return { id, version: updated.version };
    },
    async submitAppeal(_actor, id, _input, _ifMatch) {
      const row = appeals.get(id);
      if (!row) throw new NotFoundError("appeal case not found");
      const updated = { ...row, state: "submitted", submittedAt: NOW, version: row.version + 1 };
      appeals.set(id, updated);
      return { id, version: updated.version };
    },
    async ackAppeal(_actor, id, _ifMatch) {
      const row = appeals.get(id);
      if (!row) throw new NotFoundError("appeal case not found");
      const updated = { ...row, state: "acknowledged", version: row.version + 1 };
      appeals.set(id, updated);
      return { id, version: updated.version };
    },
    async decideAppeal(_actor, id, input, _ifMatch) {
      const row = appeals.get(id);
      if (!row) throw new NotFoundError("appeal case not found");
      const updated = {
        ...row,
        state: "decided",
        decisionOutcome: input.outcome,
        decidedAt: input.decidedAt,
        version: row.version + 1,
      };
      appeals.set(id, updated);
      return { id, version: updated.version };
    },
    async withdrawAppeal(_actor, id, _input, _ifMatch) {
      const row = appeals.get(id);
      if (!row) throw new NotFoundError("appeal case not found");
      const updated = { ...row, state: "withdrawn", version: row.version + 1 };
      appeals.set(id, updated);
      return { id, version: updated.version };
    },
    async closeAppeal(_actor, id, _ifMatch) {
      const row = appeals.get(id);
      if (!row) throw new NotFoundError("appeal case not found");
      const updated = { ...row, state: "closed", version: row.version + 1 };
      appeals.set(id, updated);
      return { id, version: updated.version };
    },
    async editTaxonomyOverlay(_actor, carcCode, input, _ifMatch) {
      const existing = taxonomy.get(carcCode);
      const version = (existing?.overlayVersion ?? 0) + 1;
      const updated: TaxonomyMergedView = {
        carcCode,
        rarcCode: input.rarcCode ?? existing?.rarcCode ?? null,
        category: existing?.category ?? "coding",
        plainLanguage: input.plainLanguageOverride ?? existing?.plainLanguage ?? "",
        suggestedAction: input.suggestedAction,
        ownerRole: input.ownerRole,
        severity: input.severity,
        hasOverlay: true,
        overlayVersion: version,
      };
      taxonomy.set(carcCode, updated);
      return { id: carcCode, version };
    },
  };

  // The §4.7 fact resolver, closed over the SAME maps as the read/write services above (the M15
  // `DisciplinePlanAbacResolver` precedent). `claim_assigned_to_actor`'s broad-oversight-role branch (the
  // `billing_manager` role our SUPER test actor carries) short-circuits before either lookup runs on every
  // 2xx case below, so `loadDenialAssignment`/`loadActorMembershipId` only matter for a caller WITHOUT that
  // role — this file does not exercise that narrower branch (it is pinned by the pure-domain suite instead).
  const abacResolver: ReadingM25AbacResolver = {
    async loadDenialAssignment(_ctx, denialCaseId) {
      const row = denials.get(denialCaseId);
      return row
        ? { assigneeMembershipId: row.assigneeMembershipId, providerEntityId: row.providerEntityId }
        : null;
    },
    async loadAppealDeadline(_ctx, appealCaseId) {
      const row = appeals.get(appealCaseId);
      return row ? { deadlineAt: row.tierDeadlineAt } : null;
    },
    async loadActorMembershipId(_ctx) {
      return RN_MEMBERSHIP;
    },
  };

  return { readService, writeService, abacResolver };
}

// ── server assembly (the M11/M15 `makeServer()` precedent) ──────────────────────────────────────────────
const SUPER_HEADERS = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  // `billing_manager` is one of M25's own `BROAD_DENIAL_SCOPE_ROLES` (abac-predicates.ts) — it satisfies
  // `claim_assigned_to_actor` for every denial-worklist route without this file needing to seed a matching
  // `assigneeMembershipId` per case.
  "x-test-roles": "billing_manager",
  "x-test-membership": RN_MEMBERSHIP,
};
const SYSTEM_HEADERS = { ...SUPER_HEADERS, "x-test-system-principal": "true" };
const NONE_HEADERS = { "x-test-user": "none_1", "x-test-org": ORG, "x-test-roles": "" };

function makeServer() {
  const backend = createM25Backend();

  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "super_1",
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M25_PERMISSION_KEY_LIST],
        },
      ],
    },
    {
      orgId: ORG,
      userId: "none_1",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }],
    },
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server (the M11-T06 / M15 precedent): the two §4.7 predicates M25 owns,
  // built over THIS backend's resolver, plus a permissive `step_up_recent` stub so the step-up-gated routes
  // (adjustment-override / denial.close_with_write_off / appeal.submit) have a real PASSING path here.
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildM25AbacPredicates({ resolver: backend.abacResolver }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async () => true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM25Routes(app, { readService: backend.readService, writeService: backend.writeService });
  return { app, backend };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

// ── §4.1 401 / 403 / 422 boundary cases ──────────────────────────────────────────────────────────────────
describe("M25 route smoke — the M1 boundary", () => {
  it("401s with no session at all", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/remittance/advices" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403s a permission-gated route for a session holding NO M25 grants", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/remittance/advices",
      headers: NONE_HEADERS,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("422s a malformed body from an otherwise-authorized caller (TypeBox validation, M1 envelope)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/remittance/lines/${LINE}/manual-match`,
      headers: { ...SUPER_HEADERS, "idempotency-key": "k-422" },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
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
const IFM = { "if-match": "1" };
const LONG_REASON = (label: string) =>
  `${label} — documented per the §4.1 reason floor with enough detail to satisfy the minimum-length gate.`;

const ROUTE_CASES: readonly RouteCase[] = [
  // 1–8 — the 835 envelope + line surface (remittance.routes.ts).
  {
    label: "1 GET /remittance/advices",
    method: "GET",
    url: "/api/v1/remittance/advices",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "2 GET /remittance/advices/:id",
    method: "GET",
    url: `/api/v1/remittance/advices/${ADVICE}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "3 POST /remittance/advices/:id/replay",
    method: "POST",
    url: `/api/v1/remittance/advices/${ADVICE}/replay`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k3") },
    payload: {},
    expectStatus: 202,
  },
  {
    label: "4 GET /remittance/lines",
    method: "GET",
    url: "/api/v1/remittance/lines",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "5 GET /remittance/lines/:id",
    method: "GET",
    url: `/api/v1/remittance/lines/${LINE}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "6 GET /remittance/unmatched",
    method: "GET",
    url: "/api/v1/remittance/unmatched",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "7 POST /remittance/lines/:id/manual-match",
    method: "POST",
    url: `/api/v1/remittance/lines/${LINE}/manual-match`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k7") },
    payload: {
      proposedClaimId: CLAIM,
      reason: "Matched via manual claim-number cross-reference lookup against the payer portal.",
    },
    expectStatus: 200,
  },
  {
    label: "8 POST /remittance/adjustments/:id/override",
    method: "POST",
    url: `/api/v1/remittance/adjustments/${ADJUSTMENT}/override`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k8") },
    payload: {
      newPostAction: "ledger_recorded",
      reason: LONG_REASON(
        "Re-classifying a flagged adjustment after manual review of the 835 remark codes",
      ),
    },
    expectStatus: 200,
  },

  // 9–18 — the denial worklist (denials.routes.ts).
  {
    label: "9 GET /denials",
    method: "GET",
    url: "/api/v1/denials",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "10 GET /denials/:id",
    method: "GET",
    url: `/api/v1/denials/${DENIAL}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "11 PATCH /denials/:id/assign",
    method: "PATCH",
    url: `/api/v1/denials/${DENIAL}/assign`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k11"), ...IFM },
    payload: {
      assigneeMembershipId: RN_MEMBERSHIP,
      reason: "Assigning to the billing specialist for CARC 45 review.",
    },
    expectStatus: 200,
  },
  {
    label: "12 PATCH /denials/:id/start",
    method: "PATCH",
    url: `/api/v1/denials/${DENIAL}/start`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k12"), ...IFM },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "13 PATCH /denials/:id/escalate",
    method: "PATCH",
    url: `/api/v1/denials/${DENIAL}/escalate`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k13"), ...IFM },
    payload: { reason: "Escalating after two unresolved follow-ups with the payer on this claim." },
    expectStatus: 200,
  },
  {
    label: "14 PATCH /denials/:id/resolve",
    method: "PATCH",
    url: `/api/v1/denials/${DENIAL}/resolve`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k14"), ...IFM },
    payload: {
      reason: LONG_REASON("Resolved after correcting the coding error and resubmitting the claim"),
    },
    expectStatus: 200,
  },
  {
    label: "15 POST /denials/:id/close",
    method: "POST",
    url: `/api/v1/denials/${DENIAL}/close`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k15"), ...IFM },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "16 POST /denials/:id/close-write-off",
    method: "POST",
    url: `/api/v1/denials/${DENIAL}/close-write-off`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k16"), ...IFM },
    payload: {
      reason: LONG_REASON(
        "Closing with a write-off after exhausting appeal options for this small-dollar denial",
      ),
    },
    expectStatus: 200,
  },
  {
    label: "17 POST /denials/:id/reopen",
    method: "POST",
    url: `/api/v1/denials/${DENIAL}/reopen`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k17"), ...IFM },
    payload: {
      reason: LONG_REASON("Reopening after the payer issued a corrected remittance advice"),
    },
    expectStatus: 200,
  },
  {
    label: "18 POST /denials/:id/appeals",
    method: "POST",
    url: `/api/v1/denials/${DENIAL}/appeals`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k18") },
    payload: { tier: "redetermination" },
    expectStatus: 201,
  },

  // 19–26 — the appeal tracker (appeals.routes.ts).
  {
    label: "19 GET /appeals",
    method: "GET",
    url: "/api/v1/appeals",
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "20 GET /appeals/:id",
    method: "GET",
    url: `/api/v1/appeals/${APPEAL}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "21 PATCH /appeals/:id/attach",
    method: "PATCH",
    url: `/api/v1/appeals/${APPEAL}/attach`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k21"), ...IFM },
    payload: { documentId: DOCUMENT },
    expectStatus: 200,
  },
  {
    label: "22 POST /appeals/:id/submit",
    method: "POST",
    url: `/api/v1/appeals/${APPEAL}/submit`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k22"), ...IFM },
    payload: {
      appealNarrative:
        "This appeal narrative documents in full detail why the payer's denial determination should be reversed on redetermination, citing the clinical documentation and coverage criteria the original claim submission satisfied.",
      attachedDocumentIds: [DOCUMENT],
    },
    expectStatus: 200,
  },
  {
    label: "23 PATCH /appeals/:id/ack",
    method: "PATCH",
    url: `/api/v1/appeals/${APPEAL}/ack`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k23"), ...IFM },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "24 POST /appeals/:id/decide",
    method: "POST",
    url: `/api/v1/appeals/${APPEAL}/decide`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k24"), ...IFM },
    payload: {
      outcome: "favorable",
      decidedAt: NOW,
      reason: LONG_REASON(
        "Decided favorable after the MAC's review of the submitted clinical documentation packet",
      ),
    },
    expectStatus: 200,
  },
  {
    label: "25 POST /appeals/:id/withdraw",
    method: "POST",
    url: `/api/v1/appeals/${APPEAL}/withdraw`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k25"), ...IFM },
    payload: {
      reason: LONG_REASON("Withdrawing after the payer voluntarily reprocessed and paid the claim"),
    },
    expectStatus: 200,
  },
  {
    label: "26 POST /appeals/:id/close",
    method: "POST",
    url: `/api/v1/appeals/${APPEAL}/close`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k26"), ...IFM },
    payload: {},
    expectStatus: 200,
  },

  // 27–28 — the denial taxonomy (taxonomy.routes.ts).
  {
    label: "27 GET /taxonomy/carc/:code",
    method: "GET",
    url: `/api/v1/taxonomy/carc/${CARC}`,
    headers: SUPER_HEADERS,
    expectStatus: 200,
  },
  {
    label: "28 PATCH /taxonomy/overlays/:carc",
    method: "PATCH",
    url: `/api/v1/taxonomy/overlays/${CARC}`,
    headers: { ...SUPER_HEADERS, ...IDEMP("k28"), ...IFM },
    payload: {
      suggestedAction: "Verify the fee schedule allowable amount before resubmitting the claim.",
      ownerRole: "billing_specialist",
      severity: "warn",
    },
    expectStatus: 200,
  },

  // 29–31 — the `/internal/...` system-principal seam surface (internal.routes.ts).
  {
    label: "29 GET /internal/remittance/reader",
    method: "GET",
    url: `/api/v1/internal/remittance/reader?adviceId=${ADVICE}`,
    headers: SYSTEM_HEADERS,
    expectStatus: 200,
  },
  {
    label: "30 GET /internal/denials/metrics",
    method: "GET",
    url: "/api/v1/internal/denials/metrics",
    headers: SYSTEM_HEADERS,
    expectStatus: 200,
  },
  {
    label: "31 GET /internal/patient-responsibility",
    method: "GET",
    url: `/api/v1/internal/patient-responsibility?patientId=${PATIENT}`,
    headers: SYSTEM_HEADERS,
    expectStatus: 200,
  },
];

describe.each(ROUTE_CASES)("M25 route smoke — $label", (c) => {
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

// ── the /internal seam's system-principal lock — a non-system session is refused even holding the
// `*_internal` permission key (the second lock `SYSTEM_PRINCIPAL` in internal.routes.ts is the point of).
describe("M25 route smoke — the /internal seam's system-principal lock", () => {
  it("403s a staff session (actorKind `user`) even with the *_internal grant", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/internal/denials/metrics",
      headers: SUPER_HEADERS, // holds denial.read_internal, but is not a system principal
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("admits a real system principal — the lock opens for the fact production assembles (F-030)", async () => {
    // The negative case above passed throughout the bug, because "refuses a staff session" is also
    // what a permanently-shut door does. This is the case that distinguishes them, and the one the
    // suite did not have in a form that used the real attribute.
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/internal/denials/metrics",
      headers: SYSTEM_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
