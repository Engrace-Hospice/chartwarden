// @wardenx/audit — M4-T06 unit tests for the audit query surface (M4 spec §4.1–4.3, §10.2).
//
// Proves the query primitives without live infra:
//   • ORG SCOPE — a tenant query never sees another org's rows (nor org-NULL system events).
//   • FILTERS — actor/resourceKind/eventType/outcome/severity/from/to/patientId AND-combine.
//   • PAGINATION — newest-first, opaque cursor is stable and round-trips; nextCursor is null on
//     the last page.
//   • PATIENT ACCESS (§10.2) — only access-type events that TOUCH the patient are returned, with
//     break-glass flagged and field NAMES surfaced.
import { describe, expect, it } from "vitest";
import {
  type AuditEventRecord,
  createInMemoryAuditQuery,
  decodeCursor,
  encodeCursor,
  eventTouchesPatient,
  isAccessEvent,
  resolveLimit,
} from "../src/index";

function rec(over: Partial<AuditEventRecord> & { id: string; createdAt: string }): AuditEventRecord {
  return {
    organizationId: "org_a",
    actorUserId: "user_1",
    actorKind: "user",
    actorRole: null,
    eventType: "patient.updated",
    resourceKind: "patient",
    resourceId: "pat_1",
    outcome: "success",
    severity: "info",
    before: null,
    after: null,
    context: {},
    retentionClass: "compliance",
    ...over,
  };
}

describe("resolveLimit()", () => {
  it("defaults, clamps to [1,200], and floors", () => {
    expect(resolveLimit(undefined)).toBe(50);
    expect(resolveLimit(0)).toBe(1);
    expect(resolveLimit(5000)).toBe(200);
    expect(resolveLimit(10.9)).toBe(10);
  });
});

describe("cursor encode/decode", () => {
  it("round-trips an opaque (createdAt,id) cursor", () => {
    const c = encodeCursor({ createdAt: "2026-06-01T00:00:00.000Z", id: "abc-123" });
    expect(decodeCursor(c)).toEqual({ createdAt: "2026-06-01T00:00:00.000Z", id: "abc-123" });
  });
  it("returns null for a malformed cursor", () => {
    expect(decodeCursor("@@not-base64@@")).toBeNull();
  });
});

describe("predicates", () => {
  it("eventTouchesPatient: via context.patientId or a patient-kind row", () => {
    expect(eventTouchesPatient(rec({ id: "1", createdAt: "t", context: { patientId: "p9" } }), "p9")).toBe(true);
    expect(eventTouchesPatient(rec({ id: "2", createdAt: "t", resourceKind: "patient", resourceId: "p9", context: {} }), "p9")).toBe(true);
    expect(eventTouchesPatient(rec({ id: "3", createdAt: "t", resourceKind: "encounter", resourceId: "e1", context: {} }), "p9")).toBe(false);
  });
  it("isAccessEvent: viewed/disclosed/list_viewed/break-glass access", () => {
    expect(isAccessEvent(rec({ id: "1", createdAt: "t", eventType: "patient.viewed" }))).toBe(true);
    expect(isAccessEvent(rec({ id: "2", createdAt: "t", eventType: "patient.disclosed" }))).toBe(true);
    expect(isAccessEvent(rec({ id: "3", createdAt: "t", eventType: "m3.breakglass.access", context: { breakGlassEventId: "bg1" } }))).toBe(true);
    expect(isAccessEvent(rec({ id: "4", createdAt: "t", eventType: "patient.updated" }))).toBe(false);
  });
});

