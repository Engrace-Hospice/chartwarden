// CW-RUST-M02 P1 — the daily parity sweep (AT-M02-11 unit level; the end-to-end version runs on the local stack).
import { describe, expect, it } from "vitest";
import type { RustClient } from "../client";
import type { BridgeLogger } from "../forwarder";
import { SWEEP_MAX_IN_FLIGHT, msUntilNextUtc, runParitySweep } from "../parity-sweep";
import { type AssertionSigner, SWEEP_CLASS } from "../signer";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function logger(): BridgeLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (o, m) => lines.push(JSON.stringify({ ...o, m })),
    warn: (o, m) => lines.push(JSON.stringify({ ...o, m })),
  };
}

function deps(over: {
  rust?: (org: string, user: string, call: number) => string[] | null;
  bun?: (org: string, user: string, call: number) => string[];
  counted?: number;
  delayMs?: number;
}) {
  const signed: Record<string, unknown>[] = [];
  const signer: AssertionSigner = {
    sign: (s) => {
      signed.push({ ...s });
      return `tok|${s.organizationId}|${s.userId}`;
    },
  };
  const calls = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const client: RustClient = {
    get: async (_path, tok) => {
      const [, org, user] = tok.split("|") as [string, string, string];
      const k = `r${org}${user}`;
      const n = (calls.get(k) ?? 0) + 1;
      calls.set(k, n);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, over.delayMs ?? 1));
      inFlight--;
      const p = over.rust ? over.rust(org, user, n) : ["patient.read"];
      return p === null
        ? { ok: false, reason: "connect" }
        : { ok: true, status: 200, contentType: "application/json", body: { permissions: p } };
    },
  };
  const members: Record<string, string[]> = { [ORG_A]: [u(1), u(2), u(3)], [ORG_B]: [u(4), u(5)] };
  const log = logger();
  return {
    signed,
    log,
    maxInFlight: () => maxInFlight,
    d: {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      listActiveMembers: async (org: string) => members[org] ?? [],
      countActiveMembers: async (org: string) => over.counted ?? (members[org] ?? []).length,
      freshPermissions: async (org: string, user: string) => {
        const k = `b${org}${user}`;
        const n = (calls.get(k) ?? 0) + 1;
        calls.set(k, n);
        return over.bun ? over.bun(org, user, n) : ["patient.read"];
      },
      signer,
      client,
      logger: log,
      runId: "sweep-test",
    },
  };
}

describe("runParitySweep", () => {
  it("compares every listed membership and reports a complete, clean run", async () => {
    const t = deps({});
    const s = await runParitySweep(t.d);
    expect(s).toMatchObject({
      orgs: 2,
      listed: 5,
      counted: 5,
      compared: 5,
      match: 5,
      unexplained: 0,
      errors: 0,
      stoppedEarly: false,
    });
    expect(t.log.lines.at(-1)).toContain('"complete":true');
  });

  it("signs sweep-class assertions bound to the one read-only route", async () => {
    const t = deps({});
    await runParitySweep(t.d);
    expect(t.signed).toHaveLength(5);
    for (const a of t.signed) {
      expect(a).toMatchObject({
        sessionClass: SWEEP_CLASS,
        sessionId: "sweep-test",
        method: "GET",
        path: "/api/v1/me/permissions",
      });
    }
  });

  it(`never has more than ${SWEEP_MAX_IN_FLIGHT} Rust calls in flight`, async () => {
    const t = deps({ delayMs: 10 });
    await runParitySweep(t.d);
    expect(t.maxInFlight()).toBeLessThanOrEqual(SWEEP_MAX_IN_FLIGHT);
  });

  it("flags a planted Rust difference as unexplained, with ids and counts only", async () => {
    const t = deps({
      rust: (_o, user) =>
        user === u(2) ? ["patient.read", "role.manage", "audit.read"] : ["patient.read"],
    });
    const s = await runParitySweep(t.d);
    expect(s).toMatchObject({ unexplained: 1, match: 4 });
    const line = JSON.parse(
      t.log.lines.find((l) => l.includes('"unexplained"') && l.includes(u(2))) as string,
    );
    expect(line).toMatchObject({ org_id: ORG_A, user_id: u(2), only_bun: 0, only_rust: 2 });
    expect(t.log.lines.join("\n")).not.toMatch(/role\.manage|audit\.read|patient\.read/);
  });

  it("classifies a difference that disappears on re-read as explained:race", async () => {
    const t = deps({
      bun: (_o, user, call) =>
        user === u(3) && call === 1 ? ["patient.read", "visit.read"] : ["patient.read"],
    });
    const s = await runParitySweep(t.d);
    expect(s).toMatchObject({ explainedRace: 1, unexplained: 0, match: 4 });
  });

  it("is incomplete when the independent count disagrees with the list", async () => {
    const t = deps({ counted: 4 });
    const s = await runParitySweep(t.d);
    expect(s.counted).toBe(8);
    expect(t.log.lines.at(-1)).toContain('"complete":false');
  });

  it("stops early once errors exceed 1 % of the planned pairs (min 1)", async () => {
    const t = deps({ rust: () => null });
    const s = await runParitySweep(t.d);
    expect(s.stoppedEarly).toBe(true);
    expect(s.compared).toBe(0);
    expect(t.log.lines.at(-1)).toContain('"complete":false');
  });
});

describe("msUntilNextUtc", () => {
  it("returns the delay to the next occurrence, today or tomorrow", () => {
    const now = new Date("2026-11-01T10:00:00Z");
    expect(msUntilNextUtc("10:17", now)).toBe(17 * 60_000);
    expect(msUntilNextUtc("09:00", now)).toBe(23 * 3_600_000);
    expect(msUntilNextUtc("10:00", now)).toBe(24 * 3_600_000);
    expect(() => msUntilNextUtc("7:00", now)).toThrow();
  });
});
