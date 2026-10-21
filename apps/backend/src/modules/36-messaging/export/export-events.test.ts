// ADR-0089 S2 - every export event payload the builders produce satisfies its catalog schema, carries no free text, and the catalog and the
// shared contract name the same six events.
import { MESSAGING_EXPORT_EVENT_NAMES } from "@chartwarden/types";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { M36_OUTBOX_EVENTS } from "../events-by-m36";
import { type ExportEventFacts, M36_EXPORT_EVENTS, exportEventPayload } from "./export-events";

const at = new Date("2026-10-21T10:00:00.000Z");
const base = { orgId: "o1", jobId: "j1" };
const FACTS: readonly ExportEventFacts[] = [
  { kind: "requested", ...base, requestedBy: "u1", at },
  { kind: "approved", ...base, requestedBy: "u1", decidedBy: "u2", at },
  { kind: "rejected", ...base, requestedBy: "u1", decidedBy: "u2", at },
  { kind: "ready", ...base, requestedBy: "u1", at, expiresAt: new Date(at.getTime() + 86_400_000) },
  { kind: "downloaded", ...base, downloadedBy: "u1", at },
  { kind: "expired", ...base, at },
];

describe("m36 export events", () => {
  it("catalog and contract list the same six event names", () => {
    const cataloged = M36_OUTBOX_EVENTS.filter((e) => e.eventName.startsWith("m36.export.")).map(
      (e) => e.eventName,
    );
    expect(cataloged.sort()).toEqual([...MESSAGING_EXPORT_EVENT_NAMES].sort());
    expect(Object.values(M36_EXPORT_EVENTS).sort()).toEqual(
      [...MESSAGING_EXPORT_EVENT_NAMES].sort(),
    );
  });

  for (const facts of FACTS) {
    it(`${facts.kind}: the payload satisfies the catalog schema and holds ids and instants only`, () => {
      const entry = M36_OUTBOX_EVENTS.find((e) => e.eventName === M36_EXPORT_EVENTS[facts.kind]);
      const payload = exportEventPayload(facts);
      expect(entry && Value.Check(entry.payloadSchema, payload)).toBe(true);
      expect(payload.organizationId).toBe("o1");
      expect(Object.keys(payload)).not.toContain("justification");
      expect(Object.keys(payload)).not.toContain("note");
    });
  }

  it("only `requested` and `approved` have a consumer", () => {
    const withConsumers = M36_OUTBOX_EVENTS.filter(
      (e) => e.eventName.startsWith("m36.export.") && e.declaredConsumers.length > 0,
    ).map((e) => e.eventName);
    expect(withConsumers.sort()).toEqual(["m36.export.approved", "m36.export.requested"]);
  });
});
