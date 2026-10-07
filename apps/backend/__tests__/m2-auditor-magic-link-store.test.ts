// GAP-011 — the durable auditor magic-link store's token discipline (the SQL is covered by the live-RLS path).
import { describe, expect, it } from "vitest";
import {
  generateAuditorToken,
  hashAuditorToken,
} from "../src/modules/02-identity/auditor-magic-link-store";

describe("auditor magic-link token helpers", () => {
  it("hashes deterministically and never returns the raw token", () => {
    const token = generateAuditorToken();
    expect(hashAuditorToken(token)).toBe(hashAuditorToken(token));
    expect(hashAuditorToken(token)).not.toContain(token);
    expect(hashAuditorToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unguessable, distinct 256-bit url-safe tokens", () => {
    const a = generateAuditorToken();
    const b = generateAuditorToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
