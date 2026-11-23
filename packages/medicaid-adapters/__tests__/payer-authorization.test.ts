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
  id: string = eventKind,
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

  it("applies verified supersession links, and an unverified correction neither supersedes nor masks the approval", () => {
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
    ).toBe("approved");
    const verifiedCorrection = { ...unverifiedCorrection, evidenceStatus: "verified" as const };
    expect(
      resolvePayerAuthorizationEvidence({ ...base, events: [approval, verifiedCorrection] })
        .authorization,
    ).toBe("revoked");
  });

  it.each(["unverified", "rejected"] as const)(
    "does not let a newer %s record mask a verified approval",
    (evidenceStatus) => {
      const result = resolvePayerAuthorizationEvidence({
        ...base,
        events: [
          event("authorization_approved", "2026-01-01T10:00:00Z", "approval"),
          event("authorization_denied", "2026-01-02T10:00:00Z", "later", { evidenceStatus }),
        ],
      });
      expect(result.authorization).toBe("approved");
      expect(result.authorizationSatisfied).toBe(false);
    },
  );

  it("reads only non-verified authorization records as unverified when nothing is verified", () => {
    for (const evidenceStatus of ["unverified", "rejected"] as const) {
      expect(
        resolvePayerAuthorizationEvidence({
          ...base,
          events: [
            event("authorization_approved", "2026-01-01T10:00:00Z", "a", { evidenceStatus }),
          ],
        }).authorization,
      ).toBe("unverified");
    }
  });

  it("does not let a newer unverified record mask verified document or notification evidence", () => {
    const result = resolvePayerAuthorizationEvidence({
      ...base,
      events: [
        event("clinical_document_available", "2026-01-01T10:00:00Z", "doc"),
        event("clinical_document_available", "2026-01-02T10:00:00Z", "doc-2", {
          evidenceStatus: "unverified",
        }),
        event("notification_sent", "2026-01-01T11:00:00Z", "sent"),
        event("receipt_acknowledged", "2026-01-02T11:00:00Z", "ack", {
          evidenceStatus: "unverified",
        }),
      ],
    });
    expect(result).toMatchObject({ clinicalDocuments: "available", notification: "sent" });
  });

  it("picks the notification by lifecycle stage, so a later-recorded send does not undo an acknowledgement", () => {
    const events = (...kinds: Parameters<typeof event>[0][]) =>
      kinds.map((kind, index) => event(kind, `2026-01-0${index + 1}T10:00:00Z`));
    const notification = (...kinds: Parameters<typeof event>[0][]) =>
      resolvePayerAuthorizationEvidence({ ...base, events: events(...kinds) }).notification;
    expect(notification("receipt_acknowledged", "notification_sent")).toBe("acknowledged");
    expect(notification("notification_sent", "receipt_acknowledged", "notification_prepared")).toBe(
      "acknowledged",
    );
    expect(notification("notification_sent", "notification_prepared")).toBe("sent");
    expect(notification("notification_prepared")).toBe("prepared");
  });

  describe("compares timestamps as instants, not strings", () => {
    it.each([
      ["2026-01-01T10:00:00Z", "2026-01-01T10:00:00.000Z"],
      ["2026-01-01T10:00:00Z", "2026-01-01T11:00:00+01:00"],
    ])("treats %s and %s as the same instant: contradictory finals are ambiguous", (a, b) => {
      const result = resolvePayerAuthorizationEvidence({
        ...base,
        events: [
          event("authorization_approved", a, "approved"),
          event("authorization_denied", b, "denied"),
        ],
      });
      expect(result.authorization).toBe("ambiguous");
    });

    it("orders by instant: a later fractional second wins over the whole second", () => {
      const events = [
        event("authorization_approved", "2026-01-01T10:00:00Z", "approved"),
        event("authorization_denied", "2026-01-01T10:00:00.500Z", "denied"),
      ];
      expect(resolvePayerAuthorizationEvidence({ ...base, events }).authorization).toBe("denied");
      expect(
        resolvePayerAuthorizationEvidence({ ...base, events: [...events].reverse() }).authorization,
      ).toBe("denied");
    });

    it("refuses an unparseable timestamp rather than ordering it arbitrarily", () => {
      expect(() =>
        resolvePayerAuthorizationEvidence({
          ...base,
          events: [event("authorization_approved", "not-a-time", "bad")],
        }),
      ).toThrow(RangeError);
    });
  });
});
