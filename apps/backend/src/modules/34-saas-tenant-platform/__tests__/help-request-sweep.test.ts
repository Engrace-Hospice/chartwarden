// The help-request expiry sweep over the in-memory store: an unanswered request is cancelled after 14 days, an approved one is
// resolved once its grant has ended, both by the system with no user named; a tick that finds nothing changes nothing. The same sweep
// runs on the real platform carrier in `m34-help-request.live.test.ts`.
import { beforeEach, describe, expect, it } from "vitest";
import type { HelpRequestRow } from "../help/help-request-store";
import {
  MEMORY_HELP_ACCOUNT_ID,
  MEMORY_HELP_ORG_ID,
  type MemoryHelpState,
  createMemoryHelpRequestRunner,
  createMemoryHelpState,
} from "../help/help-request-store-memory";
import {
  HELP_REQUEST_OPEN_MAX_AGE_DAYS,
  HELP_REQUEST_SWEEP_QUEUE,
  HELP_REQUEST_SWEEP_SCHEDULE,
  runHelpRequestSweep,
} from "../help/help-request-sweep";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;

let state: MemoryHelpState;
let counter = 0;

function seed(over: Partial<HelpRequestRow>): HelpRequestRow {
  counter += 1;
  const requestedAt = over.requestedAt ?? new Date(NOW.getTime() - HOUR);
  const row: HelpRequestRow = {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    organizationId: MEMORY_HELP_ORG_ID,
    tenantAccountId: MEMORY_HELP_ACCOUNT_ID,
    stepKey: null,
    message: "We cannot find our MAC enrolment letter",
    status: "open",
    requestedByMembershipId: "m-1",
    requestedByUserId: "u-1",
    requestedAt,
    cursorTs: requestedAt.toISOString(),
    supportConsentGrantId: null,
    approvedByMembershipId: null,
    approvedAt: null,
    closedByActorKind: null,
    closedByUserId: null,
    closedAt: null,
    closeNote: null,
    messagePurgedAt: null,
    ...over,
  };
  state.requests.set(row.id, row);
  return row;
}

const approvedOn = (grantId: string) =>
  seed({
    status: "approved",
    supportConsentGrantId: grantId,
    approvedByMembershipId: "m-admin",
    approvedAt: new Date(NOW.getTime() - 2 * HOUR),
  });

beforeEach(() => {
  state = createMemoryHelpState(() => NOW);
  counter = 0;
});

describe("the help-request sweep", () => {
  it("has its own queue name, every five minutes, and a 14 day patience", () => {
    expect(HELP_REQUEST_SWEEP_QUEUE).toBe("tenant.help_request_sweep");
    expect(HELP_REQUEST_SWEEP_SCHEDULE).toBe("*/5 * * * *");
    expect(HELP_REQUEST_OPEN_MAX_AGE_DAYS).toBe(14);
  });

  it("cancels an open request older than 14 days and leaves a younger one", async () => {
    const stale = seed({ requestedAt: new Date(NOW.getTime() - 15 * DAY) });
    const fresh = seed({ requestedAt: new Date(NOW.getTime() - 13 * DAY) });
    // a request exactly at the edge is kept: it is not OLDER than 14 days
    const edge = seed({ requestedAt: new Date(NOW.getTime() - 14 * DAY) });
    const result = await runHelpRequestSweep(createMemoryHelpRequestRunner(state), () => NOW);
    expect(result).toEqual({ cancelled: 1, resolved: 0 });
    expect(state.requests.get(stale.id)).toMatchObject({
      status: "cancelled",
      closedByActorKind: "system",
      closedByUserId: null,
      closedAt: NOW,
    });
    expect(state.requests.get(fresh.id)?.status).toBe("open");
    expect(state.requests.get(edge.id)?.status).toBe("open");
  });

  it("resolves an approved request whose grant expired or was revoked, and keeps one whose grant is live", async () => {
    state.grants.set("g-expired", {
      id: "g-expired",
      expiresAt: new Date(NOW.getTime() - HOUR),
      revokedAt: null,
    });
    state.grants.set("g-revoked", {
      id: "g-revoked",
      expiresAt: new Date(NOW.getTime() + HOUR),
      revokedAt: NOW,
    });
    state.grants.set("g-live", {
      id: "g-live",
      expiresAt: new Date(NOW.getTime() + HOUR),
      revokedAt: null,
    });
    const expired = approvedOn("g-expired");
    const revoked = approvedOn("g-revoked");
    const live = approvedOn("g-live");
    const result = await runHelpRequestSweep(createMemoryHelpRequestRunner(state), () => NOW);
    expect(result).toEqual({ cancelled: 0, resolved: 2 });
    for (const row of [expired, revoked]) {
      expect(state.requests.get(row.id)).toMatchObject({
        status: "resolved",
        closedByActorKind: "system",
        closedByUserId: null,
      });
    }
    expect(state.requests.get(live.id)?.status).toBe("approved");
  });

  it("is idempotent, and never touches an ended request", async () => {
    seed({ requestedAt: new Date(NOW.getTime() - 20 * DAY) });
    const ended = seed({
      status: "cancelled",
      requestedAt: new Date(NOW.getTime() - 30 * DAY),
      closedByActorKind: "tenant",
      closedByUserId: "u-1",
      closedAt: new Date(NOW.getTime() - 29 * DAY),
    });
    const runner = createMemoryHelpRequestRunner(state);
    expect(await runHelpRequestSweep(runner, () => NOW)).toEqual({ cancelled: 1, resolved: 0 });
    expect(await runHelpRequestSweep(runner, () => NOW)).toEqual({ cancelled: 0, resolved: 0 });
    expect(state.requests.get(ended.id)).toMatchObject({
      closedByActorKind: "tenant",
      closedByUserId: "u-1",
    });
  });
});
