-- Fixture for check-org-index-coverage.ts (GAP-089). Outside every real gate's scan set.
--
-- Two org-scoped tables. `fixture_covered_note` is indexed the way every table must be. The
-- violation is `fixture_uncovered_note`: organization_id IS in an index — third key of
-- `(patient_id, created_at, organization_id)` — but a btree can only seek on a prefix, so the RLS
-- predicate `organization_id = current_setting('app.org_id')::uuid` prunes nothing there. That is
-- exactly the case a "mentions organization_id anywhere" rule would wave through.

CREATE TABLE "fixture_covered_note" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "fixture_covered_note_org_ix" ON "fixture_covered_note" ("organization_id", "created_at");

CREATE TABLE "fixture_uncovered_note" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "fixture_uncovered_note_ix" ON "fixture_uncovered_note" ("patient_id", "created_at", "organization_id");
