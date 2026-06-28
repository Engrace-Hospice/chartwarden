// apps/backend/__tests__/m33-outbox.test.ts — M1-T10 transactional-outbox conformance for the M33
// Reporting WRITE service. Once `createDrizzleM33WriteBackend` is bound to the live
// `buildTxOutboxPublisher` (apps/backend/src/bootstrap/outbox-persister.ts), a non-conformant emit payload
// THROWS in the catalog dispatcher and rolls the mutation's tx back. This test locks the three §4.10
// `m33.*` events the WRITE service emits (report_definition.published / report_view.shared_org /
// report_schedule.created) against their REGISTERED `payloadSchema` in events-by-m33.ts, so a future edit
// to an emit site that drifts from the schema fails here (not at runtime as a rolled-back tenant write).
//
// The payload literals below are structured EXACTLY as routes/write-service-drizzle.ts builds them at each
// emit site (the encounter-outbox.test.ts precedent of asserting representative payloads against the locked
// schema). Negative cases prove the schema actually constrains (a missing key / wrong-typed counter fails).
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const DEFINITION = "a0000000-0000-4000-8000-000000000001";
const VERSION = "b0000000-0000-4000-8000-000000000001";
const VIEW = "c0000000-0000-4000-8000-000000000001";
const SCHEDULE = "90000000-0000-4000-8000-000000000001";
const MEMBER = "f0000000-0000-4000-8000-000000000001";

const schemaFor = (eventName: string) => {
  const entry = M33_OUTBOX_EVENTS.find((e) => e.eventName === eventName);
  if (!entry) throw new Error(`m33 event '${eventName}' is not registered in M33_OUTBOX_EVENTS`);
  return entry.payloadSchema;
};

describe("M33 write-service outbox payloads conform to the registered §4.10 catalog schemas", () => {
  it("m33.report_definition.published — the publishVersion emit payload Value.Checks true", () => {
    expect(
      Value.Check(schemaFor("m33.report_definition.published"), {
        definitionId: DEFINITION,
        versionId: VERSION,
        baseKey: "census_daily",
        organizationId: ORG,
        publishedByMembershipId: MEMBER,
      }),
    ).toBe(true);
  });

  it("m33.report_view.shared_org — the shareView emit payload Value.Checks true", () => {
    expect(
      Value.Check(schemaFor("m33.report_view.shared_org"), {
        viewId: VIEW,
        viewName: "Daily census",
        sharedByMembershipId: MEMBER,
        organizationId: ORG,
      }),
    ).toBe(true);
  });

  it("m33.report_schedule.created — the createSchedule emit payload Value.Checks true", () => {
    expect(
      Value.Check(schemaFor("m33.report_schedule.created"), {
        scheduleId: SCHEDULE,
        viewId: VIEW,
        ownerMembershipId: MEMBER,
        cronExpression: "0 7 * * 1",
        recipientCount: 3,
        organizationId: ORG,
      }),
    ).toBe(true);
  });

  it("the schema constrains — a missing required key and a wrong-typed counter both fail", () => {
    // missing organizationId → the org-scoped outbox row could not be keyed → rejected.
    expect(
      Value.Check(schemaFor("m33.report_definition.published"), {
        definitionId: DEFINITION,
        versionId: VERSION,
        baseKey: "census_daily",
        publishedByMembershipId: MEMBER,
      }),
    ).toBe(false);
    // recipientCount must be a non-negative integer (not a string).
    expect(
      Value.Check(schemaFor("m33.report_schedule.created"), {
        scheduleId: SCHEDULE,
        viewId: VIEW,
        ownerMembershipId: MEMBER,
        cronExpression: "0 7 * * 1",
        recipientCount: "3",
        organizationId: ORG,
      }),
    ).toBe(false);
  });
});