describe("createInMemoryAuditQuery().searchEvents", () => {
  it("scopes to the org and applies AND-combined filters", async () => {
    const { query } = createInMemoryAuditQuery([
      rec({ id: "1", createdAt: "2026-06-01T00:00:00Z", organizationId: "org_a", eventType: "patient.created" }),
      rec({ id: "2", createdAt: "2026-06-02T00:00:00Z", organizationId: "org_a", eventType: "patient.updated" }),
      rec({ id: "3", createdAt: "2026-06-03T00:00:00Z", organizationId: "org_b", eventType: "patient.created" }),
    ]);
    const all = await query.searchEvents("org_a", {});
    expect(all.items.map((e) => e.id)).toEqual(["2", "1"]); // newest-first
    const filtered = await query.searchEvents("org_a", { eventType: "patient.created" });
    expect(filtered.items.map((e) => e.id)).toEqual(["1"]);
    const other = await query.searchEvents("org_b", {});
    expect(other.items.map((e) => e.id)).toEqual(["3"]);
  });

  it("paginates newest-first with a stable cursor", async () => {
    const seed = Array.from({ length: 5 }, (_, i) =>
      rec({ id: `e${i}`, createdAt: `2026-06-0${i + 1}T00:00:00Z` }),
    );
    const { query } = createInMemoryAuditQuery(seed);
    const page1 = await query.searchEvents("org_a", { limit: 2 });
    expect(page1.items.map((e) => e.id)).toEqual(["e4", "e3"]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await query.searchEvents("org_a", { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((e) => e.id)).toEqual(["e2", "e1"]);
    const page3 = await query.searchEvents("org_a", { limit: 2, cursor: page2.nextCursor! });
    expect(page3.items.map((e) => e.id)).toEqual(["e0"]);
    expect(page3.nextCursor).toBeNull();
  });
});

describe("createInMemoryAuditQuery().getEvent", () => {
  it("returns the row in-org, null cross-org", async () => {
    const { query } = createInMemoryAuditQuery([
      rec({ id: "1", createdAt: "t", organizationId: "org_a" }),
    ]);
    expect((await query.getEvent("org_a", "1"))?.id).toBe("1");
    expect(await query.getEvent("org_b", "1")).toBeNull();
    expect(await query.getEvent("org_a", "missing")).toBeNull();
  });
});

describe("createInMemoryAuditQuery().patientAccess (§10.2)", () => {
  it("returns only access events touching the patient, break-glass flagged", async () => {
    const { query } = createInMemoryAuditQuery([
      rec({ id: "v", createdAt: "2026-06-01T00:00:00Z", eventType: "patient.viewed", resourceId: "p9", context: { fields: ["name", "dob"] } }),
      rec({ id: "bg", createdAt: "2026-06-02T00:00:00Z", eventType: "m3.breakglass.access", resourceKind: "patient", resourceId: "p9", context: { breakGlassEventId: "bg1" } }),
      rec({ id: "mut", createdAt: "2026-06-03T00:00:00Z", eventType: "patient.updated", resourceId: "p9" }), // not an access event
      rec({ id: "other", createdAt: "2026-06-04T00:00:00Z", eventType: "patient.viewed", resourceId: "p_other" }), // other patient
    ]);
    const page = await query.patientAccess("org_a", "p9", {});
    expect(page.items.map((e) => e.eventId)).toEqual(["bg", "v"]); // newest-first, mut + other excluded
    const view = page.items.find((e) => e.eventId === "v")!;
    expect(view.fields).toEqual(["name", "dob"]);
    expect(view.viaBreakGlass).toBe(false);
    expect(page.items.find((e) => e.eventId === "bg")!.viaBreakGlass).toBe(true);
  });
});

describe("accounting() — §164.528 / §2.13 scope differentiation (M4-T09, §7)", () => {
  const seed = [
    // a non-SUD external disclosure (HIPAA-accountable).
    rec({ id: "d1", createdAt: "2026-01-01T00:00:00.000Z", eventType: "encounter.disclosed", resourceKind: "encounter", resourceId: "e1", context: { patientId: "p9", fields: ["dx"], disclosure: { to: "Acme", purpose: "legal" } } }),
    // an old SUD disclosure (Part 2 class).
    rec({ id: "d2", createdAt: "2018-01-01T00:00:00.000Z", eventType: "lab_observation.disclosed", resourceKind: "lab_observation", resourceId: "l1", retentionClass: "compliance_42cfr_part2", context: { patientId: "p9", disclosure: { to: "County", purpose: "report" } } }),
    // a SUD unredact exercise carrying a rationale.
    rec({ id: "d3", createdAt: "2024-01-01T00:00:00.000Z", eventType: "sud.unredact.exercise", resourceKind: "lab_observation", resourceId: "l1", retentionClass: "compliance_42cfr_part2", context: { patientId: "p9", rationale: "court order" } }),
    // routine TPO view — excluded from every accounting scope.
    rec({ id: "v", createdAt: "2026-02-01T00:00:00.000Z", eventType: "patient.viewed", resourceId: "p9", context: { patientId: "p9" } }),
  ];
  const window = { from: new Date(0).toISOString(), to: "2030-01-01T00:00:00.000Z" };

  it("hipaa_528 returns external disclosures only (no TPO views, no unredact exercise)", async () => {
    const { query } = createInMemoryAuditQuery(seed);
    const r = await query.accounting("org_a", "p9", { scope: "hipaa_528", ...window });
    expect(r.disclosures.map((d) => d.eventId)).toEqual(["d1", "d2"]); // newest-first; v + d3 excluded
    expect(r.disclosures.every((d) => d.rationale === undefined)).toBe(true);
    expect(r.note).toContain("§164.528(a)(1)");
  });

  it("part_2_13 returns SUD disclosures + unredact exercises, surfacing the rationale (§4.6.4)", async () => {
    const { query } = createInMemoryAuditQuery(seed);
    const r = await query.accounting("org_a", "p9", { scope: "part_2_13", ...window });
    expect(r.disclosures.map((d) => d.eventId)).toEqual(["d3", "d2"]); // SUD only; d1 (non-SUD) excluded
    expect(r.disclosures.find((d) => d.eventId === "d3")!.rationale).toBe("court order");
  });

  it("all returns the union of disclosures + unredact exercises", async () => {
    const { query } = createInMemoryAuditQuery(seed);
    const r = await query.accounting("org_a", "p9", { scope: "all", ...window });
    expect(new Set(r.disclosures.map((d) => d.eventId))).toEqual(new Set(["d1", "d2", "d3"]));
  });

  it("respects the window bounds the route computes (clamps out events before `from`)", async () => {
    const { query } = createInMemoryAuditQuery(seed);
    const r = await query.accounting("org_a", "p9", { scope: "hipaa_528", from: "2020-01-01T00:00:00.000Z", to: window.to });
    expect(r.disclosures.map((d) => d.eventId)).toEqual(["d1"]); // d2 (2018) clamped out
    expect(r.period).toEqual({ from: "2020-01-01T00:00:00.000Z", to: window.to });
  });

  it("is org-scoped — never returns another tenant's disclosure", async () => {
    const { query } = createInMemoryAuditQuery([
      ...seed,
      rec({ id: "x", organizationId: "org_b", createdAt: "2026-03-01T00:00:00.000Z", eventType: "encounter.disclosed", context: { patientId: "p9", disclosure: { to: "X", purpose: "y" } } }),
    ]);
    const r = await query.accounting("org_a", "p9", { scope: "all", ...window });
    expect(r.disclosures.map((d) => d.eventId)).not.toContain("x");
  });
});
