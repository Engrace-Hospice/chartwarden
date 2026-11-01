// CW-RUST-M02 P1 — the daily parity sweep (AT-M02-11 unit level; the end-to-end version runs on the local stack).
import { describe, expect, it, vi } from "vitest";
import type { RustClient } from "../client";
import type { BridgeLogger } from "../forwarder";
import {
  SWEEP_MAX_IN_FLIGHT,
  bounded,
  msUntilNextUtc,
  runParitySweep,
  scheduleDailyUtc,
} from "../parity-sweep";
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

describe("review round 1 hardening", () => {
  it("counts an org whose member list fails, keeps comparing the others, and reports incomplete", async () => {
    const t = deps({});
    const listActiveMembers = t.d.listActiveMembers;
    const s = await runParitySweep({
      ...t.d,
      listActiveMembers: async (org: string) => {
        if (org === ORG_B) throw Object.assign(new Error("db"), { name: "DatabaseError" });
        return listActiveMembers(org);
      },
    });
    expect(s).toMatchObject({ orgErrors: 1, compared: 3, match: 3 });
    expect(t.log.lines.join("\n")).toContain('"error":"DatabaseError"');
    expect(t.log.lines.at(-1)).toContain('"complete":false');
  });

  it("stops between pairs when aborted and reports incomplete", async () => {
    const ac = new AbortController();
    ac.abort();
    const t = deps({});
    const s = await runParitySweep({ ...t.d, signal: ac.signal });
    expect(s.aborted).toBe(true);
    expect(s.compared).toBe(0);
    expect(t.log.lines.at(-1)).toContain('"complete":false');
  });
});

describe("scheduleDailyUtc", () => {
  it("fires daily, skips while a run is still going, aborts at the deadline and on stop, logs failures by name", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
    const log = logger();
    const signals: AbortSignal[] = [];
    let settle: (() => void) | undefined;
    let runs = 0;
    const stop = scheduleDailyUtc(
      "10:17",
      (signal) => {
        runs++;
        signals.push(signal);
        if (runs === 2)
          return Promise.reject(
            Object.assign(new Error("secret detail"), { name: "TimeoutError" }),
          );
        return new Promise<void>((r) => {
          settle = r;
        });
      },
      log,
      60 * 60_000,
    );
    await vi.advanceTimersByTimeAsync(17 * 60_000);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(signals[0]?.aborted).toBe(true); // deadline
    await vi.advanceTimersByTimeAsync(23 * 3_600_000);
    expect(runs).toBe(1); // still running (never settled): skipped, schedule alive
    expect(log.lines.join("\n")).toContain("sweep_skipped_still_running");
    settle?.();
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(log.lines.join("\n")).toContain('"error":"TimeoutError"');
    expect(log.lines.join("\n")).not.toContain("secret detail");
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(runs).toBe(3);
    stop();
    expect(signals[2]?.aborted).toBe(true); // stop aborts the in-flight run
    await vi.advanceTimersByTimeAsync(48 * 3_600_000);
    expect(runs).toBe(3);
    vi.useRealTimers();
  });
});

