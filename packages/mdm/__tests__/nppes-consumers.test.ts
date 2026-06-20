// @wardenx/mdm — M40-T09 M29 NPPES-sync consumer logic (§4.7, §7.11–7.12).
//
// The §7.11 path: an `m29.nppes.provider_synced` with `changedFields: ['lastName']` applies ONLY
// the surname (minimum-update), stamps `nppesProvenance`, and emits `m40.canonical_updated`. Also
// locks D10 (no canonical → skip, never auto-create), idempotent no-op re-delivery, and the §4.7.2
// deactivation outcomes. Pure decisions + port-bound handlers; the backend registration is a
// Phase-1 deny-stub (M29 is Wave H).
import { describe, expect, it } from "vitest";
import {
  decideProviderDeactivated,
  decideProviderSynced,
  handleProviderDeactivated,
  handleProviderSynced,
  type M29ProviderSyncedPayload,
  type NppesCanonicalPhysician,
  type NppesConsumerPorts,
} from "../src/index";

const CANON: NppesCanonicalPhysician = {
  id: "c-1",
  npi: "1234567893",
  status: "active",
  firstName: "Jane",
  lastName: "OLD_NAME",
  credentials: "MD",
  specialtyTaxonomy: "207Q00000X",
};

function syncedPayload(over: Partial<M29ProviderSyncedPayload> = {}): M29ProviderSyncedPayload {
  return {
    npi: "1234567893",
    action: "updated",
    changedFields: ["lastName"],
    syncedAt: "2026-06-19T02:30:00Z",
    syncRunId: "run-1",
    provider: {
      firstName: "Jane",
      lastName: "NEW_NAME",
      credentials: "MD",
      specialtyTaxonomy: "207Q00000X",
    },
    ...over,
  };
}

/** Capturing ports for the handler tests. */
function makePorts(canonical: NppesCanonicalPhysician | null, alertOrgs: string[] = []) {
  const updates: Array<[string, Record<string, unknown>]> = [];
  const events: Array<{ id: string; changedFields: readonly string[] }> = [];
  const deactivated: string[] = [];
  const alerts: Array<[string, string]> = [];
  const audits: string[] = [];
  const ports: NppesConsumerPorts = {
    findCanonicalByNpi: async () => canonical,
    applyCanonicalUpdate: async (id, u) => void updates.push([id, u as Record<string, unknown>]),
    applyDeactivation: async (id) => void deactivated.push(id),
    emitCanonicalUpdated: async (e) => void events.push({ id: e.id, changedFields: e.changedFields }),
    tenantsToAlert: async () => alertOrgs,
    emitDeactivationAlert: async (orgId, id) => void alerts.push([orgId, id]),
    writeDeactivationObservedAudit: async (npi) => void audits.push(npi),
  };
  return { ports, updates, events, deactivated, alerts, audits };
}

describe("decideProviderSynced (§4.7.1, §7.11)", () => {
  it("applies ONLY the changed surname (minimum-update) and stamps provenance", () => {
    const d = decideProviderSynced(syncedPayload(), CANON);
    expect(d.outcome).toBe("updated_canonical");
    expect(d.appliedChanges).toEqual(["lastName"]);
    expect(d.updates.lastName).toBe("NEW_NAME");
    expect(d.updates.firstName).toBeUndefined(); // not flagged changed → not written
    expect(d.updates.nppesProvenance).toEqual({
      lastSyncedAt: "2026-06-19T02:30:00Z",
      lastSyncSource: "m29_platform_sync",
      lastSyncRunId: "run-1",
      lastChangedFields: ["lastName"],
    });
  });

  it("D10: a stand-alone sync with no canonical does NOT auto-create → no_canonical_skipped", () => {
    const d = decideProviderSynced(syncedPayload(), null);
    expect(d.outcome).toBe("no_canonical_skipped");
    expect(d.appliedChanges).toEqual([]);
  });

  it("a flagged field whose value is unchanged → no_op (idempotent re-delivery)", () => {
    const d = decideProviderSynced(
      syncedPayload({ provider: { ...syncedPayload().provider, lastName: "OLD_NAME" } }),
      CANON,
    );
    expect(d.outcome).toBe("no_op");
  });

  it("a field changed at NPPES but NOT in changedFields is ignored (trusts M29's diff)", () => {
    const d = decideProviderSynced(
      syncedPayload({ changedFields: ["lastName"], provider: { firstName: "DIFFERENT", lastName: "NEW_NAME", credentials: "MD", specialtyTaxonomy: "207Q00000X" } }),
      CANON,
    );
    expect(d.appliedChanges).toEqual(["lastName"]); // firstName not applied
  });
});

describe("handleProviderSynced over ports (§7.11)", () => {
  it("writes the canonical patch and emits m40.canonical_updated with the changed fields", async () => {
    const { ports, updates, events } = makePorts(CANON);
    const d = await handleProviderSynced(syncedPayload(), ports);
    expect(d.outcome).toBe("updated_canonical");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[0]).toBe("c-1");
    expect(events).toEqual([{ id: "c-1", changedFields: ["lastName"] }]);
  });

  it("no canonical → no write, no event (D10)", async () => {
    const { ports, updates, events } = makePorts(null);
    const d = await handleProviderSynced(syncedPayload(), ports);
    expect(d.outcome).toBe("no_canonical_skipped");
    expect(updates).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("provider_deactivated (§4.7.2)", () => {
  it("active canonical → deactivated, alerts affected tenants", async () => {
    const { ports, deactivated, alerts } = makePorts(CANON, ["org_a", "org_b"]);
    const outcome = await handleProviderDeactivated(
      { npi: "1234567893", deactivationDate: "2026-06-18", deactivationReason: "DECEASED", detectedAt: "2026-06-19" },
      ports,
    );
    expect(outcome).toBe("deactivated_canonical");
    expect(deactivated).toEqual(["c-1"]);
    expect(alerts).toEqual([["org_a", "c-1"], ["org_b", "c-1"]]);
  });

  it("no canonical → observe-only audit, no deactivation", async () => {
    const { ports, deactivated, audits } = makePorts(null);
    const outcome = await handleProviderDeactivated(
      { npi: "9999999999", deactivationDate: "2026-06-18", deactivationReason: "DECEASED", detectedAt: "2026-06-19" },
      ports,
    );
    expect(outcome).toBe("no_canonical_observed");
    expect(deactivated).toEqual([]);
    expect(audits).toEqual(["9999999999"]);
  });

  it("already deactivated → idempotent no-op", () => {
    expect(decideProviderDeactivated({ ...CANON, status: "deactivated" })).toBe("already_deactivated");
  });
});
