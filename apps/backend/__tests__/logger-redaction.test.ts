/**
 * M1 §4.6.1 — PHI-safe logger config (apps/backend/src/bootstrap/plugins/logger.ts).
 *
 * Regression guard for the audit finding "PHI in URLs/logs": the Fastify request log line must log
 * the URL PATH ONLY (patient/global search carries the needle in `?q=<name|MRN>`) and must censor
 * auth-bearing headers + Set-Cookie.
 */
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { buildLoggerOptions, stripQuery } from "../src/bootstrap/plugins/logger";

describe("stripQuery", () => {
  it("removes the query string, keeping the path", () => {
    expect(stripQuery("/api/v1/patients?q=Smith%2C%20Jane&limit=25")).toBe("/api/v1/patients");
  });
  it("leaves a query-less URL untouched", () => {
    expect(stripQuery("/api/v1/patients/abc-123")).toBe("/api/v1/patients/abc-123");
  });
  it("handles a bare '?'", () => {
    expect(stripQuery("/x?")).toBe("/x");
  });
});

describe("buildLoggerOptions request serializer", () => {
  const serialize = () => {
    const opts = buildLoggerOptions();
    const req = {
      method: "GET",
      url: "/api/v1/patients?q=Jane%20Doe&mrn=000123",
      headers: { host: "chartwarden.local", authorization: "Bearer secret" },
      ip: "127.0.0.1",
    } as unknown as FastifyRequest;
    return opts.serializers.req(req);
  };

  it("logs the path only — the PHI-bearing query string is dropped", () => {
    const out = serialize();
    expect(out.url).toBe("/api/v1/patients");
    expect(JSON.stringify(out)).not.toContain("Jane");
    expect(JSON.stringify(out)).not.toContain("000123");
  });

  it("keeps non-PHI request metadata", () => {
    const out = serialize();
    expect(out.method).toBe("GET");
    expect(out.host).toBe("chartwarden.local");
    expect(out.remoteAddress).toBe("127.0.0.1");
  });

  it("declares a redaction denylist covering auth headers + cookies", () => {
    const paths = buildLoggerOptions().redact.paths;
    expect(paths).toContain("req.headers.authorization");
    expect(paths).toContain("req.headers.cookie");
    expect(paths).toContain('res.headers["set-cookie"]');
  });
});
