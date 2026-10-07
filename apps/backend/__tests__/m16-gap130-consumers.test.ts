// apps/backend/__tests__/m16-gap130-consumers.test.ts — GAP-130: M16's two §4.5 consumers that had no
// handler (`m8.encounter.signed` → in-person visit completion, `m22.document.rendered` → the outreach
// artifact back-ref), the catalog declarations that route them, and the subscription-exception ledger
// shrinking to exactly what is still a deliberate non-subscription.
//
// The DB-touching happy paths are proven over real Postgres (as the NOBYPASSRLS app role, through the
// real catalog-validating publisher) in ./m16-encounter-signed.live.test.ts and
// ./m16-document-rendered.live.test.ts. What is here is the pure decision core and every OFF-path, where
// the correct behaviour is to open no transaction at all — both events fan out to many modules, so
// "ignore what is not mine" is the routing mechanism, not defensive coding.
import { M16_SUBSCRIBED_EVENT_NAMES } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_EXCEPTIONS } from "../../../scripts/outbox-subscription-exceptions";
import { M8_OUTBOX_EVENTS } from "../src/modules/08-encounters/events-by-m8";
import {
  M16_DOCUMENT_RENDERED_CONSUMER,
  M16_ENCOUNTER_SIGNED_CONSUMER,
  SCHEDULED_EARLY_WINDOW_MS,
  buildM16DocumentRenderedConsumer,
  buildM16EncounterSignedConsumer,
  decideRenderedBackref,
  selectOutreachForSignedEncounter,
} from "../src/modules/16-bereavement/index";
import { M22_OUTBOX_EVENTS } from "../src/modules/22-documents/events-by-m22";

const ORG = "00000000-0000-4000-8000-0000000000ee";

/** A `db` that fails loudly if a consumer opens a transaction it should never have opened. */
const NEVER_DB = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`the consumer touched the database (.${String(prop)}) on an off-path`);
    },
  },
) as never;

const NEVER_OUTBOX = {
  async publish() {
    throw new Error("the consumer published on an off-path");
  },
};

// ── the pure selection core ─────────────────────────────────────────────────────────────────────────────

