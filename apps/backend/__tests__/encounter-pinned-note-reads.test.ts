// WF09 — a PINNED note is read from its pin and nothing else. Finalize pins the assembled text; after that the note is the pin, so
// rendering it or reading its selections must not consult the wounds (M9's seam), the findings, the vitals or any other live fact:
// a wound correction or another visit's weight edit would otherwise flip `editedNarrativeStale` on a note signed unchanged, and a
// non-seam M9 error would turn the render of a legal document into a 500. An UNPINNED note (a draft) is previewed live and does read
// them, which the control cases prove so the "no read" assertions cannot pass by accident.
//
// No database: the service runs over a scripted fake `db` whose transaction hands back canned rows per table, and records which tables
// were read. The wound reader is a counting stub.
import { type DbClient, schema } from "@chartwarden/db";
import type { RecordedWound } from "@chartwarden/hearthnote";
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import { createDbEncounterRouteService } from "../src/modules/08-encounters/index";
import type { HearthnoteCiphers } from "../src/modules/08-encounters/index";

const ORG = "11111111-1111-4111-8111-111111111111";
const ENC_ID = "a0000000-0000-4000-8000-000000000001";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_KEY = "routine_visit:rn";

const encounterRow = (status: string) => ({
  id: ENC_ID,
  organizationId: ORG,
  patientId: PATIENT,
  admissionId: "33333333-3333-4333-8333-333333333333",
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-03-10",
  status,
  version: 4,
  fallIncidentId: null,
  fallOccurredOn: null,
  providerEntityId: null,
  locationId: null,
  authoredByMembershipId: "44444444-4444-4444-8444-444444444444",
});

const pinnedRow = {
  layer1Cipher: "sealed:layer1",
  finalCipher: "sealed:final",
  clinicianEdited: true,
};
const selectionRow = {
  selections: { sections: [] },
  freeTextCipher: null,
  templateKey: TEMPLATE_KEY,
  templateVersion: VOCAB_VERSION,
  version: 1,
};

/** The tables a statement may read, by the name the fake reports. */
const TABLE_NAMES = new Map<unknown, string>([
  [schema.encounters, "encounter"],
  [schema.hearthnoteAssembledOutputs, "assembled_output"],
  [schema.hearthnoteSelections, "selection"],
  [schema.vitals, "vitals"],
  [schema.encounterAdlRecords, "adl"],
  [schema.encounterNutritionRecords, "nutrition"],
]);

/** A `db` whose every SELECT answers `rowsByTable[<table>]` (or nothing) and records the table it was asked about. */
function fakeDb(rowsByTable: Readonly<Record<string, readonly unknown[]>>) {
  const reads: string[] = [];
  /** A promise of the table's rows that also answers the query-builder calls the service chains onto a SELECT. */
  const builderFor = (table: string) => {
    const rows: Promise<unknown[]> = Promise.resolve([...(rowsByTable[table] ?? [])]);
    const chain: Record<string, () => unknown> = {};
    for (const method of ["where", "orderBy", "limit", "innerJoin", "leftJoin", "for"]) {
      chain[method] = () => builder;
    }
    const builder: Promise<unknown[]> = Object.assign(rows, chain);
    return builder;
  };
  const tx = {
    execute: async () => [],
    select: () => ({
      from: (table: unknown) => {
        const name = TABLE_NAMES.get(table) ?? "other";
        reads.push(name);
        return builderFor(name);
      },
    }),
  };
  const db = { transaction: async (run: (tx: unknown) => unknown) => run(tx) };
  return { db: db as unknown as DbClient, reads };
}

const ciphers: HearthnoteCiphers = {
  freeText: { seal: async (_org, text) => text, open: async (_org, text) => text },
  narrative: {
    seal: async (_org, text) => `sealed:${text}`,
    open: async (_org, text) => text.replace(/^sealed:/, "opened:"),
  },
};

