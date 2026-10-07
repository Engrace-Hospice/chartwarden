// GAP-173 — the org-less platform-ops notice sink: always logs, posts the webhook only when configured, and a
// failing webhook never throws into the caller.
import { describe, expect, it, vi } from "vitest";
import { buildPlatformOpsNoticeSink } from "../src/bootstrap/platform-ops-notices";

const NOTICE = {
  kind: "mdm.duplicate_suspected",
  summary: "2 new suspected duplicates",
  details: { proposed: { physician: 2, facility: 0 } },
  correlationId: "m40-duplicate-suspected:2026-10-06",
};

describe("buildPlatformOpsNoticeSink", () => {
  it("logs the notice and makes no request when no webhook is configured", () => {
    const log = vi.fn();
    const fetchImpl = vi.fn();
    buildPlatformOpsNoticeSink({ log, fetchImpl: fetchImpl as unknown as typeof fetch })(NOTICE);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain("mdm.duplicate_suspected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the notice as JSON to the webhook when configured", () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    buildPlatformOpsNoticeSink({
      webhookUrl: "https://ops.example/hook",
      log: vi.fn(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })(NOTICE);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, { body: string; method: string }];
    expect(url).toBe("https://ops.example/hook");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({
      kind: NOTICE.kind,
      correlationId: NOTICE.correlationId,
    });
  });

  it("swallows a webhook failure (logged, never thrown into the scan)", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect(() =>
      buildPlatformOpsNoticeSink({
        webhookUrl: "https://ops.example/hook",
        log,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })(NOTICE),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toHaveBeenCalledTimes(2);
  });
});
