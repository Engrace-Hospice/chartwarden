// M39-T10 — the §8.1 Consent audit actions land in the action catalog under the D9 `m39.*` namespace.
//
// Accept: the eight app-level §8.1 actions are present, all owned by `m39` (the spec listed some bare
// `consent.*`; namespaced here so the owner-prefix invariant holds), carry no PHI denylist (bodies are
// structural ids + hashed reasons), the consent-decision + post-death events are Part 2 eligible, and
// the consolidated catalog still validates.
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, M39_ACTION_CATALOG, validateActionCatalog } from "../src/actions";

describe("M39-T10 action catalog (§8.1)", () => {
  it("declares the eight §8.1 consent actions under m39", () => {
    expect(M39_ACTION_CATALOG.map((e) => e.action)).toEqual([
      "m39.consent.eval_denied",
      "m39.consent.eval_audit_read",
      "m39.consent.supersession_chain_extended",
      "m39.consent.cascade_handler_failed",
      "m39.consent.tenant_overlay_published",
      "m39.consent.tenant_overlay_rejected_loosens_floor",
      "m39.consent.post_mortem_termination",
      "m39.consent.ai_block_validator_failed",
    ]);
  });

  it("every m39 action is owned by m39 with no raw-PHI denylist", () => {
    for (const e of M39_ACTION_CATALOG) {
      expect(e.moduleOwner).toBe("m39");
      expect(e.action.startsWith("m39.")).toBe(true);
      expect(e.denylistCategories).toEqual([]);
    }
  });

  it("the consent-decision + post-death events are Part 2 eligible", () => {
    const byAction = new Map(M39_ACTION_CATALOG.map((e) => [e.action, e]));
    expect(byAction.get("m39.consent.eval_denied")!.isPartTwoEligible).toBe(true);
    expect(byAction.get("m39.consent.post_mortem_termination")!.isPartTwoEligible).toBe(true);
    expect(byAction.get("m39.consent.tenant_overlay_published")!.isPartTwoEligible).toBe(false);
  });

  it("keeps the consolidated catalog valid after M39 is merged in", () => {
    expect(validateActionCatalog()).toEqual([]);
    expect(ACTION_CATALOG.map((e) => e.action)).toContain("m39.consent.eval_denied");
  });
});
