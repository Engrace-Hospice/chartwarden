import { describe, expect, it } from "vitest";
import { createdTablesIn } from "../status-matrix-heuristics";

describe("status-matrix migration heuristic", () => {
  it("reads literal CREATE TABLE and skips partition children and reserved captures", () => {
    const sql = `CREATE TABLE "a" (id int); CREATE TABLE IF NOT EXISTS b (id int);
      CREATE TABLE a_2026 PARTITION OF a FOR VALUES FROM (1) TO (2);`;
    expect(createdTablesIn(sql).sort()).toEqual(["a", "b"]);
  });

  it("reads a family of tables created by a FOREACH ... format('CREATE TABLE ...') loop", () => {
    const sql = `DO $$ DECLARE s text; t text; BEGIN
      FOREACH s IN ARRAY ARRAY['ndc','cvx'] LOOP
        t := 'concept_' || s;
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (code text)', t);
      END LOOP; END $$;`;
    expect(createdTablesIn(sql).sort()).toEqual(["concept_cvx", "concept_ndc"]);
  });

  it("does not treat a looped non-CREATE statement as a table creation", () => {
    const sql = `FOREACH s IN ARRAY ARRAY['x'] LOOP t := 'p_' || s; EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); END LOOP;`;
    expect(createdTablesIn(sql)).toEqual([]);
  });
});
