import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";
import { registerClaimMdOperationalMetrics } from "../claimmd-operational-metrics";

describe("Claim.MD operational metrics", () => {
  it("records bounded outcomes and aggregate queue measures without identifier labels", async () => {
    const registry = new Registry();
    const metrics = registerClaimMdOperationalMetrics(registry);
    metrics.record("identity_resolution", { pending: 4, resolved: 2, ambiguous: 1, oldestUnresolvedSeconds: 90 });
    metrics.record("era_capture", { code: "FETCH_FAILED", discovered: 3, failed: 1 });
    const exposition = await registry.metrics();
    expect(exposition).toContain('worker="identity_resolution",outcome="success"');
    expect(exposition).toContain('worker="era_capture",outcome="failure"');
    expect(exposition).toContain('worker="identity_resolution",measure="oldest_age_seconds"} 90');
    expect(exposition).not.toMatch(/organization|provider|patient|era_id|account_reference/i);
  });

  it("samples durable values lazily and rejects unbounded labels", async () => {
    const registry = new Registry();
    registerClaimMdOperationalMetrics(registry, async () => [
      { worker: "era_capture", measure: "capture_discovered", value: 7 },
      { worker: "era_capture", measure: "patient-123", value: 1 },
    ]);
    await registry.metrics();
    const exposition = await registry.metrics();
    expect(exposition).toContain('worker="era_capture",measure="capture_discovered"} 7');
    expect(exposition).not.toContain("patient-123");
    expect(exposition).toContain("chartwarden_claimmd_durable_metrics_read_success 1");
  });

  it("surfaces durable query failure without throwing from the scrape", async () => {
    const registry = new Registry();
    registerClaimMdOperationalMetrics(registry, async () => { throw new Error("sensitive database detail"); });
    const exposition = await registry.metrics();
    expect(exposition).toContain("chartwarden_claimmd_durable_metrics_read_success 0");
    expect(exposition).not.toContain("sensitive database detail");
  });
});
