// @chartwarden/mdm — M40-T06 unit tests for the pure §7.7 BAA-gate engine (§4.6.2 computeStatus).
//
// Locks the as-of decision: no-BAA-needed → n_a (disclosure allowed); an executed record covering
// asOf → executed; the §7.10 time-travel case (active at attempt-time, expired at transmit-time) →
// expired + gated CLOSED; pending and never-executed → their distinct statuses. Pure data in / out.
import { describe, expect, it } from "vitest";
import { type BaaRecordRow, decideBaaStatus, defaultBaaRequired } from "../src/index";

const executed = (id: string, executedOn: string, expiresOn: string | null): BaaRecordRow => ({
  id,
  baaStatus: "executed",
  executedOn,
  expiresOn,
});

describe("decideBaaStatus (§7.7, §4.6.2)", () => {
  it("kind that needs no BAA → n_a, disclosure allowed (isActive:true)", () => {
    const r = decideBaaStatus({
      requiredByPolicy: false,
      records: [],
      asOf: new Date("2026-06-19"),
    });
    expect(r).toEqual({
      isActive: true,
      status: "n_a",
      expiresOn: null,
      requiredByPolicy: false,
      baaRecordId: null,
    });
  });

  it("an executed BAA covering asOf → executed (isActive:true, links the record)", () => {
    const r = decideBaaStatus({
      requiredByPolicy: true,
      records: [executed("baa-1", "2025-01-01", "2027-12-31")],
      asOf: new Date("2026-06-19T14:00:00Z"),
    });
    expect(r.isActive).toBe(true);
    expect(r.status).toBe("executed");
    expect(r.expiresOn).toBe("2027-12-31");
    expect(r.baaRecordId).toBe("baa-1");
  });

  it("§7.10 active at attempt-time but expired at transmit-time → expired, gated CLOSED", () => {
    // Date-granular expiry: valid through 2026-06-18 (midnight semantics, matching the spec SQL).
    const record = executed("baa-1", "2024-01-01", "2026-06-18");
    // Attempt the day before expiry → still in force…
    const atAttempt = decideBaaStatus({
      requiredByPolicy: true,
      records: [record],
      asOf: new Date("2026-06-17T12:00:00Z"),
    });
    expect(atAttempt.isActive).toBe(true);
    // …but the transmit moment is past expiry → refused (the §7.10 queued-before / processed-after case).
    const atTransmit = decideBaaStatus({
      requiredByPolicy: true,
      records: [record],
      asOf: new Date("2026-06-19T00:00:01Z"),
    });
    expect(atTransmit.isActive).toBe(false);
    expect(atTransmit.status).toBe("expired");
    expect(atTransmit.expiresOn).toBe("2026-06-18");
    expect(atTransmit.baaRecordId).toBe("baa-1");
  });

  it("a not-yet-effective executed record (executedOn after asOf) → missing", () => {
    const r = decideBaaStatus({
      requiredByPolicy: true,
      records: [executed("baa-future", "2027-01-01", null)],
      asOf: new Date("2026-06-19"),
    });
    expect(r.isActive).toBe(false);
    expect(r.status).toBe("missing");
  });

  it("a pending record → pending", () => {
    const r = decideBaaStatus({
      requiredByPolicy: true,
      records: [{ id: "baa-p", baaStatus: "pending", executedOn: null, expiresOn: null }],
      asOf: new Date("2026-06-19"),
    });
    expect(r.status).toBe("pending");
    expect(r.isActive).toBe(false);
  });

  it("no record at all → missing", () => {
    const r = decideBaaStatus({
      requiredByPolicy: true,
      records: [],
      asOf: new Date("2026-06-19"),
    });
    expect(r).toEqual({
      isActive: false,
      status: "missing",
      expiresOn: null,
      requiredByPolicy: true,
      baaRecordId: null,
    });
  });

  it("a never-expiring executed BAA (expiresOn null) stays active indefinitely", () => {
    const r = decideBaaStatus({
      requiredByPolicy: true,
      records: [executed("baa-perp", "2020-01-01", null)],
      asOf: new Date("2099-01-01"),
    });
    expect(r.isActive).toBe(true);
    expect(r.status).toBe("executed");
  });

  it("defaultBaaRequired follows the T01 baaGated descriptor (facility/payer yes, dme_vendor no)", () => {
    expect(defaultBaaRequired("facility")).toBe(true);
    expect(defaultBaaRequired("payer")).toBe(true);
    expect(defaultBaaRequired("referral_source")).toBe(true);
    expect(defaultBaaRequired("dme_vendor")).toBe(false);
    expect(defaultBaaRequired("funeral_home")).toBe(false);
  });
});
