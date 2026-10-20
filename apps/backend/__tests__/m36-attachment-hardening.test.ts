// M36 WP 1.5 hardening — abortable calls, the tick's fair-share/phase budgets, the storage quota env. No database.
import { type Server, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createM22BackedAttachmentStorage } from "../src/m36-attachment-storage";
import {
  DEFAULT_ORG_ATTACHMENT_QUOTA_BYTES,
  DEFAULT_USER_ATTACHMENT_QUOTA_BYTES,
  attachmentQuotaFromEnv,
} from "../src/modules/36-messaging/attachments/attachment-policy";
import {
  fairShareMs,
  runWithDeadline,
  throwIfAborted,
} from "../src/modules/36-messaging/attachments/attachment-scan-gate";
import { attachmentScanTick } from "../src/modules/36-messaging/attachments/attachment-scan-worker";
import { createClamdScanner } from "../src/modules/36-messaging/attachments/attachment-scanners";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runWithDeadline: the work is aborted, and the caller waits until it has really stopped", () => {
  it("aborts the signal at the deadline and rejects only AFTER the work stopped", async () => {
    let stoppedAt = 0;
    const started = Date.now();
    const result = runWithDeadline(
      (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => {
            // cleanup takes a moment (a socket closing): the caller must still be waiting for it
            setTimeout(() => {
              stoppedAt = Date.now();
              reject(new Error("stopped"));
            }, 80);
          });
        }),
      40,
      () => new Error("deadline"),
    );
    await expect(result).rejects.toThrow("deadline");
    const settledAt = Date.now();
    expect(stoppedAt).toBeGreaterThan(0);
    expect(settledAt).toBeGreaterThanOrEqual(stoppedAt); // never before the work stopped
    expect(stoppedAt - started).toBeGreaterThanOrEqual(100);
  });

  it("a port that ignores the signal is given up on after the grace (no wedge), still as the deadline error", async () => {
    const started = Date.now();
    await expect(
      runWithDeadline(
        () => new Promise<never>(() => undefined),
        30,
        () => new Error("deadline"),
        40,
      ),
    ).rejects.toThrow("deadline");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("passes a result and a non-deadline error through untouched", async () => {
    await expect(
      runWithDeadline(
        async () => 7,
        1_000,
        () => new Error("deadline"),
      ),
    ).resolves.toBe(7);
    await expect(
      runWithDeadline(
        async () => {
          throw new Error("boom");
        },
        1_000,
        () => new Error("deadline"),
      ),
    ).rejects.toThrow("boom");
  });

  it("throwIfAborted only throws once the signal fired", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    controller.abort(new Error("late"));
    expect(() => throwIfAborted(controller.signal)).toThrow("late");
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });
});

describe("clamd adapter: abort destroys the socket", () => {
  let server: Server | undefined;
  afterEach(
    () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
  );

  it("an aborted scan rejects at once and the connection is really closed (clamd never answers)", async () => {
    let serverSawClose: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      serverSawClose = resolve;
    });
    const port = await new Promise<number>((resolve) => {
      server = createServer((socket) => {
        socket.on("data", () => undefined); // swallow the stream, never reply
        socket.on("close", () => serverSawClose());
      }).listen(0, "127.0.0.1", () => resolve((server?.address() as { port: number }).port));
    });
    const scanner = createClamdScanner({ host: "127.0.0.1", port, timeoutMs: 60_000 });
    const controller = new AbortController();
    const scan = scanner.scan({
      bytes: new TextEncoder().encode("%PDF-1.4"),
      mimeType: "application/pdf",
      signal: controller.signal,
    });
    await sleep(50); // connected and streaming
    controller.abort(new Error("deadline"));
    await expect(scan).rejects.toThrow("deadline");
    await closed; // the server saw the socket close: nothing keeps running to the 60 s timeout
  });

  it("an already-aborted signal never opens a connection", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already"));
    const scanner = createClamdScanner({ host: "127.0.0.1", port: 1, timeoutMs: 60_000 });
    await expect(
      scanner.scan({ bytes: new Uint8Array(), mimeType: "text/plain", signal: controller.signal }),
    ).rejects.toThrow("already");
  });
});

describe("the M22-backed storage port forwards the abort signal", () => {
  it("inspect and destroyObject hand the signal to the object store", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const store = {
      inspectObject: async (args: { signal?: AbortSignal }) => {
        seen.push(args.signal);
        return null;
      },
      destroyAllVersions: async (args: { signal?: AbortSignal }) => {
        seen.push(args.signal);
      },
    };
    const port = createM22BackedAttachmentStorage({
      publicStore: store as never,
      internalStore: store as never,
    });
    const signal = new AbortController().signal;
    await port.inspect({ organizationId: "o", objectKey: "k", signal });
    await port.destroyObject({ organizationId: "o", objectKey: "k", signal });
    expect(seen).toEqual([signal, signal]);
  });
});

