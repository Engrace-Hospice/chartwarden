import type { DbClient } from "@chartwarden/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { createHopeAdmissionPrefillService } from "../src/modules/10-hope/hope-admission-prefill-service";
import { type Outcome, renderSql, scriptedDb } from "./_hope-g3-fake-db";

// The chart refresh of a draft's prefill answers, with the database scripted (no Postgres): a re-open that CHANGES an
// answer bumps the draft's `version` in the same transaction (so a signer who reviewed the older version is refused),
// one that changes nothing writes nothing, and a first fill leaves `version` alone (nobody has seen the record yet).
const ORG = "11111111-1111-4111-8111-111111111111";
const ASSESSMENT_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_A0220 = { id: "item-a0220", itemCode: "A0220" };
const ADMISSION_DATE = "2025-10-01";

const assessment = {
  id: ASSESSMENT_ID,
  organizationId: ORG,
  providerEntityId: null,
  locationId: null,
  patientId: "44444444-4444-4444-8444-444444444444",
  specVersionId: "spec-1",
  isc: "HA",
  status: "draft",
  rfaKind: "01_admission",
  version: 3,
};

beforeEach(() => {
  registerSeam("PatientHopeAdmissionPrefillReader", {
    factsForHopeAdmissionPrefill: async () => ({
      patientId: assessment.patientId,
      organizationId: ORG,
      legalFirstName: "Ada",
      legalMiddleName: null,
      legalLastName: "Lovelace",
      legalNameSuffix: null,
      dob: "1950-01-01",
      sexAssignedAtBirth: "F",
      raceCodes: [],
      ethnicityCodes: [],
      preferredLanguageCode: null,
      identifiers: [],
    }),
  } as never);
  registerSeam("PatientAddressReader", { residenceAt: async () => null } as never);
  registerSeam("PatientCoverageReader", { coveragesForPatient: async () => [] } as never);
});
afterEach(() => __resetSeamsForTest());

/** The prefill candidates are narrowed to A0220 by the one spec item the script returns. */
const specItemsSelect: Outcome = [{ item: ITEM_A0220 }];
const noOptions: Outcome = []; // an item with no allowed-value list takes any value
const storedAnswer = (value: string): Outcome => [
  {
    specItemId: ITEM_A0220.id,
    state: "answered",
    source: "admission_prefill",
    value,
  },
];

/** Runs one prefill over the script and returns what the assessment UPDATE was asked to set (undefined when none ran). */
async function prefill(outcomes: readonly Outcome[], refreshOnly: boolean) {
  const fake = scriptedDb(outcomes);
  const sets: Record<string, unknown>[] = [];
  const update = fake.tx.update.bind(fake.tx) as unknown as () => unknown;
  (fake.tx as unknown as { update: unknown }).update = () => {
    const link = update() as { set: (values: Record<string, unknown>) => unknown };
    const set = link.set;
    link.set = (values) => {
      sets.push(values);
      return set(values);
    };
    return link;
  };
  const result = await createHopeAdmissionPrefillService().prefillAdmission({
    tx: fake.tx as DbClient,
    organizationId: ORG,
    assessment: assessment as never,
    specVersionCode: "1.00.1",
    admissionDate: ADMISSION_DATE,
    refreshOnly,
  });
  return { result, sets, statements: fake.statements };
}

describe("prefill refresh of a re-opened draft — `version`", () => {
  it("bumps the version, in the same UPDATE as updated_at, when the chart changed an answer", async () => {
    // peek -> the chart value differs from the stored one; lock; re-read under the lock; the write; reconcile (items,
    // answers); the assessment UPDATE.
    const { result, sets } = await prefill(
      [
        specItemsSelect,
        noOptions,
        storedAnswer("2025-09-01"),
        [{ id: ASSESSMENT_ID, status: "draft", version: 3 }],
        storedAnswer("2025-09-01"),
        [],
        [],
        [],
        [],
      ],
      true,
    );

    expect(result.prefilledItemCodes).toEqual(["A0220"]);
    expect(sets).toHaveLength(1);
    expect(Object.keys(sets[0] ?? {}).sort()).toEqual(["updatedAt", "version"]);
    expect(renderSql(sets[0]?.version).sql).toContain('"version" + 1');
  });

  it("writes nothing and bumps nothing when the chart still holds what the draft already has", async () => {
    const { result, sets, statements } = await prefill(
      [specItemsSelect, noOptions, storedAnswer(ADMISSION_DATE)],
      true,
    );

    expect(result.prefilledItemCodes).toEqual([]);
    expect(sets).toEqual([]);
    expect(statements.some((s) => s.kind === "update" || s.kind === "insert")).toBe(false);
  });

  it("a first fill (the record was just created) keeps the version: its caller returns the row it holds", async () => {
    // No unlocked peek on a first fill: the lock, the answers under it, the write, reconcile (items, answers), the UPDATE.
    const { result, sets } = await prefill(
      [
        specItemsSelect,
        noOptions,
        [{ id: ASSESSMENT_ID, status: "draft", version: 1 }],
        [],
        [],
        [],
        [],
        [],
      ],
      false,
    );

    expect(result.prefilledItemCodes).toEqual(["A0220"]);
    expect(sets).toHaveLength(1);
    expect(Object.keys(sets[0] ?? {})).toEqual(["updatedAt"]);
  });
});
