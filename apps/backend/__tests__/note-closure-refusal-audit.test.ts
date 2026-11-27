// CW-AC-47 — the audit event of a closure-gate refusal: what it records, under whose tenant context, that it names no patient and no URL, and that a
// failure to write it is reported and never thrown (the 403 it records is answered either way). The write over the real database, RLS and the audit
// table is m8-note-closure.live.test.ts.
import {
  type DbClient,
  createCommitTracker,
  currentCommitTracker,
  runWithCommitTracker,
} from "@chartwarden/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSURE_REFUSED_AUDIT_EVENT,
  type ClosureRefusalFacts,
  recordClosureRefusal,
} from "../src/modules/08-encounters/closure/refusal-audit";

const state = vi.hoisted(() => ({
  written: [] as { tx: unknown; context: unknown; input: Record<string, unknown> }[],
  orgContexts: [] as unknown[],
  auditError: null as unknown,
  onAudit: null as (() => void) | null,
}));

vi.mock("@chartwarden/audit", () => ({
  audit: vi.fn(async (tx: unknown, context: unknown, input: Record<string, unknown>) => {
    state.onAudit?.();
    if (state.auditError) throw state.auditError;
    state.written.push({ tx, context, input });
  }),
}));
vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: vi.fn(async (_db: unknown, context: unknown, fn: (tx: unknown) => unknown) => {
    state.orgContexts.push(context);
    return fn({ tx: "the org transaction" });
  }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const ENCOUNTER = "44444444-4444-4444-8444-444444444444";
const refusal = (over: Partial<ClosureRefusalFacts> = {}): ClosureRefusalFacts => ({
  organizationId: ORG,
  userId: USER,
  membershipId: MEMBER,
  encounterId: ENCOUNTER,
  overdueCount: 3,
  method: "GET",
  routeTemplate: "/api/v1/billing/claims",
  refused: 7,
  ...over,
});

beforeEach(() => {
  state.written.length = 0;
  state.orgContexts.length = 0;
  state.auditError = null;
  state.onAudit = null;
});

describe("recordClosureRefusal", () => {
  it("names the event in the m8 namespace the action catalog owns", () => {
    expect(CLOSURE_REFUSED_AUDIT_EVENT).toBe("m8.encounter.closure_refused");
  });

  it("writes one denied, warn, compliance-retention event about the oldest open note, attributed to the refused user", async () => {
    const failures: unknown[] = [];
    await recordClosureRefusal({} as DbClient, refusal(), (e) => failures.push(e));
    expect(failures).toEqual([]);
    expect(state.written).toHaveLength(1);
    expect(state.written[0]?.context).toMatchObject({ organizationId: ORG, userId: USER });
    expect(state.written[0]?.input).toMatchObject({
      eventType: "m8.encounter.closure_refused",
      resourceKind: "encounter",
      resourceId: ENCOUNTER,
      outcome: "denied",
      severity: "warn",
      retentionClass: "compliance",
      context: {
        membershipId: MEMBER,
        method: "GET",
        routeTemplate: "/api/v1/billing/claims",
        overdueCount: 3,
        refused: 7,
      },
    });
  });

  it("runs under the refused member's own tenant context, on its own transaction", async () => {
    await recordClosureRefusal({} as DbClient, refusal(), () => {});
    expect(state.orgContexts).toEqual([{ organizationId: ORG, userId: USER }]);
    expect(state.written[0]?.tx).toEqual({ tx: "the org transaction" });
  });

  it("carries ids, a route template and counts only: no patient, no URL, no free text", async () => {
    await recordClosureRefusal({} as DbClient, refusal(), () => {});
    const keys = Object.keys((state.written[0]?.input.context ?? {}) as object).sort();
    expect(keys).toEqual(["membershipId", "method", "overdueCount", "refused", "routeTemplate"]);
    expect(JSON.stringify(state.written[0]?.input)).not.toMatch(
      /patientId|rawUrl|reason|justification/i,
    );
  });

  it("leaves the resource id out when the member has no open note to name, and records a null route for the EVV batch", async () => {
    await recordClosureRefusal(
      {} as DbClient,
      refusal({ encounterId: null, method: null, routeTemplate: null }),
      () => {},
    );
    expect(state.written[0]?.input).not.toHaveProperty("resourceId");
    expect(state.written[0]?.input.context).toMatchObject({ method: null, routeTemplate: null });
  });

  it("runs outside the request's commit tracker, so a keyed retry of the refused request is still released (CW-AC-36)", async () => {
    const seen: unknown[] = [];
    state.onAudit = () => seen.push(currentCommitTracker());
    const tracker = createCommitTracker();
    await runWithCommitTracker(tracker, async () => {
      expect(currentCommitTracker()).toBe(tracker);
      await recordClosureRefusal({} as DbClient, refusal(), () => {});
      expect(currentCommitTracker()).toBe(tracker); // the request's own context is untouched afterwards
    });
    expect(seen).toEqual([undefined]); // while the write ran, no request owned it
  });

  it("reports a failed write and never throws it: the refusal it records is answered either way", async () => {
    state.auditError = new Error("audit insert failed");
    const failures: unknown[] = [];
    await expect(
      recordClosureRefusal({} as DbClient, refusal(), (e) => failures.push(e)),
    ).resolves.toBeUndefined();
    expect(failures).toEqual([state.auditError]);
    expect(state.written).toEqual([]);
  });
});
