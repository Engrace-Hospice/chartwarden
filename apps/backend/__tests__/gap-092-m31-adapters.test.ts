/**
 * GAP-092 — the small adapters behind the M31 provisioning ports: the invitation email delivery, the M39 consent port
 * over the registered evaluator, and M2's invitee-user primitive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { createPortalInviteeUserPort } from "../src/modules/02-identity/portal-invitee-user";
import {
  createPortalConsentPort,
  createPortalInvitationDelivery,
} from "../src/modules/31-portal/provisioning/adapters";
import { fakeDb } from "./_fake-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const EXPIRES = new Date("2026-10-09T12:00:00.000Z");
const input = (token = "t0k3n") => ({
  organizationId: ORG,
  email: "jane@example.com",
  displayName: "Jane",
  token,
  expiresAt: EXPIRES,
});

describe("portal invitation email delivery", () => {
  it("emails the accept link and keeps it OUT of the admin response", async () => {
    const send = vi.fn(async () => undefined);
    const out = await createPortalInvitationDelivery({
      transport: { send },
      baseUrl: "https://portal.example.com/",
    }).deliver(input("a b/c"));
    expect(out).toEqual({ inviteUrl: null });
    expect(send).toHaveBeenCalledOnce();
    const message = (send.mock.calls[0] as unknown as [{ to: string; text: string }])[0];
    expect(message.to).toBe("jane@example.com");
    expect(message.text).toContain("https://portal.example.com/accept-invitation?token=a%20b%2Fc");
  });

  it("builds the link on the organization's own portal base when one resolves", async () => {
    await expect(
      createPortalInvitationDelivery({
        baseUrl: "https://portal.example.com",
        baseUrlFor: async () => "https://acme.chartwarden.com/portal/",
      }).deliver(input()),
    ).resolves.toEqual({ inviteUrl: "https://acme.chartwarden.com/portal/accept-invitation?token=t0k3n" });
  });

  it("hands the link back to the admin when no transport is bound, and sends nothing without a base url", async () => {
    await expect(
      createPortalInvitationDelivery({ baseUrl: "https://portal.example.com" }).deliver(input()),
    ).resolves.toEqual({ inviteUrl: "https://portal.example.com/accept-invitation?token=t0k3n" });
    const send = vi.fn(async () => undefined);
    await expect(
      createPortalInvitationDelivery({ transport: { send } }).deliver(input()),
    ).resolves.toEqual({ inviteUrl: null });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("portal consent port (M39 evaluator)", () => {
  afterEach(() => __resetSeamsForTest());

  const register = (evaluate: (args: Record<string, unknown>) => Promise<unknown>) =>
    registerSeam("ConsentEvaluator", { evaluate } as never);

  it("returns the governing record + version for the grant kind's consent type", async () => {
    const evaluate = vi.fn(async () => ({
      allowed: true,
      consentRecordId: "c0000000-0000-4000-8000-000000000001",
      consentVersionAtEval: 7,
    }));
    register(evaluate);
    const out = await createPortalConsentPort().governingConsent({
      organizationId: ORG,
      patientId: PATIENT,
      grantKind: "family_caregiver",
    });
    expect(out).toEqual({
      consentRecordId: "c0000000-0000-4000-8000-000000000001",
      consentVersion: "7",
    });
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        consentType: "family_caregiver_access",
        patientId: PATIENT,
        callerModule: "m31",
      }),
    );
  });

  it("fails closed on a denial, an unidentified verdict or an evaluator that throws", async () => {
    const port = createPortalConsentPort();
    const ask = () =>
      port.governingConsent({ organizationId: ORG, patientId: PATIENT, grantKind: "patient_self" });
    register(async () => ({ allowed: false }));
    await expect(ask()).resolves.toBeNull();
    register(async () => ({ allowed: true }));
    await expect(ask()).resolves.toBeNull();
    register(async () => {
      throw new Error("consent store down");
    });
    await expect(ask()).resolves.toBeNull();
  });
});

describe("M2 invitee-user primitive", () => {
  it("find-or-creates the user by lowercased email and returns its id", async () => {
    const { db, rec } = fakeDb({ user: (op) => (op === "select" ? [{ id: "u-1" }] : []) });
    const out = await createPortalInviteeUserPort(db).ensureUser(ORG, {
      email: "  Jane@Example.COM ",
      displayName: "Jane",
    });
    expect(out).toEqual({ userId: "u-1" });
    expect(rec.inserts[0]?.values).toMatchObject({
      email: "jane@example.com",
      emailVerified: false,
      name: "Jane",
    });
  });

  it("verifies the email only when the token is accepted", async () => {
    const { db, rec } = fakeDb({});
    await createPortalInviteeUserPort(db).markEmailVerified(ORG, "u-1");
    expect(rec.updates[0]?.set).toMatchObject({ emailVerified: true });
  });
});