describe("the tick: fair shares and independent phase budgets", () => {
  const orgs = (n: number) => ({
    listActiveOrgs: async () =>
      Array.from({ length: n }, (_, i) => ({ organizationId: `org-${i}` })),
  });
  const zero = {
    clean: 0,
    quarantined: 0,
    deferred: 0,
    scannerFailures: 0,
    storeFailures: 0,
    scanUnavailable: 0,
  };

  it("fairShareMs is the unspent budget over the orgs still to go", () => {
    expect(fairShareMs(30_000, 3)).toBe(10_000);
    expect(fairShareMs(20_000, 2)).toBe(10_000);
    expect(fairShareMs(-5, 4)).toBe(0);
    expect(fairShareMs(1_000, 0)).toBe(1_000);
  });

  it("a slow org is cut at its share, so every later org gets its own full share (deterministic, not probabilistic)", async () => {
    let clock = 1_000_000;
    const slices: Record<string, number> = {};
    await attachmentScanTick({
      activeOrgs: orgs(3),
      nowMs: () => clock,
      budgetMs: 30_000,
      reapBudgetMs: 3_000,
      service: {
        scanPendingForOrg: async (org, opts) => {
          slices[org] = opts?.budgetMs ?? -1;
          clock += opts?.budgetMs ?? 0; // the org drags until its slice is spent
          return zero;
        },
        reapOrphansForOrg: async () => ({ reaped: 0, failed: 0, skippedLegalHold: 0 }),
      },
    });
    expect(Object.values(slices)).toEqual([10_000, 10_000, 10_000]); // rotation reorders, shares are equal
  });

  it("an org that finishes early hands its unused time to the orgs after it (work-conserving)", async () => {
    let clock = 5_000_000;
    const slices: number[] = [];
    await attachmentScanTick({
      activeOrgs: orgs(3),
      nowMs: () => clock,
      budgetMs: 30_000,
      reapBudgetMs: 3_000,
      service: {
        scanPendingForOrg: async (_org, opts) => {
          slices.push(opts?.budgetMs ?? -1);
          return zero; // nothing to scan: spends no time
        },
        reapOrphansForOrg: async () => ({ reaped: 0, failed: 0, skippedLegalHold: 0 }),
      },
    });
    expect(slices).toEqual([10_000, 15_000, 30_000]);
  });

  it("the reap phase has its own budget: a scan phase that used everything does not starve it, and vice versa", async () => {
    let clock = 9_000_000;
    const reapSlices: number[] = [];
    await attachmentScanTick({
      activeOrgs: orgs(2),
      nowMs: () => clock,
      budgetMs: 10_000,
      reapBudgetMs: 4_000,
      service: {
        scanPendingForOrg: async (_org, opts) => {
          clock += opts?.budgetMs ?? 0; // scanning burns the whole scan budget
          return zero;
        },
        reapOrphansForOrg: async (_org, opts) => {
          reapSlices.push(opts?.budgetMs ?? -1);
          return { reaped: 1, failed: 0, skippedLegalHold: 0 };
        },
      },
    });
    expect(reapSlices).toEqual([2_000, 4_000]); // measured from the reap phase's own start (the 2nd org inherits the 1st's unused time)
  });

  it("a scan-phase failure does not skip the reap phase, and the error still surfaces", async () => {
    let reaped = 0;
    await expect(
      attachmentScanTick({
        activeOrgs: orgs(2),
        service: {
          scanPendingForOrg: async () => {
            throw new Error("database down");
          },
          reapOrphansForOrg: async () => {
            reaped += 1;
            return { reaped: 1, failed: 0, skippedLegalHold: 0 };
          },
        },
      }),
    ).rejects.toThrow(/attachment_scan failed for 2 of 2/);
    expect(reaped).toBe(2);
  });

  it("sums the scan and reap results", async () => {
    const out = await attachmentScanTick({
      activeOrgs: orgs(2),
      service: {
        scanPendingForOrg: async () => ({ ...zero, clean: 2, scanUnavailable: 1 }),
        reapOrphansForOrg: async () => ({ reaped: 3, failed: 1, skippedLegalHold: 2 }),
      },
    });
    expect(out).toEqual({
      ...zero,
      clean: 4,
      scanUnavailable: 2,
      reap: { reaped: 6, failed: 2, skippedLegalHold: 4 },
    });
  });
});

describe("attachment storage quota env", () => {
  it("defaults when unset, and accepts a positive integer", () => {
    expect(attachmentQuotaFromEnv({})).toEqual({
      orgBytes: DEFAULT_ORG_ATTACHMENT_QUOTA_BYTES,
      userBytes: DEFAULT_USER_ATTACHMENT_QUOTA_BYTES,
    });
    expect(
      attachmentQuotaFromEnv({
        MESSAGING_ATTACHMENT_ORG_QUOTA_BYTES: "1000000",
        MESSAGING_ATTACHMENT_USER_QUOTA_BYTES: " 250000 ",
      }),
    ).toEqual({ orgBytes: 1_000_000, userBytes: 250_000 });
  });

  it("ignores garbage, zero, negatives and fractions (a typo must not switch the quota off)", () => {
    for (const bad of ["", "abc", "0", "-5", "1.5", "1e9", "NaN"]) {
      expect(
        attachmentQuotaFromEnv({
          MESSAGING_ATTACHMENT_ORG_QUOTA_BYTES: bad,
          MESSAGING_ATTACHMENT_USER_QUOTA_BYTES: bad,
        }),
      ).toEqual({
        orgBytes: DEFAULT_ORG_ATTACHMENT_QUOTA_BYTES,
        userBytes: DEFAULT_USER_ATTACHMENT_QUOTA_BYTES,
      });
    }
  });
});
