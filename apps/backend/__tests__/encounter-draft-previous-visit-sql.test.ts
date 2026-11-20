/**
 * S1 / VN-D9 — the draft's previous visit is the patient's last SIGNED visit of the SAME DISCIPLINE, so the narrowing must be a `WHERE`
 * clause. With every discipline counting, an intervening chaplain or aide visit became "the last visit" and a medication change made
 * between two RN visits fell into the window of a note that never described medications. A behavioural test needs a database (the
 * live suite m8-visit-note-draft-routes does that); this one renders the predicate the store puts in its `WHERE`, with no connection
 * (`createDbClient` builds its pool lazily and `toSQL()` renders without connecting).
 */
import { type DbClient, createDbClient, schema } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { previousVisitWhere } from "../src/modules/08-encounters/drafting/db-draft-store";
import type { DraftEncounter } from "../src/modules/08-encounters/drafting/ports";

const handle = createDbClient({ connectionString: "postgres://render-only/none" });
const db = handle.db as unknown as DbClient;

const ENCOUNTER: DraftEncounter = {
  id: "11111111-1111-1111-1111-111111111111",
  organizationId: "22222222-2222-2222-2222-222222222222",
  patientId: "33333333-3333-3333-3333-333333333333",
  admissionId: "44444444-4444-4444-4444-444444444444",
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-11-18",
};

const render = (encounter: DraftEncounter) =>
  db.select().from(schema.encounters).where(previousVisitWhere(encounter)).toSQL();

describe("previousVisitWhere: the previous visit is of the same discipline", () => {
  it("narrows by the encounter's own discipline in the WHERE, bound as a parameter", () => {
    const q = render(ENCOUNTER);
    expect(q.sql).toContain('"encounter"."discipline" = $');
    expect(q.params).toContain("rn");
  });

  it("follows the encounter being drafted: a chaplain draft asks for chaplain visits", () => {
    const q = render({ ...ENCOUNTER, discipline: "chaplain" });
    expect(q.params).toContain("chaplain");
    expect(q.params).not.toContain("rn");
  });

  it("keeps every other narrowing: tenant, patient, signed statuses, a strictly earlier service date", () => {
    const q = render(ENCOUNTER);
    expect(q.sql).toContain('"encounter"."organization_id" = $');
    expect(q.sql).toContain('"encounter"."patient_id" = $');
    expect(q.sql).toContain('"encounter"."status" in ($');
    expect(q.sql).toContain('"encounter"."service_date" < $');
    expect(q.params).toEqual(
      expect.arrayContaining([
        ENCOUNTER.organizationId,
        ENCOUNTER.patientId,
        "signed",
        "cosign_pending",
        "cosigned",
        ENCOUNTER.serviceDate,
        "rn",
      ]),
    );
  });

  it("does not narrow by encounter type: a signed RN admission visit is a previous RN visit", () => {
    expect(render(ENCOUNTER).sql).not.toContain('"encounter"."encounter_type"');
  });
});
