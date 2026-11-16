import { createHash } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import {
  HOPE_ATTESTATION_VERSION,
  HOPE_SFV_ATTESTATION_STATEMENT,
  HOPE_SIGN_ATTESTATION_STATEMENT,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  AUDIT_USER_AGENT_MAX_LENGTH,
  auditHopeSignature,
  clientCorrelationContext,
  hopeAuditActor,
  sanitizeUserAgent,
} from "../src/modules/10-hope/hope-signature-audit";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "22222222-2222-4222-8222-222222222222";
const SESSION_USER = "33333333-3333-4333-8333-333333333333";
const ASSESSMENT = "44444444-4444-4444-8444-444444444444";

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The one row `audit()` inserts through the tx it is handed. */
async function auditedRow(over: Partial<Parameters<typeof auditHopeSignature>[1]>) {
  const rows: Record<string, unknown>[] = [];
  const tx = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        rows.push(row);
        return Promise.resolve();
      },
    }),
  } as unknown as DbClient;
  await auditHopeSignature(tx, {
    organizationId: ORG,
    membershipId: MEMBERSHIP,
    eventType: "hope.timepoint_signed",
    assessmentId: ASSESSMENT,
    rfaKind: "01_admission",
    version: 2,
    stepUpRequiredOperation: "hope.timepoint.sign",
    attestationConfirmed: true,
    ...over,
  });
  return rows[0] as Record<string, unknown> & { context: Record<string, unknown> };
}

describe("sanitizeUserAgent", () => {
  it("strips control characters so a header cannot forge a log line or a second row", () => {
    expect(sanitizeUserAgent("Mozilla/5.0\r\nX-Forged: 1\u0000\u007f\t(Mac)")).toBe(
      "Mozilla/5.0X-Forged: 1(Mac)",
    );
  });

  it("bounds a long user agent to 256 characters", () => {
    const cleaned = sanitizeUserAgent(`ua-${"x".repeat(5000)}`);

    expect([...(cleaned as string)]).toHaveLength(AUDIT_USER_AGENT_MAX_LENGTH);
    expect(AUDIT_USER_AGENT_MAX_LENGTH).toBe(256);
  });

  it.each([
    ["U+0085 (next line)", "ua\u0085x"],
    ["U+202E (right-to-left override)", "ua\u202ex"],
    ["U+200B (zero-width space)", "ua\u200bx"],
    ["U+2060 (word joiner)", "ua\u2060x"],
    ["U+FEFF (byte-order mark)", "ua\ufeffx"],
    ["U+2028 (line separator)", "ua\u2028x"],
    ["U+2029 (paragraph separator)", "ua\u2029x"],
    ["a lone high surrogate (does not survive UTF-8)", "ua\ud800x"],
    ["a lone low surrogate", "ua\udfffx"],
    ["a private-use character (U+E000)", "ua\ue000x"],
    ["an unassigned code point (U+0378)", "ua\u0378x"],
  ])("strips %s, which a log viewer or a terminal would act on", (_label, raw) => {
    expect(sanitizeUserAgent(raw)).toBe("uax");
  });

  it("cuts by code points, so an astral character at the bound is kept whole or dropped whole, never split", () => {
    // 255 ASCII characters then an astral one (2 UTF-16 units): the 256th CODE POINT is the astral character itself.
    const atTheCut = sanitizeUserAgent(`${"a".repeat(255)}\u{1F600}tail`) as string;

    expect([...atTheCut]).toHaveLength(AUDIT_USER_AGENT_MAX_LENGTH);
    expect(atTheCut.endsWith("\u{1F600}")).toBe(true);
    // No lone surrogate: the string round-trips through UTF-8 unchanged.
    expect(Buffer.from(atTheCut, "utf8").toString("utf8")).toBe(atTheCut);
  });

  it("never leaves a lone surrogate when the cut falls between two astral characters", () => {
    const cleaned = sanitizeUserAgent("\u{1F600}".repeat(400)) as string;

    expect([...cleaned]).toHaveLength(AUDIT_USER_AGENT_MAX_LENGTH);
    expect(Buffer.from(cleaned, "utf8").toString("utf8")).toBe(cleaned);
  });

  it("keeps a well-formed astral pair while stripping a lone surrogate next to it", () => {
    expect(sanitizeUserAgent("a\u{1F600}\ud800b")).toBe("a\u{1F600}b");
  });

  it("is undefined when nothing printable is left", () => {
    expect(sanitizeUserAgent("\t\r\n")).toBeUndefined();
    expect(sanitizeUserAgent("\u200b\u202e")).toBeUndefined();
    expect(sanitizeUserAgent("\ud800\ue000\u0378")).toBeUndefined();
    expect(sanitizeUserAgent("")).toBeUndefined();
  });
});

