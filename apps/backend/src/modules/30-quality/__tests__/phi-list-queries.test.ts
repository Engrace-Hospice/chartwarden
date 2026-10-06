// GAP-091 — the incident / mortality / infection LIST queries push every filter, the patient scope and
// the keyset cursor into SQL (no fixed in-memory window), and page by fetching size+1.
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  incidentListWhere,
  infectionEventListWhere,
  mortalityListWhere,
  splitPage,
  toListCursor,
} from "../routes/phi-list-queries";

const ORG = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222221";
const dialect = new PgDialect();
const render = (q: ReturnType<typeof incidentListWhere>) => dialect.sqlToQuery(q);
const CURSOR = {
  at: new Date("2026-08-01T00:00:00.000Z"),
  id: "33333333-3333-4333-8333-333333333333",
};

describe("incidentListWhere", () => {
  it("always binds the org and hides abuse allegations without the permission", () => {
    const { sql, params } = render(incidentListWhere(ORG, {}, { kind: "org" }, undefined));
    expect(sql).toContain('"organization_id" = $1');
    expect(sql).toMatch(/"kind" <> \$/);
    expect(params).toContain("allegation_of_abuse");
  });

  it("does not hide abuse allegations when the caller holds incident.abuse_review", () => {
    const { params } = render(
      incidentListWhere(ORG, { mayViewAbuseAllegations: true }, { kind: "org" }, undefined),
    );
    expect(params).not.toContain("allegation_of_abuse");
  });

  it("pushes kind/state/severity/date filters into SQL", () => {
    const { sql, params } = render(
      incidentListWhere(
        ORG,
        {
          kinds: ["fall"],
          states: ["submitted"],
          severities: ["severe"],
          occurredAfter: "2026-01-01T00:00:00.000Z",
          occurredBefore: "2026-12-31T00:00:00.000Z",
          mayViewAbuseAllegations: true,
        },
        { kind: "org" },
        undefined,
      ),
    );
    expect(sql).toMatch(/"kind" in/);
    expect(sql).toMatch(/"lifecycle" in/);
    expect(sql).toMatch(/"severity" in/);
    expect(sql).toMatch(/"occurred_at" >=/);
    expect(sql).toMatch(/"occurred_at" <=/);
    expect(params).toEqual(expect.arrayContaining(["fall", "submitted", "severe"]));
  });

  it("composes the caseload scope as IN (...) on patient_id (or patient-less)", () => {
    const { sql, params } = render(
      incidentListWhere(ORG, {}, { kind: "caseload", patientIds: [P1] }, undefined),
    );
    expect(sql).toMatch(/"patient_id" in/);
    expect(sql).toMatch(/"patient_id" is null/);
    expect(params).toContain(P1);
  });

  it("an EMPTY caseload matches no patient row (never degenerates to unscoped)", () => {
    const { sql } = render(
      incidentListWhere(ORG, {}, { kind: "caseload", patientIds: [] }, undefined),
    );
    expect(sql).toMatch(/false/);
    expect(sql).not.toMatch(/"patient_id" in/);
  });

  it("an own-record arm (reporter / triage assignee) rides along only for a caseload scope", () => {
    const own = "44444444-4444-4444-8444-444444444444";
    const scoped = render(
      incidentListWhere(ORG, {}, { kind: "caseload", patientIds: [] }, undefined, own),
    );
    expect(scoped.sql).toMatch(/"reported_by_membership_id" =/);
    expect(scoped.sql).toMatch(/"triaged_by_membership_id" =/);
    expect(scoped.params).toContain(own);
    const orgWide = render(incidentListWhere(ORG, {}, { kind: "org" }, undefined, own));
    expect(orgWide.params).not.toContain(own);
  });

  it("adds a keyset predicate on (occurred_at, id) for a cursor", () => {
    const { sql, params } = render(incidentListWhere(ORG, {}, { kind: "org" }, CURSOR));
    expect(sql).toMatch(/"occurred_at" </);
    expect(sql).toMatch(/"id" </);
    expect(params).toContain(CURSOR.id);
  });
});

describe("mortalityListWhere", () => {
  it("maps the view status onto the stored statuses in SQL", () => {
    const inProgress = render(
      mortalityListWhere(ORG, { status: "in_progress" }, { kind: "org" }, undefined),
    );
    expect(inProgress.params).toEqual(expect.arrayContaining(["in_progress", "overdue"]));
    const created = render(
      mortalityListWhere(ORG, { status: "created" }, { kind: "org" }, undefined),
    );
    expect(created.params).toContain("pending");
  });

  it("scopes to the caseload and keysets on death_at", () => {
    const { sql, params } = render(
      mortalityListWhere(ORG, {}, { kind: "caseload", patientIds: [P1] }, CURSOR),
    );
    expect(sql).toMatch(/"deceased_patient_id" in/);
    expect(sql).toMatch(/"death_at" </);
    expect(params).toContain(P1);
  });
});

describe("infectionEventListWhere", () => {
  it("pushes pathogen/date filters, the caseload scope and the observed_at keyset into SQL", () => {
    const { sql, params } = render(
      infectionEventListWhere(
        ORG,
        { pathogen: "norovirus", observedAfter: "2026-01-01T00:00:00.000Z" },
        { kind: "caseload", patientIds: [P1] },
        CURSOR,
      ),
    );
    expect(sql).toMatch(/"pathogen" =/);
    expect(sql).toMatch(/"observed_at" >=/);
    expect(sql).toMatch(/"observed_at" </);
    expect(sql).toMatch(/"patient_id" in/);
    expect(params).toEqual(expect.arrayContaining(["norovirus", P1]));
  });
});

describe("splitPage", () => {
  const rows = [1, 2, 3, 4, 5].map((n) => ({ n }));
  it("reports hasMore when size+1 rows came back, and trims the probe row", () => {
    const { page, hasMore } = splitPage(rows, 4);
    expect(page).toHaveLength(4);
    expect(hasMore).toBe(true);
  });
  it("reports no more when the fetch was not over-full", () => {
    const { page, hasMore } = splitPage(rows, 5);
    expect(page).toHaveLength(5);
    expect(hasMore).toBe(false);
  });
});

describe("toListCursor", () => {
  it("round-trips an encoded keyset", () => {
    const raw = Buffer.from(
      JSON.stringify({ createdAt: CURSOR.at.toISOString(), id: CURSOR.id }),
      "utf8",
    ).toString("base64url");
    expect(toListCursor(raw)).toEqual(CURSOR);
    expect(toListCursor(undefined)).toBeUndefined();
  });

  it("rejects a malformed or non-date cursor with 400 rather than paging from the start", () => {
    expect(() => toListCursor("not-a-cursor")).toThrow(/malformed/);
    const bad = Buffer.from(JSON.stringify({ createdAt: "nope", id: "x" })).toString("base64url");
    expect(() => toListCursor(bad)).toThrow(/malformed/);
  });
});
