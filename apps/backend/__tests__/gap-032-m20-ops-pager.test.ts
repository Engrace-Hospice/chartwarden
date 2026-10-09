// GAP-032 — the platform page to WardenX ops that lets the SOS ladder enter the emergency terminus.
import { describe, expect, it } from "vitest";

import {
  OpsPageError,
  createWebhookOpsPager,
} from "../src/modules/20-field-safety/jobs/terminus-port";

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

  it("carries a per-alert dedupKey and the ledger idempotency key so the receiver can coalesce re-pages", async () => {
    const bodies: string[] = [];
    const pager = createWebhookOpsPager({
      url: "https://ops.example/hook",
      fetchImpl: async (_url, init) => {
        bodies.push(init.body);
        return { status: 200 };
      },
    });
    await pager.pageOps({
      ...input,
      loopIteration: 3,
      idempotencyKey: "m20:sos:sos-1:page_ops:3:0",
    });
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
      dedupKey: "sos:sos-1",
      idempotencyKey: "m20:sos:sos-1:page_ops:3:0",
      loopIteration: 3,
    });
  });

  it("classifies a non-2xx as receiver_non_2xx and an unreachable receiver as timeout, without leaking the URL", async () => {
    const down = createWebhookOpsPager({
      url: "https://secret-ops.example/hook?k=1",
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED https://secret-ops.example/hook?k=1");
      },
    });
    const err = await down.pageOps(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpsPageError);
    expect((err as OpsPageError).outcome).toBe("timeout");
    expect((err as OpsPageError).message).not.toContain("secret-ops");

    const bad = createWebhookOpsPager({
      url: "https://ops.example/hook",
      fetchImpl: async () => ({ status: 500 }),
    });
    const badErr = (await bad.pageOps(input).catch((e: unknown) => e)) as OpsPageError;
    expect(badErr.outcome).toBe("receiver_non_2xx");
  });
});