describe("review round 2 (ChatGPT P1)", () => {
  it("a skipped (non-UUID) membership makes the run incomplete", async () => {
    const t = deps({});
    const listActiveMembers = t.d.listActiveMembers;
    const s = await runParitySweep({
      ...t.d,
      listActiveMembers: async (org: string) =>
        org === ORG_B ? ["system", u(5)] : listActiveMembers(org),
    });
    expect(s).toMatchObject({ skipped: 1, compared: 4 });
    expect(t.log.lines.join("\n")).toContain("skipped_non_uuid");
    expect(t.log.lines.at(-1)).toContain('"complete":false');
  });

  it("a hung org list ends at the per-operation limit with an INCOMPLETE summary", async () => {
    const t = deps({});
    const s = await runParitySweep({
      ...t.d,
      listActiveOrgs: () => new Promise(() => {}),
      opTimeoutMs: 20,
    });
    expect(s).toMatchObject({ listFailed: true, compared: 0 });
    expect(t.log.lines.at(-1)).toContain("summary_incomplete");
  });

  it("a hung member query on one org is counted, and the other orgs are still compared", async () => {
    const t = deps({});
    const listActiveMembers = t.d.listActiveMembers;
    const s = await runParitySweep({
      ...t.d,
      listActiveMembers: (org: string) =>
        org === ORG_A ? new Promise(() => {}) : listActiveMembers(org),
      opTimeoutMs: 20,
    });
    expect(s).toMatchObject({ orgErrors: 1, compared: 2, match: 2 });
    expect(t.log.lines.at(-1)).toContain('"complete":false');
  });

  it("an abort during a hung comparison ends the run immediately with a summary", async () => {
    const ac = new AbortController();
    const t = deps({});
    const run = runParitySweep({
      ...t.d,
      freshPermissions: () => new Promise(() => {}),
      signal: ac.signal,
      opTimeoutMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const s = await run;
    expect(s.aborted).toBe(true);
    expect(t.log.lines.at(-1)).toContain("summary_incomplete");
  });

  it("an errored comparison makes the run incomplete even below the stop-early threshold", async () => {
    let first = true;
    const t = deps({
      rust: () => {
        if (first) {
          first = false;
          return null;
        }
        return ["patient.read"];
      },
    });
    const s = await runParitySweep(t.d);
    expect(s).toMatchObject({ errors: 1, compared: 4, stoppedEarly: false });
    expect(t.log.lines.at(-1)).toContain('"complete":false');
  });
});

describe("review round 4 (ChatGPT focused round 2, finding C)", () => {
  /** An AbortSignal stand-in that counts live listeners. */
  function countingSignal() {
    const ac = new AbortController();
    let live = 0;
    const add = ac.signal.addEventListener.bind(ac.signal);
    const remove = ac.signal.removeEventListener.bind(ac.signal);
    Object.assign(ac.signal, {
      addEventListener: (...a: Parameters<AbortSignal["addEventListener"]>) => {
        live++;
        add(...a);
      },
      removeEventListener: (...a: Parameters<AbortSignal["removeEventListener"]>) => {
        live--;
        remove(...a);
      },
    });
    return { ac, live: () => live };
  }

  it("bounded() removes its abort listener when the TIMEOUT wins over a never-settling promise", async () => {
    const { ac, live } = countingSignal();
    let abandoned = 0;
    await expect(
      bounded(new Promise(() => {}), 10, ac.signal, () => {
        abandoned++;
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(live()).toBe(0);
    expect(abandoned).toBe(1);
  });

  it("bounded() removes its listener on success and failure, and never counts those as abandoned", async () => {
    const { ac, live } = countingSignal();
    let abandoned = 0;
    const onAbandon = () => {
      abandoned++;
    };
    await expect(bounded(Promise.resolve(1), 1_000, ac.signal, onAbandon)).resolves.toBe(1);
    await expect(
      bounded(Promise.reject(new Error("x")), 1_000, ac.signal, onAbandon),
    ).rejects.toThrow("x");
    expect(live()).toBe(0);
    expect(abandoned).toBe(0);
  });

  it("bounded() settles once: an abort after the timeout does nothing more", async () => {
    const { ac, live } = countingSignal();
    let abandoned = 0;
    const p = bounded(new Promise(() => {}), 10, ac.signal, () => {
      abandoned++;
    });
    await expect(p).rejects.toMatchObject({ name: "TimeoutError" });
    ac.abort();
    expect(abandoned).toBe(1);
    expect(live()).toBe(0);
  });

  it("an abort while waiting removes the listener and counts one abandoned operation", async () => {
    const { ac, live } = countingSignal();
    let abandoned = 0;
    const p = bounded(new Promise(() => {}), 60_000, ac.signal, () => {
      abandoned++;
    });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "SweepAbort" });
    expect(live()).toBe(0);
    expect(abandoned).toBe(1);
  });

  it("the sweep summary reports abandoned operations", async () => {
    const t = deps({});
    const listActiveMembers = t.d.listActiveMembers;
    const s = await runParitySweep({
      ...t.d,
      listActiveMembers: (org: string) =>
        org === ORG_A ? new Promise(() => {}) : listActiveMembers(org),
      opTimeoutMs: 20,
    });
    expect(s.abandoned).toBe(1);
    expect(t.log.lines.at(-1)).toContain('"abandoned":1');
  });
});
