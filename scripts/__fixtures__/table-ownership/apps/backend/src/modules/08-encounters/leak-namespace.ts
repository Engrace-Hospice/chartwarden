// FIXTURE — intentional violation: M8 reaches into M12's schema directly via the `schema.<table>`
// namespace-binding style (the ~280-file `import { schema } from "@wardenx/db"` convention), NOT the
// named-import style `leak.ts` already covers. Proves check-table-ownership.ts recognizes this style
// regardless of the import specifier's own spelling (TASK-014/ARCH-017) — the old detector required
// the specifier itself to contain the substring "schema", which a bare `from "@wardenx/db"` never does.
import { schema } from "@wardenx/db";
export const leakViaNamespace = schema.medicationOrder;
