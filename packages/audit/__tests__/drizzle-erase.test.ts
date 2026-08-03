/**
 * M4 §6/§10.5 — the production `performErasure` executor (lifecycle/drizzle-erase).
 *
 * `audit_event` is HELPER-ONLY and `wardenx_app` holds no DELETE grant (migration 0001), so the
 * destruction adapter lives in this package over an INJECTED destruction-granted client. With no
 * live Postgres in unit scope we drive it with a fake Drizzle db (the tenancy/context.test.ts +
 * death-discharge-reader.test.ts pattern): `transaction → tx` records set_config executes and
 * captures the DELETE's WHERE fragment, which we render through the real PgDialect to assert:
 *   - the executor opens its OWN withOrgContext envelope (org + user GUCs set in-transaction),
 *   - the DELETE targets the partitioned PARENT `audit_event`,
 *   - the WHERE carries the EXPLICIT org predicate (second wall — the destruction role may not be
 *     subject to tenant RLS), the resource_kind/resource_id group predicates incl. the
 *     `resource_id IS NULL AND id = ?` fallback (the store's `resourceId ?? r.id` grouping), and
 *     the text-cast retention-class pin (a different class under the same resource must survive),
 *   - every scoping value is a BOUND PARAMETER, never interpolated,
 *   - the returned count is the `.returning()` length — rows ACTUALLY destroyed, not the ask.
 */
import type { DbClient } from "@wardenx/db";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { EraseInput } from "../src/lifecycle/eraser";
import { createDbAuditEraseExecutor } from "../src/lifecycle/drizzle-erase";

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

const ORG = "11111111-1111-4111-8111-111111111111";
const RES = "22222222-2222-4222-8222-222222222222";

function eraseInput(over: Partial<EraseInput> = {}): EraseInput {
  return {
    retentionClass: "compliance",
    resourceKind: "patient",
    resourceId: RES,
    organizationId: ORG,
    destructionCertificateId: "cert_1",
    ...over,
  };
}

/** Captures the org envelope + the DELETE target/predicate; resolves `.returning()` with `rows`. */
function makeFakeDb(rows: readonly { id: string }[]) {
  const probe = {
    transactionOpened: false,
    setConfigCalls: [] as SQL[],
    deletedTable: undefined as unknown,
    where: undefined as SQL | undefined,
  };
  const tx = {
    async execute(query: SQL) {
      probe.setConfigCalls.push(query);
      return undefined;
    },
    delete(table: unknown) {
      probe.deletedTable = table;
      return {
        where(predicate: SQL) {
          probe.where = predicate;
          return {
            returning() {
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
  };
  const db = {
    async transaction<R>(fn: (t: typeof tx) => Promise<R>): Promise<R> {
      probe.transactionOpened = true;
      return fn(tx);
    },
  };
  return { db: db as unknown as DbClient, probe };
}

describe("createDbAuditEraseExecutor (M4 §6 destruction leg)", () => {
  it("deletes the vetted row-group via the partitioned parent inside its own org envelope", async () => {
    const { db, probe } = makeFakeDb([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const count = await createDbAuditEraseExecutor(db).performErasure(eraseInput());

    // Rows ACTUALLY destroyed (.returning() length), not the requested group size.
    expect(count).toBe(3);

    // Its own withOrgContext envelope: transaction + both GUCs as bound params.
    expect(probe.transactionOpened).toBe(true);
    const gucs = probe.setConfigCalls.map(render);
    expect(gucs[0]?.sql).toContain("set_config('app.org_id'");
    expect(gucs[0]?.params).toEqual([ORG]);
    expect(gucs[1]?.sql).toContain("set_config('app.user_id'");

    // The DELETE targets the partitioned PARENT (Postgres routes to every leaf).
    const table = probe.deletedTable as { [k: symbol]: unknown };
    expect(String(Reflect.get(table, Symbol.for("drizzle:Name")))).toBe("audit_event");

    // The WHERE: explicit org second wall + exact group predicates, all values bound.
    expect(probe.where).toBeDefined();
    const q = render(probe.where as SQL);
    expect(q.sql).toContain('"organization_id" = ');
    expect(q.sql).toContain('"resource_kind" = ');
    expect(q.sql).toContain('"resource_id" = ');
    // The store's `resourceId ?? r.id` fallback: a resource-id-less row matches on its event id.
    expect(q.sql).toContain('"resource_id" is null');
    expect(q.sql).toContain('"id" = ');
    // Text-cast retention pin (compliance_42cfr_part2 is type-only until the enum widens).
    expect(q.sql).toContain('"retention_class"::text = ');
    expect(q.params).toEqual([ORG, "patient", RES, RES, "compliance"]);
    // No interpolated scoping values anywhere in the rendered predicate.
    expect(q.sql).not.toContain(ORG);
    expect(q.sql).not.toContain(RES);
  });

  it("pins the DELETE to the group's retention class so sibling-class rows survive", async () => {
    const { db, probe } = makeFakeDb([{ id: "a" }]);
    const count = await createDbAuditEraseExecutor(db).performErasure(
      eraseInput({ retentionClass: "compliance_42cfr_part2" }),
    );
    expect(count).toBe(1);
    const q = render(probe.where as SQL);
    expect(q.params).toContain("compliance_42cfr_part2");
  });

  it("reports 0 when nothing matched — never the requested group size", async () => {
    const { db } = makeFakeDb([]);
    await expect(createDbAuditEraseExecutor(db).performErasure(eraseInput())).resolves.toBe(0);
  });
});