describe("auditHopeSignature", () => {
  it("records the session user, the request id and the sanitised user agent when given, and the client's trace hint only in the context", async () => {
    const row = await auditedRow({
      actorUserId: SESSION_USER,
      correlationId: "corr-7f3a",
      requestId: "req-9",
      sourceIp: "203.0.113.7",
      userAgent: "agent\r\n/1.0",
    });

    expect(row).toMatchObject({
      actorUserId: SESSION_USER,
      actorKind: "user",
      // Always the server's own id: a client-chosen one would let a caller plant a row under a key it picked.
      correlationId: `hope-signature:${ASSESSMENT}`,
      requestId: "req-9",
      sourceIp: "203.0.113.7",
      userAgent: "agent/1.0",
      resourceId: ASSESSMENT,
    });
    expect(row.context.clientCorrelationId).toBe("corr-7f3a");
  });

  it("never lets a client-supplied correlation id become the row's correlation id", async () => {
    const hostile = "hope-signature:00000000-0000-4000-8000-000000000000";
    const row = await auditedRow({ correlationId: hostile });

    expect(row.correlationId).toBe(`hope-signature:${ASSESSMENT}`);
    expect(row.context.clientCorrelationId).toBe(hostile);
  });

  it("leaves the actor user and the client trace hint empty for a direct service call", async () => {
    const row = await auditedRow({});

    expect(row.actorUserId).toBeNull();
    expect(row.correlationId).toBe(`hope-signature:${ASSESSMENT}`);
    expect(row.context).not.toHaveProperty("clientCorrelationId");
  });

  it("writes the attestation flag it is given, and always as the literal true", async () => {
    const row = await auditedRow({});

    expect(row.context.attestationConfirmed).toBe(true);
  });

  it.each([
    ["hope.timepoint_signed", HOPE_SIGN_ATTESTATION_STATEMENT],
    ["hope.sfv_completed", HOPE_SFV_ATTESTATION_STATEMENT],
  ] as const)(
    "%s records the current wording version and the SHA-256 of ITS statement text",
    async (eventType, statement) => {
      const row = await auditedRow({ eventType });

      expect(row.context.serverCurrentAttestationVersion).toBe(HOPE_ATTESTATION_VERSION);
      expect(row.context.serverCurrentAttestationStatementSha256).toBe(sha256Hex(statement));
      expect(row.context.serverCurrentAttestationStatementSha256).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it("hashes a different statement for the two signing paths", async () => {
    const sign = await auditedRow({ eventType: "hope.timepoint_signed" });
    const sfv = await auditedRow({ eventType: "hope.sfv_completed" });

    expect(sign.context.serverCurrentAttestationStatementSha256).not.toBe(
      sfv.context.serverCurrentAttestationStatementSha256,
    );
  });

  it("records that the client did NOT name a version when it named none", async () => {
    const row = await auditedRow({});

    expect(row.context.attestationVersionSupplied).toBe(false);
    expect(row.context).not.toHaveProperty("suppliedAttestationVersion");
  });

  it("records the version the client named, and that it did, when it named one", async () => {
    const row = await auditedRow({ attestationVersion: HOPE_ATTESTATION_VERSION });

    expect(row.context.attestationVersionSupplied).toBe(true);
    expect(row.context.suppliedAttestationVersion).toBe(HOPE_ATTESTATION_VERSION);
  });

  it("never records an attestation claim under the old, ambiguous key names", async () => {
    const row = await auditedRow({ attestationVersion: HOPE_ATTESTATION_VERSION });

    expect(row.context).not.toHaveProperty("attestationVersion");
    expect(row.context).not.toHaveProperty("attestationStatementSha256");
  });
});

describe("hopeAuditActor (the facts the deadline-override audit shares with the signature audit)", () => {
  it("carries the session user, request id, address and a sanitised user agent under the server's correlation id", () => {
    const actor = hopeAuditActor(ORG, "hope-late-deadline-override:row-1", {
      actorUserId: SESSION_USER,
      requestId: "req-9",
      sourceIp: "203.0.113.7",
      userAgent: "agent\r\n/1.0\ud800",
      correlationId: "client-chosen",
    });

    expect(actor).toEqual({
      organizationId: ORG,
      userId: SESSION_USER,
      actorKind: "user",
      correlationId: "hope-late-deadline-override:row-1",
      requestId: "req-9",
      sourceIp: "203.0.113.7",
      userAgent: "agent/1.0",
    });
  });

  it("is a null user and no request facts for a direct service call", () => {
    expect(hopeAuditActor(ORG, "hope-late-deadline-override:row-1")).toEqual({
      organizationId: ORG,
      userId: null,
      actorKind: "user",
      correlationId: "hope-late-deadline-override:row-1",
    });
  });

  it("keeps the client's trace hint out of the correlation id and in a context entry", () => {
    expect(clientCorrelationContext({ correlationId: "client-chosen" })).toEqual({
      clientCorrelationId: "client-chosen",
    });
    expect(clientCorrelationContext({})).toEqual({});
  });
});
