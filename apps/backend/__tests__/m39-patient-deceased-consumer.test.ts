// GAP-110 — M39 D13: `m5.patient.deceased` expires the decedent's active non-survives-death consents.
// Unit tests over an in-memory unit of work; the Drizzle half (RLS, FOR UPDATE, same-tx outbox) is the
// composition-root wiring assertion below plus the live suites that exercise the real relay.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/events-by-m5";
import {
  type DeceasedConsentRow,
  type DeceasedConsentTx,
  applyPatientDeceased,
  parseDeceasedEvent,
  planDeceasedExpiry,
} from "../src/modules/39-consent/index";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-05T12:00:00.000Z");

const row = (
  id: string,
  typeKey: DeceasedConsentRow["typeKey"],
  survivesDeath = false,
  status = "active",
): DeceasedConsentRow => ({ id, typeKey, status, survivesDeath });

function memoryUow(initial: readonly DeceasedConsentRow[], losers: readonly string[] = []) {
  const rows = initial.map((r) => ({ ...r }));
  const published: { payload: Record<string, unknown>; id: string }[] = [];
  const orgs: string[] = [];
  const tx: DeceasedConsentTx = {
    async lockActiveConsents() {
      return rows.filter((r) => r.status === "active");
    },
    async expire(id) {
      if (losers.includes(id)) return false;
      const target = rows.find((r) => r.id === id && r.status === "active");
      if (!target) return false;
      target.status = "expired";
      return true;
    },
    async publishExpired(payload, id) {
      published.push({ payload, id });
    },
  };
  return {
    rows,
    published,
    orgs,
    uow: {
      async run<T>(organizationId: string, fn: (t: DeceasedConsentTx) => Promise<T>) {
        orgs.push(organizationId);
        return fn(tx);
      },
    },
  };
}

describe("planDeceasedExpiry", () => {
  it("expires every active non-surviving consent and keeps survivors", () => {
    const plan = planDeceasedExpiry([
      row("hipaa", "hipaa_release"),
      row("part2", "42_cfr_part_2_release"),
      row("portal", "portal_access"),
      row("son", "family_caregiver_access", true),
      row("gone", "hipaa_release", false, "revoked"),
    ]);
    expect(plan.map((p) => p.id).sort()).toEqual(["hipaa", "part2", "portal"]);
  });

  it("flags a surviving same-type consent so the privacy flag is not re-restricted", () => {
    const plan = planDeceasedExpiry([
      row("fam-a", "family_caregiver_access", false),
      row("fam-b", "family_caregiver_access", true),
    ]);
    expect(plan).toEqual([
      { id: "fam-a", typeKey: "family_caregiver_access", remainingActiveConsentRecordId: "fam-b" },
    ]);
  });
});

describe("planDeceasedExpiry — survivor flag", () => {
  it("names no survivor when every same-type consent terminates too", () => {
    const plan = planDeceasedExpiry([
      row("hipaa-a", "hipaa_release"),
      row("hipaa-b", "hipaa_release"),
    ]);
    expect(plan.map((p) => p.remainingActiveConsentRecordId)).toEqual([null, null]);
  });

  it("does not count a non-active same-type consent as a survivor", () => {
    const plan = planDeceasedExpiry([
      row("fam-a", "family_caregiver_access", false),
      row("fam-b", "family_caregiver_access", true, "revoked"),
    ]);
    expect(plan).toEqual([
      { id: "fam-a", typeKey: "family_caregiver_access", remainingActiveConsentRecordId: null },
    ]);
  });
});

describe("parseDeceasedEvent", () => {
  it("takes the org from the envelope and the patient from the payload", () => {
    expect(parseDeceasedEvent({ organizationId: ORG, payload: { patientId: PATIENT } })).toEqual({
      organizationId: ORG,
      patientId: PATIENT,
    });
  });
  it("refuses a payload for another organization", () => {
    expect(() =>
      parseDeceasedEvent({
        organizationId: ORG,
        payload: { patientId: PATIENT, organizationId: "other" },
      }),
    ).toThrow(/does not match/);
  });
  it.each([null, {}, { patientId: "" }])("refuses a malformed payload %j", (payload) => {
    expect(() => parseDeceasedEvent({ organizationId: ORG, payload })).toThrow();
  });
});

describe("applyPatientDeceased", () => {
  it("expires terminating consents and emits one m39.consent.expired each under the envelope org", async () => {
    const mem = memoryUow([
      row("hipaa", "hipaa_release"),
      row("son", "family_caregiver_access", true),
    ]);
    const expired = await applyPatientDeceased(
      mem.uow,
      { organizationId: ORG, payload: { patientId: PATIENT, deceasedDate: "2026-10-05" } },
      NOW,
    );
    expect(expired).toEqual(["hipaa"]);
    expect(mem.orgs).toEqual([ORG]);
    expect(mem.rows.find((r) => r.id === "son")?.status).toBe("active");
    expect(mem.published).toHaveLength(1);
    expect(mem.published[0]?.payload).toMatchObject({
      organizationId: ORG,
      patientId: PATIENT,
      consentRecordId: "hipaa",
      typeKey: "hipaa_release",
      expiredAt: NOW.toISOString(),
      expiredReason: "patient_deceased_consent_terminated",
    });
  });

  it("is idempotent: a redelivery finds nothing active and emits nothing", async () => {
    const mem = memoryUow([row("hipaa", "hipaa_release")]);
    const event = { organizationId: ORG, payload: { patientId: PATIENT } };
    await applyPatientDeceased(mem.uow, event, NOW);
    const second = await applyPatientDeceased(mem.uow, event, NOW);
    expect(second).toEqual([]);
    expect(mem.published).toHaveLength(1);
  });

  it("emits nothing for a row that lost a race to a revoke", async () => {
    const mem = memoryUow([row("hipaa", "hipaa_release")], ["hipaa"]);
    const expired = await applyPatientDeceased(
      mem.uow,
      { organizationId: ORG, payload: { patientId: PATIENT } },
      NOW,
    );
    expect(expired).toEqual([]);
    expect(mem.published).toEqual([]);
  });
});

describe("GAP-110 wiring", () => {
  it("declares m39 on m5.patient.deceased", () => {
    const event = M5_OUTBOX_EVENTS.find((e) => e.eventName === "m5.patient.deceased");
    expect(event?.declaredConsumers).toContain("m39");
  });
  it("binds the factory in the composition root", () => {
    const src = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    expect(src).toMatch(/buildM39PatientDeceasedConsumer\(\{/);
  });
});
