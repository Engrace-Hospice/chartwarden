// The visit-note closure gate's decision order (ADR-0113 D6), with a fake policy cache and a fake evaluator so every branch is
// reachable and every IO is countable: an allowlisted route does no IO; `off` / `warn` refuse nothing; `block` refuses a `blocked`
// verdict with 403 NOTE_CLOSURE_REQUIRED, caches only `clear` (5s, never past the block instant), never caches a block; and any
// failure on a non-allowlisted route is 503 NOTE_CLOSURE_UNAVAILABLE rather than a pass.
import { ChartWardenError, type DocumentationObligationMode } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import {
  NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES,
  NOTE_CLOSURE_CLEAR_TTL_MS,
  NOTE_CLOSURE_REQUIRED_CODE,
  NOTE_CLOSURE_UNAVAILABLE_CODE,
  type NoteClosureGateEvaluation,
  type NoteClosureGateRequest,
  createNoteClosureGate,
  noteClosureMayCall,
} from "../src/bootstrap/note-closure-gate";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "11111111-1111-4111-8111-222222222222";
const USER = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const OTHER_MEMBER = "33333333-3333-4333-8333-444444444444";
const ENCOUNTER = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-17T12:00:00.000Z");
const DEADLINE = new Date("2026-11-16T12:00:00.000Z");

const BLOCKED_ROUTE = { method: "GET", routeTemplate: "/api/v1/billing/claims" } as const;
const ALLOWED_ROUTE = {
  method: "POST",
  routeTemplate: "/api/v1/encounters/:encounterId/sign",
} as const;

const request = (overrides: Partial<NoteClosureGateRequest> = {}): NoteClosureGateRequest => ({
  ...BLOCKED_ROUTE,
  rawUrl: BLOCKED_ROUTE.routeTemplate,
  organizationId: ORG,
  userId: USER,
  membershipId: MEMBER,
  ...overrides,
});

const blocked: NoteClosureGateEvaluation = {
  verdict: "blocked",
  encounterId: ENCOUNTER,
  overdueCount: 3,
  decision: { deadlineAt: DEADLINE, blockFrom: DEADLINE },
};
const clear = (blockFrom: Date | null = null): NoteClosureGateEvaluation => ({
  verdict: "clear",
  encounterId: null,
  overdueCount: 0,
  decision: { deadlineAt: null, blockFrom },
});

function harness(options: {
  mode?: DocumentationObligationMode | "bogus";
  evaluation?: () => Promise<NoteClosureGateEvaluation>;
  policy?: () => Promise<{ mode: DocumentationObligationMode }>;
}) {
  let nowMs = NOW.getTime();
  const get = vi.fn(
    options.policy ??
      (async () => ({ mode: (options.mode ?? "block") as DocumentationObligationMode })),
  );
  const evaluate = vi.fn(options.evaluation ?? (async () => blocked));
  const onFailure = vi.fn();
  const gate = createNoteClosureGate({
    policyCache: { get },
    evaluate,
    now: () => new Date(nowMs),
    onFailure,
  });
  return {
    gate,
    get,
    evaluate,
    onFailure,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const refusalOf = async (promise: Promise<void>): Promise<ChartWardenError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ChartWardenError);
  return error as ChartWardenError;
};

