// CW-MON-01 — the security alert sink: the existing ops alert path (log line + OPS_ALERT_WEBHOOK_URL), awaited so the review
// can tell a delivered alert from a lost one. A fake `fetch` stands in for the webhook; nothing leaves the process.
// Identifiers are synthetic.
import type { SecurityAlert } from "@chartwarden/audit";
import { describe, expect, it, vi } from "vitest";
import { buildSecurityAlertSink, formatSecurityAlert } from "../src/bootstrap/security-alert-sink";

const alert: SecurityAlert = {
  kind: "security_alert",
  rulesVersion: "test",
  runbook: "docs/runbooks/security-alert-review.md#access.break_glass_invoked",
  ruleId: "access.break_glass_invoked",
  title: "Emergency (break-glass) access was invoked",
  severity: "critical",
  lane: "org",
  controls: ["CW-MON-01"],
  organizationId: "00000000-0000-4000-8000-0000000000a1",
  subject: { kind: "event", ref: "00000000-0000-4000-8000-0000000000e1" },
  count: 1,
  windowFrom: "2026-11-26T11:30:00.000Z",
  windowTo: "2026-11-26T11:30:00.000Z",
  sampleEventIds: ["00000000-0000-4000-8000-0000000000e1"],
  fingerprint: "0123456789abcdef0123456789abcdef",
};
const URL_TEST = "https://alerts.example.test/hook";
const NOW = new Date("2026-11-26T12:00:00.000Z");

const respond = (status: number): typeof fetch =>
  vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

describe("buildSecurityAlertSink", () => {
  it("logs the alert and reports no_destination when no webhook is configured (never silent)", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn();
    const sink = buildSecurityAlertSink({ log, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await sink(alert)).toBe("no_destination");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(formatSecurityAlert(alert));
  });

  it("posts the platform-ops notice shape and reports delivered on a 2xx", async () => {
    const fetchImpl = respond(204);
    const sink = buildSecurityAlertSink({
      webhookUrl: URL_TEST,
      fetchImpl,
      log: vi.fn(),
      now: () => NOW,
    });
    expect(await sink(alert)).toBe("delivered");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(URL_TEST);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "security_alert",
      summary: "[critical] Emergency (break-glass) access was invoked",
      details: alert,
      correlationId: alert.fingerprint,
      occurredAt: NOW.toISOString(),
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports failed on a non-2xx response", async () => {
    const log = vi.fn();
    const sink = buildSecurityAlertSink({ webhookUrl: URL_TEST, fetchImpl: respond(503), log });
    expect(await sink(alert)).toBe("failed");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("HTTP 503"));
  });

  it("reports failed, and does not throw, when the request itself fails or times out", async () => {
    const log = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch;
    const sink = buildSecurityAlertSink({ webhookUrl: URL_TEST, fetchImpl, log });
    await expect(sink(alert)).resolves.toBe("failed");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Error ECONNREFUSED"));
  });

  it("never writes the webhook URL (it often carries a secret) into a log line, even when the error message embeds it", async () => {
    const secretUrl = "https://alerts.example.test/hook/synthetic-secret-token-123";
    const log = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`Failed to parse URL from ${secretUrl}`);
    }) as unknown as typeof fetch;
    await buildSecurityAlertSink({ webhookUrl: secretUrl, fetchImpl, log })(alert);
    for (const [line] of log.mock.calls) {
      expect(line).not.toContain("synthetic-secret-token-123");
      expect(line).not.toContain(secretUrl);
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining("TypeError"));
  });

  it("refuses redirects (a 307/308 would replay the body elsewhere) and releases the response body", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: { cancel },
    })) as unknown as typeof fetch;
    await buildSecurityAlertSink({ webhookUrl: URL_TEST, fetchImpl, log: vi.fn() })(alert);
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("error");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("puts ids and codes only in the log line and the webhook body", async () => {
    const fetchImpl = respond(200);
    const log = vi.fn();
    await buildSecurityAlertSink({ webhookUrl: URL_TEST, fetchImpl, log })(alert);
    const body = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]
      .body as string;
    for (const text of [body, log.mock.calls[0]?.[0] as string]) {
      expect(text).not.toMatch(/ssn|mbi|password|token|@|firstName|lastName/i);
    }
    expect(formatSecurityAlert(alert)).toContain("access.break_glass_invoked");
  });
});
