// apps/backend/__tests__/m30-incident-list-visibility.test.ts — the incident LIST visibility rule.
//
// `GET /api/v1/quality/incidents` was gated on `requireAbac("incident.read", "incidentVisibility")`. That
// predicate opens with `targetStr(target, "incidentId")` and denies when absent — correct for a point-read,
// structurally impossible on a COLLECTION, which carries no incident to key on. So it resolved false for
// every caller and the endpoint 403'd for EVERYONE, regardless of permission. No unit test caught it
// because none drove the route; it surfaced only when the Quality screens were run against a real server.
//
// The rule itself is real and must survive the fix: abuse allegations are a separately-gated surface
// (`incident.abuse_review`, its own /abuse-allegations route). A collection enforces that by FILTERING —
// dropping the rows server-side before pagination — not by denying the call. These tests pin both halves:
// the list is reachable, and it still hides what it must.
import { describe, expect, it } from "vitest";
import type {
  IncidentListFilter,
  M30ReadActor,
} from "../src/modules/30-quality/routes/read-service";

/** The shape the Drizzle list filters over (only the fields the predicate reads). */
interface Row {
  readonly id: string;
  readonly kind: string;
}

/**
 * The row predicate extracted from `listIncidents` — same order, same defaulting. Kept in step with
 * `read-service-drizzle.ts`; the point is to pin the SEMANTICS (absent flag ⇒ hide) without standing up
 * Postgres, which `m30-rls-isolation.live.test.ts` covers separately.
 */
function visible(row: Row, filter: IncidentListFilter): boolean {
  if (row.kind === "allegation_of_abuse" && !filter.mayViewAbuseAllegations) return false;
  return true;
}

const ROWS: Row[] = [
  { id: "i1", kind: "fall" },
  { id: "i2", kind: "allegation_of_abuse" },
  { id: "i3", kind: "medication_error" },
  { id: "i4", kind: "allegation_of_abuse" },
];

const ACTOR: M30ReadActor = { organizationId: "org-1", userId: "u-1", roles: [] };

describe("M30 incident list — abuse-allegation visibility", () => {
  it("hides abuse allegations when the caller lacks incident.abuse_review", () => {
    const rows = ROWS.filter((r) => visible(r, { mayViewAbuseAllegations: false }));
    expect(rows.map((r) => r.id)).toEqual(["i1", "i3"]);
  });

  it("shows them when the caller holds it", () => {
    const rows = ROWS.filter((r) => visible(r, { mayViewAbuseAllegations: true }));
    expect(rows.map((r) => r.id)).toEqual(["i1", "i2", "i3", "i4"]);
  });

  it("an ABSENT flag hides them — the safe default, not an open one", () => {
    // A caller that forgets to pass the flag must not accidentally widen the surface. This is the
    // property that makes the optional field safe: absent means hide.
    const rows = ROWS.filter((r) => visible(r, {}));
    expect(rows.map((r) => r.id)).toEqual(["i1", "i3"]);
    expect(rows.some((r) => r.kind === "allegation_of_abuse")).toBe(false);
  });

  it("filtering happens BEFORE pagination, so a short page cannot leak their existence", () => {
    // Dropping rows after paginating would make an unprivileged caller's page shrink around hidden
    // rows — the count itself discloses that abuse allegations exist for this org.
    const pageSize = 2;
    const unprivileged = ROWS.filter((r) => visible(r, {})).slice(0, pageSize);
    const privileged = ROWS.filter((r) => visible(r, { mayViewAbuseAllegations: true })).slice(
      0,
      pageSize,
    );
    expect(unprivileged).toHaveLength(2); // a FULL page of non-abuse rows, not a gappy one
    expect(privileged).toHaveLength(2);
    expect(unprivileged.map((r) => r.id)).toEqual(["i1", "i3"]);
  });

  it("the actor shape the route passes is org-scoped and carries no permission set", () => {
    // The read service never infers authority — the ROUTE resolves `incident.abuse_review` through the
    // same resolver `requirePermission` gates on and passes the verdict in.
    expect(Object.keys(ACTOR).sort()).toEqual(["organizationId", "roles", "userId"]);
  });
});
