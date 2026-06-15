// @wardenx/audit — action catalog barrel (M4-T10; M4 spec §4.6). The typed, queryable taxonomy
// of every auditable action, consolidated from each owner module's slice, with the boot-time
// namespace/uniqueness validation (§4.6.7) and the `audit_action_catalog` UPSERT projection.
export type { ActionCatalogEntry, ModuleActionCatalog } from "./types";
export { SYSTEM_ACTION_CATALOG } from "./system";
export { M1_ACTION_CATALOG } from "./m1";
export { M2_ACTION_CATALOG } from "./m2";
export { M3_ACTION_CATALOG } from "./m3";
export { M4_ACTION_CATALOG } from "./m4";
export {
  type ActionCatalogViolation,
  type AuditActionCatalogRow,
  ACTION_CATALOG,
  actionCatalogRows,
  assertActionCatalogValid,
  isRegisteredAction,
  validateActionCatalog,
} from "./registry";
