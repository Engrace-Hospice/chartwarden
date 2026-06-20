// @wardenx/audit — the consolidated action catalog + boot validation (M4-T10; M4 spec §4.6, §4.6.7).
//
// The single registry M4 loads at boot: every owner module's slice concatenated, the
// `ACTION_CATALOG` constant the Compliance reporting surface and the boot-time UPSERT into
// `audit_action_catalog` consume. M4 enforces D9 module-ownership of action names here (§4.6.7).
import { M1_ACTION_CATALOG } from "./m1";
import { M2_ACTION_CATALOG } from "./m2";
import { M3_ACTION_CATALOG } from "./m3";
import { M4_ACTION_CATALOG } from "./m4";
import { M36_ACTION_CATALOG } from "./m36";
import { M38_ACTION_CATALOG } from "./m38";
import { M40_ACTION_CATALOG } from "./m40";
import { SYSTEM_ACTION_CATALOG } from "./system";
import type { ActionCatalogEntry, ModuleActionCatalog } from "./types";

/**
 * The full action catalog consolidated from every owner module's slice (§4.6). Append a new
 * module's `MN_ACTION_CATALOG` here as it lands — the same one-file-per-module shape §4.6.1
 * prescribes (system/m0 first, then ascending module order).
 */
export const ACTION_CATALOG: ModuleActionCatalog = [
  ...SYSTEM_ACTION_CATALOG,
  ...M1_ACTION_CATALOG,
  ...M2_ACTION_CATALOG,
  ...M3_ACTION_CATALOG,
  ...M4_ACTION_CATALOG,
  ...M36_ACTION_CATALOG,
  ...M38_ACTION_CATALOG,
  ...M40_ACTION_CATALOG,
];

/** A single namespacing/uniqueness violation surfaced by `validateActionCatalog()` (§4.6.7). */
export interface ActionCatalogViolation {
  readonly action: string;
  /** `wrong_namespace`: owner ≠ the prefix implied by the action; `duplicate`: action declared twice. */
  readonly type: "wrong_namespace" | "duplicate";
  readonly detail: string;
}

const MODULE_PREFIX = /^(m\d+)\./; // mN.<resource>.<verb>
const SUD_PREFIX = /^sud\./; // reserved cross-module SUD namespace (D9)
const MODULE_OWNER = /^m\d+$/; // a concrete owner id, e.g. m29

/**
 * The owner a `moduleOwner` must equal for a given action name, per the D9 rules (§4.6.7 #1):
 *   • `mN.*`        → `mN`
 *   • un-prefixed   → `m0` (system `audit.*` / `data.*` / `disclosure.*`)
 *   • `sud.*`       → any concrete `mN` (the registering module) — owner-agnostic
 * Returns `null` when any concrete `mN` owner is acceptable (the `sud.*` case).
 */
function expectedOwner(action: string): string | null {
  const m = MODULE_PREFIX.exec(action);
  if (m) return m[1]!;
  if (SUD_PREFIX.test(action)) return null;
  return "m0";
}

/**
 * Validate the catalog's namespacing + uniqueness (§4.6.7 #1/#2). Returns every violation (empty
 * ⇒ valid). A pure check over the in-memory catalog — no DB. `assertActionCatalogValid()` wraps it
 * for the boot gate, which fails closed on any violation.
 */
export function validateActionCatalog(
  catalog: ModuleActionCatalog = ACTION_CATALOG,
): ActionCatalogViolation[] {
  const violations: ActionCatalogViolation[] = [];
  const seen = new Set<string>();
  for (const entry of catalog) {
    if (seen.has(entry.action)) {
      violations.push({
        action: entry.action,
        type: "duplicate",
        detail: `action '${entry.action}' is declared more than once`,
      });
    }
    seen.add(entry.action);

    const want = expectedOwner(entry.action);
    if (want === null) {
      // sud.* — any concrete module (m1..mN) owner is acceptable, but NOT the system owner m0.
      if (!MODULE_OWNER.test(entry.moduleOwner) || entry.moduleOwner === "m0") {
        violations.push({
          action: entry.action,
          type: "wrong_namespace",
          detail: `sud.* action '${entry.action}' must be owned by a concrete module (mN), got '${entry.moduleOwner}'`,
        });
      }
    } else if (entry.moduleOwner !== want) {
      violations.push({
        action: entry.action,
        type: "wrong_namespace",
        detail: `action '${entry.action}' implies owner '${want}' but is registered to '${entry.moduleOwner}'`,
      });
    }
  }
  return violations;
}

/**
 * The boot gate (§4.6.7 #1/#2): throw if the consolidated catalog has any namespacing or
 * uniqueness violation. M4 calls this at startup before the catalog is UPSERTed into
 * `audit_action_catalog`; a violation is a registration bug, so boot fails closed.
 */
export function assertActionCatalogValid(catalog: ModuleActionCatalog = ACTION_CATALOG): void {
  const violations = validateActionCatalog(catalog);
  if (violations.length > 0) {
    const lines = violations.map((v) => `  • [${v.type}] ${v.detail}`).join("\n");
    throw new Error(
      `audit action catalog invalid (${violations.length} violation(s)) — M4 boot refuses to start:\n${lines}`,
    );
  }
}

/** True when `action` is a registered catalog action (§4.6.7 #3 runtime validation helper). */
export function isRegisteredAction(
  action: string,
  catalog: ModuleActionCatalog = ACTION_CATALOG,
): boolean {
  return catalog.some((e) => e.action === action);
}

/** A row of the `audit_action_catalog` UPSERT (mirrors the Drizzle table columns). */
export interface AuditActionCatalogRow {
  action: string;
  moduleOwner: string;
  defaultRetentionClass: ActionCatalogEntry["defaultRetentionClass"];
  description: string;
  denylistCategories: readonly ActionCatalogEntry["denylistCategories"][number][];
  isPartTwoEligible: boolean;
}

/**
 * Project the catalog into the rows the M4 boot/migration UPSERTs (on `action`) into
 * `audit_action_catalog` (§4.6.7). Same source-of-truth-is-code → DB-mirror contract as the
 * permission catalog: the table is regenerated from the catalog, never hand-edited.
 */
export function actionCatalogRows(
  catalog: ModuleActionCatalog = ACTION_CATALOG,
): AuditActionCatalogRow[] {
  return catalog.map((e) => ({
    action: e.action,
    moduleOwner: e.moduleOwner,
    defaultRetentionClass: e.defaultRetentionClass,
    description: e.description,
    denylistCategories: [...e.denylistCategories],
    isPartTwoEligible: e.isPartTwoEligible,
  }));
}
