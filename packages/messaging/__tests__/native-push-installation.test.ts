// ADR-0105 — a native install re-registering with a rotated token keeps one endpoint per phone.
import { describe, expect, it } from "vitest";
import { createInMemoryMessagingService } from "../src/store/in-memory-service";

const ORG = "org-1";
const USER = "user-1";
const INSTALL = "install_abcdef12";
const apns = (target: string, extra: Record<string, unknown> = {}) => ({
  channel: "push" as const,
  provider: "apns" as const,
  target,
  installId: INSTALL,
  environment: "production" as const,
  appVersion: "1.0.0",
  appBuild: "42",
  ...extra,
});

describe("native push installation (ADR-0105)", () => {
  it("replaces the token in place when the same install re-registers", async () => {
    const svc = createInMemoryMessagingService();
    const first = await svc.registerEndpoint(ORG, USER, apns("a".repeat(64)));
    const second = await svc.registerEndpoint(ORG, USER, apns("b".repeat(64), { appBuild: "43" }));

    expect(second.endpointId).toBe(first.endpointId);
    const list = await svc.listEndpoints(ORG, USER);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ provider: "apns", installId: INSTALL, appBuild: "43" });
  });

  it("keeps two phones as two endpoints", async () => {
    const svc = createInMemoryMessagingService();
    await svc.registerEndpoint(ORG, USER, apns("a".repeat(64)));
    await svc.registerEndpoint(ORG, USER, apns("b".repeat(64), { installId: "install_other99" }));
    expect(await svc.listEndpoints(ORG, USER)).toHaveLength(2);
  });

  it("never exposes the token and scopes the list to the caller", async () => {
    const svc = createInMemoryMessagingService();
    await svc.registerEndpoint(ORG, USER, apns("a".repeat(64)));
    expect(JSON.stringify(await svc.listEndpoints(ORG, USER))).not.toContain("a".repeat(64));
    expect(await svc.listEndpoints(ORG, "someone-else")).toEqual([]);
  });
});
