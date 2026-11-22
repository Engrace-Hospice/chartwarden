import { describe, expect, it } from "vitest";
import { resolvePayerAuthorizationEvidence } from "../src/payer-authorization";

const base = {
  canonicalPayerId: "payer-a",
  serviceFrom: "2026-01-01",
  serviceTo: "2026-01-31",
};
const event = (
  eventKind:
    | "clinical_document_available"
    | "notification_prepared"
    | "notification_sent"
    | "receipt_acknowledged"
    | "authorization_pending"
    | "authorization_approved"
    | "authorization_denied"
    | "authorization_expired"
    | "authorization_revoked"
    | "unknown_unverified",
  createdAt: string,
  id = eventKind,
  overrides: Partial<{
    canonicalPayerId: string;
    serviceFrom: string;
    serviceTo: string;
    evidenceStatus: "unverified" | "verified" | "rejected" | "superseded";
    supersedesId: string | null;
  }> = {},
) => ({
  canonicalPayerId: base.canonicalPayerId,
  serviceFrom: base.serviceFrom,
  serviceTo: base.serviceTo,
  eventKind,
  evidenceStatus: "verified" as const,
  createdAt,
  id,
  ...overrides,
});

describe("resolvePayerAuthorizationEvidence", () => {
  it("keeps local clinical documentation, notification and payer authorization separate", () => {
    const result = resolvePayerAuthorizationEvidence({
      ...base,
      events: [
        event("clinical_document_available", "2026-01-01T10:00:00Z"),
        event("notification_sent", "2026-01-01T11:00:00Z"),
      ],
    });
    expect(result).toMatchObject({
      clinicalDocuments: "available",
      notification: "sent",
      authorization: "missing",
      authorizationSatisfied: false,
    });
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "PAYER_NOTIFICATION_RECEIPT_UNVERIFIED",
        "PAYER_AUTHORIZATION_UNRESOLVED",
      ]),
    );
  });

  it("requires an explicit payer receipt acknowledgment and authorization approval", () => {
    const result = resolvePayerAuthorizationEvidence({
      ...base,
      events: [
        event("clinical_document_available", "2026-01-01T10:00:00Z"),
        event("notification_sent", "2026-01-01T11:00:00Z"),
        event("receipt_acknowledged", "2026-01-01T12:00:00Z"),
        event("authorization_pending", "2026-01-01T13:00:00Z"),
        event("authorization_approved", "2026-01-02T10:00:00Z"),
      ],
    });
    expect(result).toMatchObject({
      clinicalDocuments: "available",
      notification: "acknowledged",
      authorization: "approved",
      authorizationSatisfied: false,
    });
  });

  it.each([
    ["authorization_denied", "denied"],
    ["authorization_expired", "expired"],
    ["authorization_revoked", "revoked"],
    ["authorization_pending", "pending"],
  ] as const)("does not resolve %s as approval", (kind, status) => {
    const result = resolvePayerAuthorizationEvidence({
      ...base,
      events: [
        event("authorization_approved", "2026-01-01T10:00:00Z", "old-approval"),
        event(kind, "2026-01-02T10:00:00Z", "new-event"),
      ],
    });
    expect(result.authorization).toBe(status);
    expect(result.authorizationSatisfied).toBe(false);
  });

  it("ignores other payers, uncovered service windows and unverified approval records", () => {
    const result = resolvePayerAuthorizationEvidence({
      ...base,
      events: [
        event("authorization_approved", "2026-01-01T10:00:00Z", "wrong-payer", {
          canonicalPayerId: "payer-b",
        }),
        event("authorization_approved", "2026-01-01T11:00:00Z", "partial", {
          serviceTo: "2026-01-15",
        }),
        event("authorization_approved", "2026-01-01T12:00:00Z", "unverified", {
          evidenceStatus: "unverified",
        }),
      ],
    });
    expect(result.authorization).toBe("unverified");
  });

  it("fails closed on contradictory final authorization events with the same timestamp", () => {
    const result = resolvePayerAuthorizationEvidence({
      ...base,
      events: [
        event("authorization_approved", "2026-01-01T10:00:00Z", "approved"),
        event("authorization_denied", "2026-01-01T10:00:00Z", "denied"),
      ],
    });
    expect(result.authorization).toBe("ambiguous");
    expect(result.authorizationSatisfied).toBe(false);
  });

  it("applies verified supersession links but ignores unverified corrections", () => {
    const approval = event("authorization_approved", "2026-01-01T10:00:00Z", "approval");
    const unverifiedCorrection = event(
      "authorization_revoked",
      "2026-01-02T10:00:00Z",
      "correction",
      {
        evidenceStatus: "unverified",
        supersedesId: "approval",
      },
    );
    expect(
      resolvePayerAuthorizationEvidence({ ...base, events: [approval, unverifiedCorrection] })
        .authorization,
    ).toBe("unverified");
    const verifiedCorrection = { ...unverifiedCorrection, evidenceStatus: "verified" as const };
    expect(
      resolvePayerAuthorizationEvidence({ ...base, events: [approval, verifiedCorrection] })
        .authorization,
    ).toBe("revoked");
  });
});