function serviceOver(rows: Readonly<Record<string, readonly unknown[]>>) {
  const { db, reads } = fakeDb(rows);
  const woundReads: string[] = [];
  const woundReader = {
    async woundsForEncounter({ encounterId }: { encounterId: string }) {
      woundReads.push(encounterId);
      return [] as readonly RecordedWound[];
    },
  };
  const service = createDbEncounterRouteService(
    db,
    undefined,
    ciphers,
    () => new Date("2026-03-10T15:00:00Z"),
    undefined,
    woundReader,
  );
  return { service, reads, woundReads };
}

describe("a pinned note reads no wounds and no live facts", () => {
  const pinned = {
    encounter: [encounterRow("signed")],
    assembled_output: [pinnedRow],
    selection: [selectionRow],
  };

  it("renders from the pin alone: no wound seam call, and no vitals, findings or selections read", async () => {
    const { service, reads, woundReads } = serviceOver(pinned);

    const payload = await service.renderPayload(ORG, ENC_ID);

    expect(payload).toEqual({
      encounterId: ENC_ID,
      patientId: PATIENT,
      final: "opened:final",
      clinicianEdited: true,
      pinned: true,
    });
    expect(woundReads).toEqual([]);
    // The pin through the per-viewer note reader (its row, then its sealed sections: "other"), then the pin's edited flag; nothing else.
    expect(reads).toEqual(["encounter", "assembled_output", "other", "assembled_output"]);
  });

  it("answers the selections read from the pin: the pinned preview, never stale, with no wound or findings read", async () => {
    const { service, reads, woundReads } = serviceOver(pinned);

    const view = await service.getSelections(ORG, ENC_ID);

    expect(view.layer1Preview).toBe("opened:layer1");
    expect(view.editedNarrative).toBe("opened:final");
    expect(view.editedNarrativeStale).toBe(false);
    expect(view.version).toBe(4);
    expect(woundReads).toEqual([]);
    expect(reads).toEqual(["encounter", "assembled_output", "selection"]);
  });

  it("reads the same whatever the wounds are now: the answer does not depend on them", async () => {
    const first = serviceOver(pinned);
    const before = await first.service.getSelections(ORG, ENC_ID);
    // M9's answer changes after the sign (a wound recorded or an observation corrected), and even throws: the pinned note never asks.
    const { db } = fakeDb(pinned);
    const throwing = createDbEncounterRouteService(db, undefined, ciphers, undefined, undefined, {
      async woundsForEncounter() {
        throw new Error("M9 is unavailable");
      },
    });
    expect(await throwing.getSelections(ORG, ENC_ID)).toEqual(before);
    await expect(throwing.renderPayload(ORG, ENC_ID)).resolves.toMatchObject({ pinned: true });
  });

  it("an edit-free pin reports no edited text", async () => {
    const { service } = serviceOver({
      ...pinned,
      assembled_output: [{ ...pinnedRow, clinicianEdited: false }],
    });
    const view = await service.getSelections(ORG, ENC_ID);
    expect(view.editedNarrative).toBeNull();
    expect(view.editedNarrativeStale).toBe(false);
  });
});

describe("an unpinned note (control) is previewed live and does read the wounds", () => {
  const draft = { encounter: [encounterRow("draft")], selection: [selectionRow] };

  it("renders a draft as an unpinned preview, after reading the wounds once", async () => {
    const { service, woundReads, reads } = serviceOver(draft);

    const payload = await service.renderPayload(ORG, ENC_ID);

    expect(payload.pinned).toBe(false);
    expect(woundReads).toEqual([ENC_ID]);
    expect(reads).toContain("vitals"); // the live facts were consulted
  });

  it("previews a draft's selections live, reading the wounds once", async () => {
    const { service, woundReads } = serviceOver(draft);

    const view = await service.getSelections(ORG, ENC_ID);

    expect(woundReads).toEqual([ENC_ID]);
    expect(view.editedNarrativeStale).toBe(false);
    expect(typeof view.layer1Preview).toBe("string");
  });
});
