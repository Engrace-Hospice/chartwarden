// @wardenx/messaging — M36-T05 alert-payload catalog boot-validation tests (spec §3.11–3.12).
//
// The Foundation Registry mirrors M1's outbox-event catalog: a per-module CONTRIBUTION is
// aggregated, namespace-/shape-validated, and projected to `alert_payload_catalog` rows at boot.
// Because M36 is foundation-tier (M36-F01) it imports NO producer module, so these tests drive the
// aggregator + boot gate with SYNTHETIC contributions (exactly as the outbox collision test does).
import { Type } from "@sinclair/typebox";
import type { AlertPayloadEntry, ModuleAlertContribution } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  AlertPayloadCollisionError,
  alertPayloadCatalogRows,
  assertAlertPayloadCatalogValid,
  buildAlertPayloadCatalog,
  createAlertPayloadRegistry,
  isRegisteredPayloadType,
  validateAlertPayloadCatalog,
} from "../src/index";

const entry = (over: Partial<AlertPayloadEntry> & Pick<AlertPayloadEntry, "payloadType">): AlertPayloadEntry => ({
  moduleOwner: (/^(m\d+)\./.exec(over.payloadType)?.[1] ?? "m11") as AlertPayloadEntry["moduleOwner"],
  severity: "HIGH",
  defaultChannels: ["socket_push", "inbox"],
  defaultRecipientResolver: "ordering_provider",
  payloadSchema: Type.Object({ orderId: Type.String() }),
  requiresResponseTracking: false,
  description: "synthetic test payload",
  ...over,
});

const M11: ModuleAlertContribution = [
  entry({ payloadType: "m11.lab_results.critical", severity: "CRITICAL" }),
  entry({ payloadType: "m11.lab_results.overdue", severity: "MEDIUM" }),
];
const M22: ModuleAlertContribution = [
  entry({ payloadType: "m22.document.rendered_critical_results", moduleOwner: "m22", severity: "CRITICAL" }),
];

describe("M36-T05 alert payload catalog — aggregation (§3.12)", () => {
  it("aggregates contributions into a payloadType→entry map", () => {
    const map = buildAlertPayloadCatalog([M11, M22]);
    expect(map.size).toBe(3);
    expect(map.get("m11.lab_results.critical")?.severity).toBe("CRITICAL");
    expect(map.get("m22.document.rendered_critical_results")?.moduleOwner).toBe("m22");
  });

  it("throws AlertPayloadCollisionError when two modules claim the same payload type", () => {
    const dupe: ModuleAlertContribution = [entry({ payloadType: "m11.lab_results.critical" })];
    expect(() => buildAlertPayloadCatalog([M11, dupe])).toThrow(AlertPayloadCollisionError);
  });

  it("projects to alert_payload_catalog rows (clone of channels; schema carried through)", () => {
    const rows = alertPayloadCatalogRows([M22]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      payloadType: "m22.document.rendered_critical_results",
      moduleOwner: "m22",
      severity: "CRITICAL",
      defaultChannels: ["socket_push", "inbox"],
      requiresResponseTracking: false,
    });
    // channels are cloned, not the same reference (the DB-mirror contract)
    expect(rows[0]!.defaultChannels).not.toBe(M22[0]!.defaultChannels);
  });
});

describe("M36-T05 alert payload catalog — boot gate (§3.12)", () => {
  it("a well-formed catalog has no violations and assertValid passes", () => {
    expect(validateAlertPayloadCatalog([M11, M22])).toEqual([]);
    expect(() => assertAlertPayloadCatalogValid([M11, M22])).not.toThrow();
  });

  it("rejects a payload type whose owner ≠ its mN. prefix", () => {
    const bad: ModuleAlertContribution = [entry({ payloadType: "m11.foo.bar", moduleOwner: "m22" })];
    const v = validateAlertPayloadCatalog([bad]);
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("wrong_namespace");
    expect(() => assertAlertPayloadCatalogValid([bad])).toThrow(/refuses to start/);
  });

  it("rejects a payload type that does not follow mN.<resource>.<verb>", () => {
    const bad: ModuleAlertContribution = [entry({ payloadType: "lab_results.critical", moduleOwner: "m11" })];
    expect(validateAlertPayloadCatalog([bad])[0]!.type).toBe("wrong_namespace");
  });

  it("rejects an unknown severity, empty channels, and empty resolver", () => {
    const bad: ModuleAlertContribution = [
      entry({ payloadType: "m11.a.b", severity: "URGENT" as AlertPayloadEntry["severity"] }),
      entry({ payloadType: "m11.c.d", defaultChannels: [] }),
      entry({ payloadType: "m11.e.f", defaultRecipientResolver: "" }),
    ];
    const types = validateAlertPayloadCatalog([bad]).map((x) => x.type);
    expect(types).toContain("bad_severity");
    expect(types).toContain("empty_channels");
    expect(types).toContain("empty_resolver");
  });

  it("flags a duplicate payload type within the validate pass", () => {
    const dupe: ModuleAlertContribution = [entry({ payloadType: "m11.x.y" }), entry({ payloadType: "m11.x.y" })];
    // collision throws first at build; the registry catches it via assertValid → throws
    expect(() => assertAlertPayloadCatalogValid([dupe])).toThrow(AlertPayloadCollisionError);
  });
});

describe("M36-T05 Foundation Registry — runtime registration without import edge (M36-F01)", () => {
  it("later modules register their contribution; M36 validates whatever was registered", () => {
    const registry = createAlertPayloadRegistry();
    expect(registry.contributions()).toEqual([]); // M36 owns no payloads itself
    registry.register(M11);
    registry.register(M22);
    expect(() => registry.assertValid()).not.toThrow();
    expect(registry.build().size).toBe(3);
    expect(registry.rows()).toHaveLength(3);
    expect(registry.has("m11.lab_results.critical")).toBe(true);
    expect(registry.has("m99.nope.nope")).toBe(false);
    expect(isRegisteredPayloadType("m22.document.rendered_critical_results", registry.contributions())).toBe(true);
  });

  it("each registry is isolated (a fresh registry per boot/test)", () => {
    const a = createAlertPayloadRegistry();
    a.register(M11);
    const b = createAlertPayloadRegistry();
    expect(b.contributions()).toEqual([]);
  });

  it("registering a colliding contribution surfaces at assertValid", () => {
    const registry = createAlertPayloadRegistry();
    registry.register(M11);
    registry.register([entry({ payloadType: "m11.lab_results.critical" })]);
    expect(() => registry.assertValid()).toThrow(AlertPayloadCollisionError);
  });
});
