// @wardenx/cost-report — M27 deterministic cost-allocation barrel (Form CMS-1984-14, D8). The hospice cost
// chain is short: Worksheet A (+ A-1…A-4 direct LOC costs) → Worksheet B step-down on the Worksheet B-1
// statistical basis (`step-down`) → Worksheet C per-diem cost by level of care (`per-diem`). `assemble-inputs`
// shapes the read worksheet/statistics state into the chain inputs; `to-worksheets` maps the results back to
// the derived-worksheet `data` jsonb. There is NO ancillary RCC, program-apportionment, or settlement
// worksheet on the hospice form (see audit/M27_CMS_LINE_GEOMETRY_CERTIFICATION.md). Every export is a type or a
// deterministic total function; money is INTEGER CENTS. PURE DOMAIN — no Fastify/Drizzle/BullMQ/getSeam; no PHI.
export * from "./step-down";
export * from "./per-diem";
export * from "./assemble-inputs";
export * from "./to-worksheets";