describe("noteClosureMayCall - the allowlist match", () => {
  it("admits an exact METHOD + template pair and refuses a pair that differs in method", () => {
    expect(noteClosureMayCall({ ...ALLOWED_ROUTE, rawUrl: "/x" })).toBe(true);
    expect(
      noteClosureMayCall({
        method: "DELETE",
        routeTemplate: ALLOWED_ROUTE.routeTemplate,
        rawUrl: "/x",
      }),
    ).toBe(false);
  });

  it("refuses a request that matched no route (no template is never allowlisted)", () => {
    expect(
      noteClosureMayCall({ method: "GET", routeTemplate: undefined, rawUrl: "/api/v1/encounters" }),
    ).toBe(false);
  });

  it("matches on the template, not on a URL that merely looks allowed", () => {
    expect(
      noteClosureMayCall({
        method: "POST",
        routeTemplate: "/api/v1/billing/claims",
        rawUrl: "/api/v1/encounters/x/sign",
      }),
    ).toBe(false);
  });

  it("admits Better Auth's wildcard only for a path that decodes cleanly under /api/auth/", () => {
    const wildcard = (rawUrl: string) =>
      noteClosureMayCall({ method: "POST", routeTemplate: "/api/auth/*", rawUrl });
    expect(wildcard("/api/auth/sign-out")).toBe(true);
    expect(wildcard("/api/auth/get-session?x=1")).toBe(true);
    expect(wildcard("/api/auth/../v1/billing/claims")).toBe(false);
    expect(wildcard("/api/auth/%2e%2e/v1")).toBe(false);
    expect(wildcard("/api/auth/%E0%A4%A")).toBe(false);
    expect(wildcard("/api/auth\\x")).toBe(false);
    expect(wildcard("/api/v1/billing/claims")).toBe(false);
  });
});

describe("the gate - step 1: an allowlisted route does no IO", () => {
  it("passes without reading the policy or the evaluator, even when both would throw", async () => {
    const h = harness({
      policy: async () => {
        throw new Error("policy store down");
      },
      evaluation: async () => {
        throw new Error("evaluator down");
      },
    });
    await expect(
      h.gate.assertMayCall(request({ ...ALLOWED_ROUTE, rawUrl: ALLOWED_ROUTE.routeTemplate })),
    ).resolves.toBeUndefined();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.onFailure).not.toHaveBeenCalled();
  });
});

describe("the gate - step 2: the policy mode", () => {
  it.each(["off", "warn"] as const)(
    "%s refuses nothing and never runs the evaluator",
    async (mode) => {
      const h = harness({ mode });
      await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined();
      expect(h.get).toHaveBeenCalledWith(ORG, "visit_note");
      expect(h.evaluate).not.toHaveBeenCalled();
    },
  );

  it("an unknown mode is not a pass: 503", async () => {
    const h = harness({ mode: "bogus" });
    const error = await refusalOf(h.gate.assertMayCall(request()));
    expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
    expect(error.statusCode).toBe(503);
  });
});

