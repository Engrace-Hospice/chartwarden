// The visit-note closure gate through the REAL authenticate hook (`createSessionAuthenticate`) and the REAL Fastify route table's
// template matching: a blocked clinician (organization mode `block`, oldest note past its block instant) gets 403 NOTE_CLOSURE_REQUIRED
// on a route outside the allowlist while the SAME session reaches an allowlisted route. A clear clinician reaches both; `warn` mode
// refuses nothing; a failing read is 503 on the non-allowlisted route and invisible on the allowlisted one; and the other callers
// (a portal session, the machine credential) never reach the gate.
//
// What is real and what is stubbed, so the test claims no more than it proves: the authenticate hook, the gate (decision order,
// allowlist, caching), Fastify's `routeOptions.url` and the error envelope are real. The policy cache and the evaluator behind the gate
// are fakes, and the two routes are stand-ins (an allowlisted and a non-allowlisted template with no permission guards), so this does
// NOT prove the SQL evaluator or any real route's own guards; `closure-reader` and the live suites cover those.
import type { ResolvedActor, SessionContextResolver } from "@chartwarden/types";
import { STEP_UP_POLICY } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import { buildServer, createSessionAuthenticate } from "../src/bootstrap/index";
import {
  type NoteClosureGateEvaluation,
  createNoteClosureGate,
} from "../src/bootstrap/note-closure-gate";
import { liveOrganizationStage } from "./_live-organization-stage";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const BLOCKED_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const CLEAR_MEMBERSHIP = "33333333-3333-4333-8333-444444444444";
const ENCOUNTER = "44444444-4444-4444-8444-444444444444";
const DEADLINE = new Date("2026-11-16T12:00:00.000Z");
const SERVICE_TOKEN = "synthetic-internal-service-token-0123456789";

/** An allowlisted template (the clinician closes the note) and one outside the list (billing). */
const ALLOWED_URL = "/api/v1/encounters/my-drafts";
const REFUSED_URL = "/api/v1/billing/claims";

const blocked: NoteClosureGateEvaluation = {
  verdict: "blocked",
  encounterId: ENCOUNTER,
  overdueCount: 2,
  decision: { deadlineAt: DEADLINE, blockFrom: DEADLINE },
};
const clear: NoteClosureGateEvaluation = {
  verdict: "clear",
  encounterId: null,
  overdueCount: 0,
  decision: { deadlineAt: null, blockFrom: null },
};

const staffActor = (membershipId: string): ResolvedActor => ({
  userId: USER,
  membershipId,
  organizationId: ORG,
  roles: ["rn_case_manager"],
  providerEntityIds: [],
  locationIds: [],
  sessionClass: "staff",
  portalAccountId: null,
  sessionPatientId: null,
  deviceAttestation: null,
  externalActorId: null,
});
const portalActor: ResolvedActor = {
  ...staffActor("unused"),
  membershipId: null,
  roles: [],
  sessionClass: "patient_portal",
};

const resolverFor = (actor: ResolvedActor): SessionContextResolver => ({
  resolveActor: async () => actor,
  resolveStepUpState: async () => null,
  resolveStepUpPolicy: async () => ({
    qualifyingFactors: STEP_UP_POLICY.qualifyingFactors,
    maxAgeSec: STEP_UP_POLICY.defaultMaxAgeSec,
  }),
});

function serverFor(options: {
  actor: ResolvedActor;
  mode?: "off" | "warn" | "block";
  evaluate?: (membershipId: string) => Promise<NoteClosureGateEvaluation>;
}) {
  const evaluate = vi.fn(
    async (input: { membershipId: string }) =>
      (await options.evaluate?.(input.membershipId)) ??
      (input.membershipId === BLOCKED_MEMBERSHIP ? blocked : clear),
  );
  const policyGet = vi.fn(async () => ({ mode: options.mode ?? "block" }) as const);
  const app = buildServer({
    authenticate: createSessionAuthenticate({
      getSnapshot: async () => ({
        sessionId: "session-1",
        userId: USER,
        activeOrganizationId: ORG,
      }),
      getResolver: () => resolverFor(options.actor),
      organizationStage: liveOrganizationStage,
      noteClosureGate: createNoteClosureGate({ policyCache: { get: policyGet }, evaluate }),
      systemCredential: { token: SERVICE_TOKEN },
    }),
    security: { rateLimitEnabled: false },
  });
  const standIn = { config: { auditRead: { none: "a stand-in route for the gate test" } } };
  app.get(ALLOWED_URL, standIn, async () => ({ reached: "allowed" }));
  app.get(REFUSED_URL, standIn, async () => ({ reached: "refused" }));
  return { app, evaluate, policyGet };
}

