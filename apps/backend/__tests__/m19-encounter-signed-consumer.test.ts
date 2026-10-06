// GAP-058 — M19 D8: `m8.encounter.signed` advances the linked triage call to `documented`.
// Unit tests over an in-memory unit of work; the real relay + RLS half is the composition-root wiring
// assertion below.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrgId, TriageCallId } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { M8_OUTBOX_EVENTS } from "../src/modules/08-encounters/events-by-m8";
import {
  type EncounterSignedCallRow,
  type EncounterSignedTx,
  applyEncounterSigned,
  parseEncounterSignedPayload,
} from "../src/modules/19-oncall/index";

const ORG = "11111111-1111-4111-8111-111111111111" as OrgId;
const ENCOUNTER = "33333333-3333-4333-8333-333333333333";
const SIGNED_AT = "2026-10-05T03:30:00.000Z";
const NOW = new Date("2026-10-05T04:00:00.000Z");

const payload = {
  encounterId: ENCOUNTER,
  patientId: "44444444-4444-4444-8444-444444444444",
  admissionId: "55555555-5555-4555-8555-555555555555",
  signedByMembershipId: "66666666-6666-4666-8666-666666666666",
  signedAt: SIGNED_AT,
};

const call = (over: Partial<EncounterSignedCallRow> = {}): EncounterSignedCallRow => ({
  triageCallId: "77777777-7777-4777-8777-777777777777" as TriageCallId,
  providerEntityId: "88888888-8888-4888-8888-888888888888",
  locationId: null,
  patientId: payload.patientId,
  disposition: "caregiver_education_only",
  state: "documented_pending_encounter",
  version: 4,
  selectedProtocolId: null,
  linkedEncounterId: ENCOUNTER,
  firstResponseAt: null,
  documentedAt: null,
  paperOriginFlag: false,
  ...over,
});

function harness(initial: EncounterSignedCallRow | null, versionMoves = false) {
  const outbox: { eventName: string; payload: Record<string, unknown> }[] = [];
  const history: { fromState: string | null; toState: string; systemActor: boolean }[] = [];
  const applied: { to: string; documentedAt?: Date }[] = [];
  const orgs: string[] = [];
  const tx: EncounterSignedTx = {
    handle: {},
    async lockCallByLinkedEncounter() {
      return initial;
    },
    async applyDocumented(_call, patch, to) {
      if (versionMoves) return false;
      applied.push({ to, ...(patch.documentedAt ? { documentedAt: patch.documentedAt } : {}) });
      return true;
    },
  };
  return {
    outbox,
    history,
    applied,
    orgs,
    deps: {
      uow: {
        async run<T>(organizationId: OrgId, fn: (t: EncounterSignedTx) => Promise<T>) {
          orgs.push(organizationId);
          return fn(tx);
        },
      },
      outbox: {
        async publish(_tx: unknown, e: { eventName: string; payload: Record<string, unknown> }) {
          outbox.push(e);
        },
      },
      stateHistory: {
        async insert(
          _tx: unknown,
          r: { fromState: string | null; toState: string; systemActor: boolean },
        ) {
          history.push(r);
        },
      },
      now: () => NOW,
    },
  };
}

describe("parseEncounterSignedPayload", () => {
  it("normalizes signedAt and keeps the ids", () => {
    expect(parseEncounterSignedPayload(payload).signedAt).toBe(SIGNED_AT);
  });
  it.each([null, [], { ...payload, encounterId: "" }, { ...payload, signedAt: "nope" }])(
    "refuses a malformed payload %j",
    (bad) => {
      expect(() => parseEncounterSignedPayload(bad)).toThrow();
    },
  );
});

describe("applyEncounterSigned", () => {
  it("documents the call at signedAt, writes a system history row and emits m19.triage_call.documented", async () => {
    const h = harness(call());
    const id = await applyEncounterSigned(h.deps, { organizationId: ORG, payload });
    expect(id).toBe("77777777-7777-4777-8777-777777777777");
    expect(h.orgs).toEqual([ORG]);
    expect(h.applied).toEqual([{ to: "documented", documentedAt: new Date(SIGNED_AT) }]);
    expect(h.history).toEqual([
      expect.objectContaining({
        fromState: "documented_pending_encounter",
        toState: "documented",
        systemActor: true,
      }),
    ]);
    expect(h.outbox).toHaveLength(1);
    expect(h.outbox[0]?.eventName).toBe("m19.triage_call.documented");
    expect(h.outbox[0]?.payload).toMatchObject({
      orgId: ORG,
      linkedEncounterId: ENCOUNTER,
      patientId: payload.patientId,
      occurredAt: SIGNED_AT,
      dispositionSummary: "A nurse gave advice by phone.",
    });
  });

  it("skips an encounter that belongs to no triage call", async () => {
    const h = harness(null);
    expect(await applyEncounterSigned(h.deps, { organizationId: ORG, payload })).toBeNull();
    expect(h.outbox).toEqual([]);
    expect(h.applied).toEqual([]);
  });

  it.each(["documented", "closed", "disposition_pending"] as const)(
    "skips a re-delivery for a call already in %s",
    async (state) => {
      const h = harness(call({ state }));
      expect(await applyEncounterSigned(h.deps, { organizationId: ORG, payload })).toBeNull();
      expect(h.outbox).toEqual([]);
      expect(h.history).toEqual([]);
    },
  );

  it("throws when the call version moved so the relay retries", async () => {
    const h = harness(call(), true);
    await expect(applyEncounterSigned(h.deps, { organizationId: ORG, payload })).rejects.toThrow(
      /changed concurrently/,
    );
  });
});

describe("GAP-058 wiring", () => {
  it("declares m19 on m8.encounter.signed", () => {
    const event = M8_OUTBOX_EVENTS.find((e) => e.eventName === "m8.encounter.signed");
    expect(event?.declaredConsumers).toContain("m19");
  });
  it("binds the factory in the composition root", () => {
    const src = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    expect(src).toMatch(/buildOncallEncounterSignedConsumer\(\{/);
  });
});