describe("the gate - step 3: block mode", () => {
  it("refuses a blocked verdict 403 NOTE_CLOSURE_REQUIRED with the encounter, the deadline and the count (ids and instants only)", async () => {
    const h = harness({});
    const error = await refusalOf(h.gate.assertMayCall(request()));
    expect(error.code).toBe(NOTE_CLOSURE_REQUIRED_CODE);
    expect(error.statusCode).toBe(403);
    expect(error.details).toEqual([
      { field: "encounterId", code: "OLDEST_OPEN_NOTE", message: ENCOUNTER },
      { field: "deadlineAt", code: "DEADLINE", message: DEADLINE.toISOString() },
      { field: "overdueCount", code: "OVERDUE_COUNT", message: "3" },
    ]);
    expect(JSON.stringify(error.details)).not.toMatch(/patient|name|dob|ssn/i);
  });

  it("hands the evaluator the caller's org, user, membership, the instant and the policy it read", async () => {
    const h = harness({});
    await refusalOf(h.gate.assertMayCall(request()));
    expect(h.evaluate).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: USER,
      membershipId: MEMBER,
      now: NOW,
      policy: { mode: "block" },
    });
  });

  it("never caches a block: the next request evaluates again, so a signature or an override lifts it at once", async () => {
    let verdict = blocked;
    const h = harness({ evaluation: async () => verdict });
    await refusalOf(h.gate.assertMayCall(request()));
    verdict = clear();
    await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined();
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("passes a warn verdict (an active override) and does not cache it", async () => {
    const h = harness({ evaluation: async () => ({ ...blocked, verdict: "warn" }) });
    await h.gate.assertMayCall(request());
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("caches a clear verdict per organization + member for the TTL, then asks again", async () => {
    const h = harness({ evaluation: async () => clear() });
    await h.gate.assertMayCall(request());
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    h.advance(NOTE_CLOSURE_CLEAR_TTL_MS - 1);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("a cached clear is scoped to its member and its organization", async () => {
    const h = harness({ evaluation: async () => clear() });
    await h.gate.assertMayCall(request());
    await h.gate.assertMayCall(request({ membershipId: OTHER_MEMBER }));
    await h.gate.assertMayCall(request({ organizationId: OTHER_ORG }));
    expect(h.evaluate).toHaveBeenCalledTimes(3);
  });

  it("never trusts a cached clear past the instant the oldest note would start to block", async () => {
    const blockFrom = new Date(NOW.getTime() + 2_000);
    const h = harness({ evaluation: async () => clear(blockFrom) });
    await h.gate.assertMayCall(request());
    h.advance(1_999);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.gate.assertMayCall(request());
    expect(h.evaluate).toHaveBeenCalledTimes(2);
  });

  it("stays bounded: a full cache of live verdicts declines to remember one more, and still answers correctly", async () => {
    const h = harness({ evaluation: async () => clear() });
    for (let i = 0; i < NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES; i++) {
      await h.gate.assertMayCall(request({ membershipId: `member-${i}` }));
    }
    await h.gate.assertMayCall(request({ membershipId: "member-overflow" }));
    await h.gate.assertMayCall(request({ membershipId: "member-overflow" }));
    expect(h.evaluate).toHaveBeenCalledTimes(NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES + 2);
    await h.gate.assertMayCall(request({ membershipId: "member-0" }));
    expect(h.evaluate).toHaveBeenCalledTimes(NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES + 2);
    h.advance(NOTE_CLOSURE_CLEAR_TTL_MS);
    await h.gate.assertMayCall(request({ membershipId: "member-overflow" }));
    await h.gate.assertMayCall(request({ membershipId: "member-overflow" }));
    expect(h.evaluate).toHaveBeenCalledTimes(NOTE_CLOSURE_CLEAR_CACHE_MAX_ENTRIES + 3);
  });
});

describe("the gate - step 4: failures close", () => {
  it("a policy read that throws is 503 NOTE_CLOSURE_UNAVAILABLE and is reported with the organization id only", async () => {
    const cause = new Error("connection refused");
    const h = harness({
      policy: async () => {
        throw cause;
      },
    });
    const error = await refusalOf(h.gate.assertMayCall(request()));
    expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
    expect(error.statusCode).toBe(503);
    expect(h.onFailure).toHaveBeenCalledWith({ organizationId: ORG, error: cause });
  });

  it("an evaluator that throws is 503, a RangeError from the pure clock included", async () => {
    for (const failure of [
      new Error("db down"),
      new RangeError("thresholdHours must be positive"),
    ]) {
      const h = harness({
        evaluation: async () => {
          throw failure;
        },
      });
      const error = await refusalOf(h.gate.assertMayCall(request()));
      expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
      expect(error.statusCode).toBe(503);
    }
  });

  it("an unknown verdict is not a pass: 503", async () => {
    const h = harness({
      evaluation: async () => ({ ...blocked, verdict: "maybe" as unknown as "clear" }),
    });
    const error = await refusalOf(h.gate.assertMayCall(request()));
    expect(error.code).toBe(NOTE_CLOSURE_UNAVAILABLE_CODE);
  });

  it("a failed read is never cached: the next request retries", async () => {
    let fail = true;
    const h = harness({
      evaluation: async () => {
        if (fail) throw new Error("db down");
        return clear();
      },
    });
    await refusalOf(h.gate.assertMayCall(request()));
    fail = false;
    await expect(h.gate.assertMayCall(request())).resolves.toBeUndefined();
  });
});