describe("note-closure gate through the real authenticate hook", () => {
  it("a blocked clinician gets 403 NOTE_CLOSURE_REQUIRED outside the allowlist and still reaches an allowlisted route", async () => {
    const { app, evaluate } = serverFor({ actor: staffActor(BLOCKED_MEMBERSHIP) });

    const refused = await app.inject({ method: "GET", url: REFUSED_URL });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe("NOTE_CLOSURE_REQUIRED");
    expect(refused.json().error.details).toEqual([
      { field: "encounterId", code: "OLDEST_OPEN_NOTE", message: ENCOUNTER },
      { field: "deadlineAt", code: "DEADLINE", message: DEADLINE.toISOString() },
      { field: "overdueCount", code: "OVERDUE_COUNT", message: "2" },
    ]);
    expect(evaluate).toHaveBeenCalledTimes(1);

    const reached = await app.inject({ method: "GET", url: ALLOWED_URL });
    expect(reached.statusCode, reached.body).toBe(200);
    expect(reached.json()).toEqual({ reached: "allowed" });
    expect(evaluate).toHaveBeenCalledTimes(1); // the allowlisted route did no IO at all
  });

  it("a clinician with nothing overdue reaches both routes", async () => {
    const { app } = serverFor({ actor: staffActor(CLEAR_MEMBERSHIP) });
    expect((await app.inject({ method: "GET", url: REFUSED_URL })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: ALLOWED_URL })).statusCode).toBe(200);
  });

  it.each(["off", "warn"] as const)(
    "mode %s refuses nothing, even for a clinician who would be blocked",
    async (mode) => {
      const { app, evaluate } = serverFor({ actor: staffActor(BLOCKED_MEMBERSHIP), mode });
      expect((await app.inject({ method: "GET", url: REFUSED_URL })).statusCode).toBe(200);
      expect(evaluate).not.toHaveBeenCalled();
    },
  );

  it("a failing read is 503 NOTE_CLOSURE_UNAVAILABLE on the non-allowlisted route and invisible on the allowlisted one", async () => {
    const { app } = serverFor({
      actor: staffActor(BLOCKED_MEMBERSHIP),
      evaluate: async () => {
        throw new Error("database unavailable");
      },
    });
    const refused = await app.inject({ method: "GET", url: REFUSED_URL });
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.json().error.code).toBe("NOTE_CLOSURE_UNAVAILABLE");
    expect((await app.inject({ method: "GET", url: ALLOWED_URL })).statusCode).toBe(200);
  });

  it("a request that matches no route is not allowlisted: a blocked clinician gets the refusal, not a pass", async () => {
    const { app } = serverFor({ actor: staffActor(BLOCKED_MEMBERSHIP) });
    const res = await app.inject({ method: "GET", url: "/api/v1/no-such-route" });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("NOTE_CLOSURE_REQUIRED");
  });

  it("a non-staff session never reaches the gate", async () => {
    const { app, evaluate, policyGet } = serverFor({ actor: portalActor });
    expect((await app.inject({ method: "GET", url: REFUSED_URL })).statusCode).toBe(200);
    expect(policyGet).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("the machine credential bypasses the gate", async () => {
    const { app, evaluate, policyGet } = serverFor({ actor: staffActor(BLOCKED_MEMBERSHIP) });
    const res = await app.inject({
      method: "GET",
      url: REFUSED_URL,
      headers: { "x-internal-service-token": SERVICE_TOKEN, "x-internal-org-id": ORG },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(policyGet).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
