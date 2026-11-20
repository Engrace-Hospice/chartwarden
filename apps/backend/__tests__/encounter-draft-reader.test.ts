// apps/backend/__tests__/encounter-draft-reader.test.ts — M8's EncounterDraftReader seam (WF09), the parts that need no database: which visits
// have a note that states wounds (resolved from the same template registry the note is assembled from), the registration, and the Drizzle
// reader's own work over a scripted database (the tenant context it opens, the predicates it asks for, how a row maps to the seam's facts).
// What only a real database can prove (RLS hiding another organisation's row) is proven live in wounds.live.test.ts.
import type { DbClient } from "@chartwarden/db";
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  createDrizzleEncounterDraftReader,
  noteStatesWounds,
  registerEncounterDraftReader,
} from "../src/modules/08-encounters/encounter-draft-reader";

describe("noteStatesWounds", () => {
  it.each([
    ["routine_visit", "rn"],
    ["routine_visit", "lpn"],
    ["admission_visit", "rn"],
    ["recert_visit", "rn"],
    ["face_to_face", "md"],
    ["face_to_face", "np"],
    ["idg_followup", "rn"],
  ] as const)("a %s note by a %s has a skin and wounds section", (type, discipline) => {
    expect(noteStatesWounds(type, discipline)).toBe(true);
  });

  it.each([
    ["telephonic", "rn"],
    ["telephonic", "lpn"],
    ["telephonic", "md"],
    ["chha_visit", "chha"],
    ["msw_assessment", "msw"],
    ["chaplain_visit", "chaplain"],
    ["volunteer_visit", "volunteer"],
    ["pt_visit", "pt"],
    ["ot_visit", "ot"],
    ["slp_visit", "slp"],
  ] as const)(
    "a %s note by a %s has none: nothing was measured, or the discipline does not treat wounds",
    (type, discipline) => {
      expect(noteStatesWounds(type, discipline)).toBe(false);
    },
  );

  it("fails closed for a pair no template exists for", () => {
    expect(
      noteStatesWounds("routine_visit" as EncounterType, "chaplain" as EncounterDiscipline),
    ).toBe(false);
  });
});

describe("registerEncounterDraftReader", () => {
  it("publishes the reader under the seam name M7 and M9 resolve", () => {
    const registered: string[] = [];
    registerEncounterDraftReader((name) => registered.push(name), {} as DbClient);
    expect(registered).toEqual(["EncounterDraftReader"]);
  });
});

describe("createDrizzleEncounterDraftReader (scripted database)", () => {
  const ORG = "77777777-7777-4777-8777-777777777777";
  const ENCOUNTER = "55555555-5555-4555-8555-555555555555";
  const PATIENT = "11111111-1111-4111-8111-111111111111";
  const AUTHOR = "b0000000-0000-4000-8000-000000000001";
  const dialect = new PgDialect();
  const render = (query: SQL) => dialect.sqlToQuery(query);

  /** A database whose one table holds `rows`; it records the tenant settings the transaction opens with and the `where` it is asked. */
  function scriptedDb(rows: readonly Record<string, unknown>[]) {
    const settings: unknown[][] = [];
    const wheres: SQL[] = [];
    const tx = {
      execute: async (query: SQL) => {
        settings.push(render(query).params);
        return [];
      },
      select: () => ({
        from: () => ({
          where: (condition: SQL) => {
            wheres.push(condition);
            return { limit: async () => rows };
          },
        }),
      }),
    };
    const db = { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
    return { db: db as unknown as DbClient, settings, wheres };
  }
  const row = (over: Record<string, unknown> = {}) => ({
    patientId: PATIENT,
    status: "draft",
    authoredByMembershipId: AUTHOR,
    encounterType: "routine_visit",
    discipline: "rn",
    ...over,
  });
  const ask = (db: DbClient) =>
    createDrizzleEncounterDraftReader(db).draftOf({ organizationId: ORG, encounterId: ENCOUNTER });

  it("answers null for an encounter the organisation does not have (unknown, or another organisation's under RLS)", async () => {
    const { db } = scriptedDb([]);
    await expect(ask(db)).resolves.toBeNull();
  });

  it("opens the caller's organisation as the tenant context and names it, with the encounter, in the query itself", async () => {
    const { db, settings, wheres } = scriptedDb([row()]);
    await ask(db);
    // RLS: `app.org_id` is the organisation asked about (and no acting user: a seam read is not a request).
    expect(settings.flat()).toContain(ORG);
    // A second wall behind RLS: the where clause carries both ids, on their own columns.
    const where = render(wheres[0] as SQL);
    expect(where.params).toEqual(expect.arrayContaining([ORG, ENCOUNTER]));
    expect(where.sql).toContain('"organization_id"');
    expect(where.sql).toContain('"id"');
  });

  it("maps the row to the seam's facts: patient, status, author and whether the note states wounds, and nothing else", async () => {
    const { db } = scriptedDb([row()]);
    await expect(ask(db)).resolves.toEqual({
      patientId: PATIENT,
      status: "draft",
      authoredByMembershipId: AUTHOR,
      templateStatesWounds: true,
    });
  });

  it.each(["finalized", "signed", "cosign_pending", "cosigned", "voided"])(
    "passes a %s note's status through, so the consumer can refuse it",
    async (status) => {
      const { db } = scriptedDb([row({ status })]);
      await expect(ask(db)).resolves.toMatchObject({ status });
    },
  );

  it("flags a telephonic note and a therapy note as not stating wounds, and an unknown pair too (fails closed)", async () => {
    for (const [encounterType, discipline] of [
      ["telephonic", "rn"],
      ["pt_visit", "pt"],
      ["routine_visit", "chaplain"],
    ]) {
      const { db } = scriptedDb([row({ encounterType, discipline })]);
      await expect(ask(db)).resolves.toMatchObject({ templateStatesWounds: false });
    }
  });

  it("lets a database failure through: an unreadable M8 refuses the write", async () => {
    const failing = {
      transaction: async () => {
        throw new Error("connection reset");
      },
    } as unknown as DbClient;
    await expect(ask(failing)).rejects.toThrow("connection reset");
  });
});
