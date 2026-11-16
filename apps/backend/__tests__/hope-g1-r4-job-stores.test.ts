import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  heldPatientSql,
  hopeRetentionFactsForOrg,
} from "../src/modules/10-hope/jobs/retention-store";
import { applyItemTransition } from "../src/modules/10-hope/jobs/submission-store";
import { renderSql, scriptedDb } from "./_hope-g3-fake-db";

// Group g1, round 4, the two stores the background jobs write through, with the database scripted (no Postgres):
//  - the legal-hold comparison of the retention scan is built for the DATABASE on canonical uuids, so a hold whose creator
//    typed an upper-case or braced id still names the patient (compared in JavaScript it matched nothing, and the held
//    patient was flagged eligible for destruction);
//  - a reconcile item UPDATE names the status it was judged from, so an item that is no longer pending is not rewritten
//    and its assessment is not stamped.
// The predicate's SEMANTICS on a real catalog are proven by m10-hope-retention.live.test.ts; here the SQL it renders is.
const ORG = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "55555555-5555-4555-8555-555555555555";
const PATIENT = "abcdef01-2345-4678-89ab-cdef01234567";
const OTHER_PATIENT = "99999999-9999-4999-8999-999999999999";
const ASSESSMENT = "66666666-6666-4666-8666-666666666666";

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});
const warned = (): string => warn.mock.calls.map((call) => String(call[0])).join("\n");

describe("heldPatientSql — the hold's patients as the database reads them", () => {
  it.each([
    ["upper case", PATIENT.toUpperCase()],
    ["braced", `{${PATIENT}}`],
    ["padded with spaces", `  ${PATIENT}  `],
    ["as stored", PATIENT],
  ])("a hold id spelled %s is sent as the canonical id", (_label, spelled) => {
    const { predicate, ignored } = heldPatientSql(new Set([spelled]));

    const rendered = renderSql(predicate);
    expect(rendered.sql).toContain('"patient_id" in (');
    expect(rendered.params).toEqual([PATIENT]);
    expect(ignored).toBe(0);
  });

  it("two spellings of one patient are one parameter; another patient is another", () => {
    const { predicate } = heldPatientSql(new Set([PATIENT, PATIENT.toUpperCase(), OTHER_PATIENT]));

    expect(renderSql(predicate).params).toEqual([PATIENT, OTHER_PATIENT]);
  });

  it("a value that is no uuid names no patient: it is left out and counted, never sent to a ::uuid cast", () => {
    const { predicate, ignored } = heldPatientSql(new Set(["not-a-uuid", PATIENT]));

    expect(renderSql(predicate).params).toEqual([PATIENT]);
    expect(ignored).toBe(1);
  });

  it.each([
    ["no held patient", new Set<string>(), 0],
    ["only values that are no uuid", new Set(["a", "b"]), 2],
  ])("%s is a constant false, with no parameter", (_label, held, expectedIgnored) => {
    const { predicate, ignored } = heldPatientSql(held);

    expect(renderSql(predicate)).toEqual({ sql: "false", params: [] });
    expect(ignored).toBe(expectedIgnored);
  });
});

describe("hopeRetentionFactsForOrg — legalHold is what the database answered", () => {
  const row = (patientId: string, legalHold: boolean) => ({
    id: ASSESSMENT,
    patientId,
    status: "signed",
    signedAt: new Date("2018-01-01T00:00:00.000Z"),
    updatedAt: new Date("2018-01-01T00:00:00.000Z"),
    targetDate: new Date("2018-01-01T00:00:00.000Z"),
    correctsAssessmentId: null,
    supersededById: null,
    providerEntityId: null,
    locationId: null,
    legalHold,
  });

  it("the selection carries the hold predicate beside the patient's other columns", async () => {
    const { tx, statements } = scriptedDb([[], []]);

    await hopeRetentionFactsForOrg(tx, ORG, new Set([PATIENT.toUpperCase()]));

    expect(statements.find((s) => s.kind === "select")?.columns).toContain("legalHold");
  });

  it("a patient the database says is held is held, whichever of its assessments said so", async () => {
    const { tx } = scriptedDb([
      [row(PATIENT, false), row(PATIENT, true), row(OTHER_PATIENT, false)],
      [],
    ]);

    const facts = await hopeRetentionFactsForOrg(tx, ORG, new Set([PATIENT.toUpperCase()]));

    expect(facts.find((f) => f.patientId === PATIENT)?.legalHold).toBe(true);
    expect(facts.find((f) => f.patientId === OTHER_PATIENT)?.legalHold).toBe(false);
  });

  it("with an empty hold set nobody is held", async () => {
    const { tx } = scriptedDb([[row(PATIENT, false)], []]);

    const facts = await hopeRetentionFactsForOrg(tx, ORG, new Set());

    expect(facts.map((f) => f.legalHold)).toEqual([false]);
  });

  it("says how many hold ids it could not read, with the organisation and no value", async () => {
    const { tx } = scriptedDb([[], []]);

    await hopeRetentionFactsForOrg(tx, ORG, new Set(["not-a-uuid", "SECRET-HOLD-VALUE", PATIENT]));

    expect(warned()).toContain("2 legal-hold patient id(s)");
    expect(warned()).toContain(ORG);
    expect(warned()).not.toContain("SECRET-HOLD-VALUE");
  });

  it("logs nothing when every hold id is a uuid", async () => {
    const { tx } = scriptedDb([[], []]);

    await hopeRetentionFactsForOrg(tx, ORG, new Set([PATIENT]));

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("applyItemTransition — the item UPDATE re-judges the status it was judged from", () => {
  const accepted = {
    hopeAssessmentId: ASSESSMENT,
    itemStatus: "accepted" as const,
    iqiesRecordId: "iqies-rec-1",
  };

  it("a pending item is settled, its UPDATE names `pending`, and an acceptance stamps the assessment", async () => {
    const { tx, statements } = scriptedDb([[{ id: "item-1" }], []]);

    const applied = await applyItemTransition(tx, ORG, SUBMISSION, accepted, { outcome: "x" });

    expect(applied).toBe(true);
    const updates = statements.filter((s) => s.kind === "update");
    expect(updates).toHaveLength(2);
    expect(updates[0]?.rendered?.sql).toContain('"item_status"');
    expect(updates[0]?.rendered?.params).toContain("pending");
  });

  it("an item that is no longer pending matches no row: false, and the assessment is NOT stamped", async () => {
    const { tx, statements } = scriptedDb([[]]);

    const applied = await applyItemTransition(tx, ORG, SUBMISSION, accepted, { outcome: "x" });

    expect(applied).toBe(false);
    expect(statements.filter((s) => s.kind === "update")).toHaveLength(1);
  });

  it("a rejection settles the item and never stamps the assessment", async () => {
    const { tx, statements } = scriptedDb([[{ id: "item-1" }]]);

    const applied = await applyItemTransition(
      tx,
      ORG,
      SUBMISSION,
      { hopeAssessmentId: ASSESSMENT, itemStatus: "rejected", iqiesRecordId: null },
      { outcome: "x" },
    );

    expect(applied).toBe(true);
    expect(statements.filter((s) => s.kind === "update")).toHaveLength(1);
  });
});
