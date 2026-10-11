/**
 * M4-T10 — the action catalog (M4 spec §4.6, §4.6.7). The typed, queryable action taxonomy
 * consolidated from every owner module's slice, the D9 namespace/uniqueness boot validation, and
 * the `audit_action_catalog` UPSERT projection.
 *
 * Accept (M4-T10): the consolidated catalog validates clean (every owner matches its action's
 * implied namespace; no duplicate actions); the §11.1 audit-of-audit system events are present;
 * the boot gate fails closed on a wrong-namespace or duplicate entry; and the catalog projects
 * one DB-mirror row per action.
 */
import { describe, expect, it } from "vitest";
import {
  ACTION_CATALOG,
  type ActionCatalogEntry,
  actionCatalogRows,
  assertActionCatalogValid,
  isRegisteredAction,
  validateActionCatalog,
} from "../src/actions";

describe("M4-T10 action catalog — consolidation + validity (§4.6)", () => {
  it("validates clean: every owner matches its action's namespace, no duplicates (§4.6.7)", () => {
    expect(validateActionCatalog()).toEqual([]);
    expect(() => assertActionCatalogValid()).not.toThrow();
  });

  it("uses unique action names (PK-safe for audit_action_catalog)", () => {
    const actions = ACTION_CATALOG.map((e) => e.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("registers the §11.1 audit-of-audit system events under m0", () => {
    const system = ACTION_CATALOG.filter((e) => e.moduleOwner === "m0").map((e) => e.action);
    for (const a of [
      "audit.elevated_access",
      "disclosure.accounting_generated",
      "data.legal_hold_applied",
      "data.legal_hold_released",
      "data.destruction_certified",
      "audit.destruction_refused_part_two",
      "audit.integrity_mismatch",
      "audit.export_generated",
    ]) {
      expect(system).toContain(a);
    }
  });

  it("mN-prefixed actions are owned by their matching module (D9)", () => {
    for (const e of ACTION_CATALOG) {
      const m = /^(m\d+)\./.exec(e.action);
      if (m) expect(e.moduleOwner).toBe(m[1]);
    }
  });

  it("isRegisteredAction reflects catalog membership (§4.6.7 #3 helper)", () => {
    expect(isRegisteredAction("m3.role.created")).toBe(true);
    expect(isRegisteredAction("audit.elevated_access")).toBe(true);
    expect(isRegisteredAction("m99.bogus.action")).toBe(false);
  });

  it("registers the MBI-disclosure action as compliance and a registered (boot-validated) entry", () => {
    expect(isRegisteredAction("patient_payer.mbi_disclosed")).toBe(true);
    const row = actionCatalogRows().find((r) => r.action === "patient_payer.mbi_disclosed");
    expect(row?.defaultRetentionClass).toBe("compliance");
    expect(validateActionCatalog()).toEqual([]);
  });
});

describe("M4-T10 action catalog — boot gate fails closed (§4.6.7 #1/#2)", () => {
  const base: ActionCatalogEntry = {
    action: "m4.x.y",
    moduleOwner: "m4",
    defaultRetentionClass: "compliance",
    description: "",
    denylistCategories: [],
    isPartTwoEligible: false,
  };

  it("rejects an mN action owned by the wrong module (§4.6.7 #2)", () => {
    const bad = [{ ...base, action: "m6.foo.bar", moduleOwner: "m11" }];
    const v = validateActionCatalog(bad);
    expect(v).toHaveLength(1);
    expect(v[0].type).toBe("wrong_namespace");
    expect(() => assertActionCatalogValid(bad)).toThrow(/m6\.foo\.bar/);
  });

  it("requires un-prefixed system actions to be owned by m0", () => {
    const bad = [{ ...base, action: "data.something", moduleOwner: "m4" }];
    expect(validateActionCatalog(bad)).toHaveLength(1);
  });

  it("allows a sud.* action owned by any concrete module, rejects an m0-owned one", () => {
    expect(validateActionCatalog([{ ...base, action: "sud.unredact.request", moduleOwner: "m29" }])).toEqual([]);
    expect(
      validateActionCatalog([{ ...base, action: "sud.unredact.request", moduleOwner: "m0" }]),
    ).toHaveLength(1);
  });

  it("flags a duplicate action name", () => {
    const dup = [base, { ...base }];
    const v = validateActionCatalog(dup);
    expect(v.some((x) => x.type === "duplicate")).toBe(true);
  });
});

describe("M4-T10 action catalog — DB mirror projection (§4.6.7)", () => {
  it("projects one row per catalog action, fields preserved", () => {
    const rows = actionCatalogRows();
    expect(rows.map((r) => r.action).sort()).toEqual(ACTION_CATALOG.map((e) => e.action).sort());
    for (const row of rows) {
      const entry = ACTION_CATALOG.find((e) => e.action === row.action)!;
      expect(row.moduleOwner).toBe(entry.moduleOwner);
      expect(row.defaultRetentionClass).toBe(entry.defaultRetentionClass);
      expect(row.isPartTwoEligible).toBe(entry.isPartTwoEligible);
    }
  });
});