describe("selectOutreachForSignedEncounter — which scheduled visit a signed encounter fulfils", () => {
  const SIGNED = "2026-04-10T15:00:00.000Z";
  const row = (
    id: string,
    status: string,
    dueAt: string,
    lateGraceUntil = "2026-12-31T00:00:00.000Z",
  ) => ({ id, status, dueAt: new Date(dueAt), lateGraceUntil: new Date(lateGraceUntil) });

  it("prefers the visit the counselor already STARTED (the deep-link that opened the M8 draft)", () => {
    const picked = selectOutreachForSignedEncounter(
      [
        row("near-scheduled", "scheduled", "2026-04-10T00:00:00.000Z"),
        row("far-started", "in_progress", "2026-03-01T00:00:00.000Z"),
      ],
      SIGNED,
    );
    expect(picked?.id).toBe("far-started");
  });

  it("otherwise takes the scheduled visit whose due date is nearest the signature", () => {
    const picked = selectOutreachForSignedEncounter(
      [
        row("week-1", "scheduled", "2026-03-08T00:00:00.000Z"),
        row("month-1", "scheduled", "2026-04-01T00:00:00.000Z"),
        row("month-3", "scheduled", "2026-06-01T00:00:00.000Z"),
      ],
      SIGNED,
    );
    expect(picked?.id).toBe("month-1");
  });

  it("a MISSED visit is fulfilled only inside its late grace (inclusive), never after it", () => {
    const inside = selectOutreachForSignedEncounter(
      [row("missed", "missed", "2026-04-01T00:00:00.000Z", SIGNED)],
      SIGNED,
    );
    expect(inside?.id).toBe("missed");
    const after = selectOutreachForSignedEncounter(
      [row("missed", "missed", "2026-04-01T00:00:00.000Z", "2026-04-10T14:59:59.999Z")],
      SIGNED,
    );
    expect(after).toBeNull();
  });

  it("terminal touchpoints are never re-fulfilled; no candidate is a null (an ad-hoc visit)", () => {
    for (const status of ["completed", "declined", "no_response", "cancelled"]) {
      expect(
        selectOutreachForSignedEncounter([row("t", status, "2026-04-10T00:00:00.000Z")], SIGNED),
      ).toBeNull();
    }
    expect(selectOutreachForSignedEncounter([], SIGNED)).toBeNull();
  });

  it("never completes a scheduled visit due more than the early window out (an ad-hoc visit stays ad hoc)", () => {
    const sixMonth = row("month-6", "scheduled", "2026-10-01T00:00:00.000Z");
    expect(selectOutreachForSignedEncounter([sixMonth], SIGNED)).toBeNull();
    const edge = new Date(Date.parse(SIGNED) + SCHEDULED_EARLY_WINDOW_MS).toISOString();
    expect(
      selectOutreachForSignedEncounter([row("in-window", "scheduled", edge)], SIGNED)?.id,
    ).toBe("in-window");
    const justOut = new Date(Date.parse(SIGNED) + SCHEDULED_EARLY_WINDOW_MS + 1).toISOString();
    expect(selectOutreachForSignedEncounter([row("out", "scheduled", justOut)], SIGNED)).toBeNull();
  });

  it("is deterministic on a tie (id order), so a redelivery picks the same row", () => {
    const a = row("b-row", "scheduled", "2026-04-09T15:00:00.000Z");
    const b = row("a-row", "scheduled", "2026-04-11T15:00:00.000Z");
    expect(selectOutreachForSignedEncounter([a, b], SIGNED)?.id).toBe("a-row");
    expect(selectOutreachForSignedEncounter([b, a], SIGNED)?.id).toBe("a-row");
  });
});

describe("decideRenderedBackref — stamp once, and complete only §4.5's three kinds", () => {
  const base = {
    kind: "sympathy_card",
    status: "in_progress",
    renderedDocumentId: null,
    loggerMembershipId: "00000000-0000-4000-8000-00000000c001",
  } as const;

  it("stamps and completes an in-progress card / sympathy letter / anniversary letter", () => {
    for (const kind of ["sympathy_card", "sympathy_letter", "anniversary_letter"] as const) {
      expect(decideRenderedBackref({ ...base, kind })).toEqual({ stamp: true, complete: true });
    }
  });

  it("stamps but does NOT complete an invitation or a referral letter (the family / counselor closes those)", () => {
    for (const kind of ["group_support_invitation", "external_referral"] as const) {
      expect(decideRenderedBackref({ ...base, kind })).toEqual({ stamp: true, complete: false });
    }
  });

  it("a redelivery (back-ref already set) writes nothing at all", () => {
    expect(
      decideRenderedBackref({
        ...base,
        renderedDocumentId: "00000000-0000-4000-8000-00000000d001",
      }),
    ).toEqual({ stamp: false, complete: false });
  });

  it("an outreach that already left in_progress keeps its own outcome — stamp only", () => {
    for (const status of ["completed", "cancelled", "declined", "no_response", "scheduled"]) {
      expect(decideRenderedBackref({ ...base, status })).toEqual({ stamp: true, complete: false });
    }
  });

  it("with no counselor to attribute the log row to, the outreach is stamped but left for a human", () => {
    expect(decideRenderedBackref({ ...base, loggerMembershipId: null })).toEqual({
      stamp: true,
      complete: false,
    });
  });
});

// ── the off-paths: no transaction, no publish ───────────────────────────────────────────────────────────

