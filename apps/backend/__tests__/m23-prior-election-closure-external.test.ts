// A readmission's NOE waits for the prior election's NOTR (or final claim) to be FILED (CMS ch. 11 §20.1.6). For a tenant that bills
// outside ChartWarden (owner decision D4) the NOTR is filed by the tenant and never leaves draft / ready here, so a NOTR the tenant
// recorded as filed (`external_filing_status = 'filed'`) must count, or such a tenant's readmission NOE would be refused forever.
// No database: the query's WHERE is captured and rendered to SQL; the rows are proven live in `test:m6:readmission:live`.
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { priorElectionClosureTx } from "../src/modules/23-billing-medicare/services/prior-election-closure";

describe("priorElectionClosureTx", () => {
  it("counts a NOTR the tenant recorded as filed outside ChartWarden, besides the states that left our hands", async () => {
    const dialect = new PgDialect();
    const wheres: string[] = [];
    const chain = {
      from: () => chain,
      where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        wheres.push(dialect.sqlToQuery(condition).sql);
        return chain;
      },
      limit: async () => [],
    };

    const closure = await priorElectionClosureTx({ select: () => chain } as never, {
      admissionId: "11111111-1111-4111-8111-111111111111",
      patientId: "22222222-2222-4222-8222-222222222222",
    });

    expect(closure).toEqual({ notrFiled: false, finalClaimFiled: false });
    const notrWhere = wheres[0] ?? "";
    expect(notrWhere).toMatch(/"notr_record"."state" in \(/i);
    expect(notrWhere).toMatch(/"notr_record"."external_filing_status" = /i);
  });
});
