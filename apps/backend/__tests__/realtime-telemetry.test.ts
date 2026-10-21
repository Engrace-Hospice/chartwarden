import { Registry } from "prom-client";
import { describe, expect, it, vi } from "vitest";
import { type RealtimeAuditEvent, createRealtimeTelemetry } from "../src/bootstrap/realtime";

const ids = { userId: "u1", organizationId: "o1", sessionId: "s1" };

function setup(audit = vi.fn(async (_e: RealtimeAuditEvent) => {})) {
  const registry = new Registry();
  const onAuditError = vi.fn();
  const log = createRealtimeTelemetry(registry, {
    handle: () => undefined,
    log: () => {},
    audit,
    onAuditError,
  });
  return { registry, log, audit, onAuditError };
}

describe("realtime telemetry (ADR-0054 item 12)", () => {
  it("audits connect and disconnect, flagging server-ended sockets as forced", async () => {
    const { log, audit } = setup();
    log("realtime.connect", ids);
    log("realtime.disconnect", { ...ids, reason: "server namespace disconnect", durationMs: 5 });
    log("realtime.disconnect", { ...ids, reason: "transport close", durationMs: 7 });
    expect(audit.mock.calls.map(([e]) => [e.kind, e.forced])).toEqual([
      ["connected", undefined],
      ["disconnected", true],
      ["disconnected", false],
    ]);
  });

  it("counts refusals and bounds unknown reasons, without auditing them", async () => {
    const { registry, log, audit } = setup();
    log("realtime.refused", { reason: "rate_limited" });
    log("realtime.refused", { reason: "made up by a caller" });
    expect(audit).not.toHaveBeenCalled();
    const text = await registry.metrics();
    expect(text).toContain('chartwarden_realtime_refused_total{reason="rate_limited"} 1');
    expect(text).toContain('chartwarden_realtime_refused_total{reason="other"} 1');
  });

  it("reports an audit failure instead of throwing", async () => {
    const { log, onAuditError } = setup(vi.fn().mockRejectedValue(new Error("db down")));
    log("realtime.connect", ids);
    await new Promise((r) => setTimeout(r, 0));
    expect(onAuditError).toHaveBeenCalledOnce();
  });
});
