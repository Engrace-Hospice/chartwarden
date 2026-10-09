// GAP-032 — the platform page to WardenX ops that lets the SOS ladder enter the emergency terminus.
import { describe, expect, it } from "vitest";

import { createWebhookOpsPager } from "../src/modules/20-field-safety/jobs/terminus-port";

const input = {
  organizationId: "org-1",
  providerEntityId: "pe-1",
  sosAlertId: "sos-1",
  loopIteration: 0,
  at: "2026-10-08T12:00:00.000Z",
};

describe("GAP-032 webhook ops pager", () => {
  it("refuses a non-https URL at construction", () => {
    expect(() => createWebhookOpsPager({ url: "http://ops.example/hook" })).toThrow(/https/);
  });

  it("posts a critical page carrying ids only, with the bearer token", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const pager = createWebhookOpsPager({
      url: "https://ops.example/hook",
      token: "t0ken",
      fetchImpl: async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return { status: 202 };
      },
    });
    await pager.pageOps(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe("Bearer t0ken");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      severity: "critical",
      sosAlertId: "sos-1",
      organizationId: "org-1",
    });
  });

  it("rejects when the receiver does not acknowledge", async () => {
    const pager = createWebhookOpsPager({
      url: "https://ops.example/hook",
      fetchImpl: async () => ({ status: 503 }),
    });
    await expect(pager.pageOps(input)).rejects.toThrow(/HTTP 503/);
  });
});