describe("m8.encounter.signed → M16 — only a signed bereavement_contact encounter is M16's", () => {
  const consumer = buildM16EncounterSignedConsumer({ db: NEVER_DB, outbox: NEVER_OUTBOX });

  it("binds exactly the one event, as m16", () => {
    expect(consumer.consumerModule).toBe("m16");
    expect(consumer.eventTypes).toEqual([M16_ENCOUNTER_SIGNED_CONSUMER.eventName]);
    expect(consumer.consumerName).toBe("m16.m8-encounter-signed");
  });

  it("ignores every other encounter type without opening a transaction", async () => {
    for (const encounterType of ["routine_visit", "msw_followup", "chaplain_visit"]) {
      await expect(
        consumer.handle({
          organizationId: ORG,
          payload: {
            encounterId: "e1",
            patientId: "p1",
            admissionId: "a1",
            encounterType,
            signedByMembershipId: "m1",
            signedAt: "2026-04-10T15:00:00.000Z",
          },
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("a malformed bereavement_contact payload throws (retry-then-DLQ), never a silent no-op", async () => {
    await expect(
      consumer.handle({
        organizationId: ORG,
        payload: { encounterType: "bereavement_contact", encounterId: "e1" },
      }),
    ).rejects.toThrow(/m16\.m8-encounter-signed/);
  });
});

describe("m22.document.rendered → M16 — only M16's own artifact request is M16's", () => {
  const consumer = buildM16DocumentRenderedConsumer({ db: NEVER_DB, outbox: NEVER_OUTBOX });
  const rendered = (over: Record<string, unknown>) => ({
    organizationId: ORG,
    payload: {
      documentId: "00000000-0000-4000-8000-0000000000d0",
      aggregateType: "bereavement_letter",
      aggregateId: "00000000-0000-4000-8000-0000000000a0",
      sourceModule: "m16",
      sourceEvent: "m16.bereavement.outreach_artifact_requested",
      templateKey: "bereavement_letter",
      ...over,
    },
  });

  it("binds exactly the one event, as m16", () => {
    expect(consumer.consumerModule).toBe("m16");
    expect(consumer.eventTypes).toEqual([M16_DOCUMENT_RENDERED_CONSUMER.eventName]);
    expect(consumer.consumerName).toBe("m16.document-backref");
  });

  it("ignores another module's document, a foreign aggregate type, and the plan's welcome packet", async () => {
    for (const over of [
      { sourceModule: "m11", sourceEvent: "m11.order.document_requested" },
      { aggregateType: "order_record" },
      // The welcome packet is filed against the PLAN (no outreach exists at plan-open), so it has no
      // outreach back-ref column to stamp.
      { templateKey: "bereavement_welcome_packet" },
      { documentId: 42 },
    ]) {
      await expect(consumer.handle(rendered(over))).resolves.toBeUndefined();
    }
  });
});

// ── the catalog + ledger move together with the bindings ────────────────────────────────────────────────

describe("GAP-130 — catalog declarations and the subscription-exception ledger", () => {
  it("m8.encounter.signed and m22.document.rendered now declare m16 (bound in index.ts)", () => {
    const signed = M8_OUTBOX_EVENTS.find((e) => e.eventName === "m8.encounter.signed");
    const rendered = M22_OUTBOX_EVENTS.find((e) => e.eventName === "m22.document.rendered");
    expect(signed?.declaredConsumers).toContain("m16");
    expect(rendered?.declaredConsumers).toContain("m16");
  });

  it("M16's exceptions are only the record-only targets; m8/m22 left the ledger", () => {
    const m16 = SUBSCRIPTION_EXCEPTIONS.filter((g) => g.module === "m16");
    expect(m16.map((g) => g.kind)).toEqual(["record-only-target"]);
    expect([...(m16[0]?.events ?? [])].sort()).toEqual([
      "m39.consent.created",
      "m4.legal_hold.applied",
      "m4.legal_hold.released",
    ]);
    expect(M16_SUBSCRIBED_EVENT_NAMES).toContain("m8.encounter.signed");
    expect(M16_SUBSCRIBED_EVENT_NAMES).toContain("m22.document.rendered");
  });
});
