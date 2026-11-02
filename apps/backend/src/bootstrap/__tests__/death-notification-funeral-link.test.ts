import type { DbClient } from "@chartwarden/db";
import { describe, expect, it, vi } from "vitest";
import { buildFuneralLinkPort } from "../death-notification-funeral-link";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const PATIENT = "00000000-0000-4000-8000-0000000000e1";
const USER = "00000000-0000-4000-8000-00000000eee1";
const FH = "00000000-0000-4000-8000-00000000f001";
const LINK = "00000000-0000-4000-8000-00000000c001";
const ARGS = { orgId: ORG, patientId: PATIENT, actorUserId: USER, recipientEmail: "d@funeral.example", funeralHomeEntityId: FH };

function build(o: { deliverThrows?: boolean; recordThrows?: boolean; deceased?: boolean } = {}) {
  const order: string[] = [];
  const create = vi.fn(async (_i: Record<string, unknown>) => ({ linkId: LINK, token: "tok", expiresAt: "2026-11-02T00:00:00.000Z" }));
  const revoke = vi.fn(async () => {
    order.push("revoke");
  });
  const deliver = vi.fn(async () => {
    order.push("deliver");
    if (o.deliverThrows) throw new Error("mail down");
  });
  const invited = vi.fn(async () => {
    order.push("invited");
    if (o.recordThrows) throw new Error("audit down");
  });
  const refused = vi.fn(async () => undefined);
  const port = buildFuneralLinkPort({
    db: {} as DbClient,
    collaborators: { create, revoke },
    delivery: { deliver },
    isDeceased: async () => o.deceased ?? true,
    sessionTtlSec: 100,
    activeMembershipId: async () => "membership-1",
    recorder: { invited, refused },
  });
  return { port: port!, create, revoke, deliver, invited, refused, order };
}

describe("buildFuneralLinkPort", () => {
  it("binds the link to the funeral home, records the M2 audit/event BEFORE delivery, and returns only the link id", async () => {
    const { port, create, invited, order } = build();
    const out = await port.issue(ARGS);
    expect(out).toEqual({ linkId: LINK });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: "funeral_home", funeralHomeEntityId: FH }));
    expect(invited).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, patientId: PATIENT, linkId: LINK, actorUserId: USER }));
    expect(order).toEqual(["invited", "deliver"]);
  });

  it("revokes the link and delivers nothing when the audit record fails (fail closed)", async () => {
    const { port, revoke, deliver } = build({ recordThrows: true });
    await expect(port.issue(ARGS)).rejects.toThrow();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("revokes the link when delivery fails", async () => {
    const { port, revoke } = build({ deliverThrows: true });
    await expect(port.issue(ARGS)).rejects.toThrow();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("mints nothing for a patient who is not deceased", async () => {
    const { port, create } = build({ deceased: false });
    await expect(port.issue(ARGS)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it("passes a refusal through to the recorder", async () => {
    const { port, refused } = build();
    await port.refused({ orgId: ORG, actorUserId: USER, patientId: PATIENT, funeralHomeEntityId: FH, reason: "no_baa" });
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ reason: "no_baa", funeralHomeEntityId: FH }));
  });
});
