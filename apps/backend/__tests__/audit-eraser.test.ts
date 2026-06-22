import { type EraseInput, createInMemoryEraserPorts } from "@wardenx/audit";
// apps/backend/__tests__/audit-eraser.test.ts — M4-T08 the `audit_event` data eraser.
//
// Proves M4 registers a REAL eraser for the `audit_event` data class over the Phase-0 deny-stub,
// and that the registered eraser honors §6 Part 2 lifetime retention + §10.6 legal-hold supremacy:
//   • the composition-root wireModuleErasers hook makes validateErasers() pass during a real
//     buildServer() boot (the deny-stub would otherwise have stood);
//   • a right-to-erasure refuses a live patient's Part 2 audit rows (W-M4-09) while erasing the
//     subject's ordinary rows — it never silently destroys protected SUD history.
import { beforeEach, describe, expect, it } from "vitest";
import { wireErasers } from "../src/bootstrap/erasers/providers";
import {
  __resetErasersForTest,
  getEraser,
  validateErasers,
} from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";
import {
  createInMemoryAuditEraserStore,
  registerAuditErasers,
} from "../src/modules/04-audit/index";

const ORG = "org_1";

function eraseInput(over: Partial<EraseInput>): EraseInput {
  return {
    retentionClass: "compliance",
    resourceKind: "audit_event",
    resourceId: "evt_1",
    organizationId: ORG,
    destructionCertificateId: "cert_1",
    ...over,
  };
}

describe("M4-T08 — the audit_event eraser registers over the deny-stub (right-to-erasure)", () => {
  beforeEach(() => __resetErasersForTest());

  it("erases the subject's ordinary rows but refuses a live patient's Part 2 rows (W-M4-09)", async () => {
    const store = createInMemoryAuditEraserStore({
      pt_alive: [
        eraseInput({ resourceId: "evt_a", retentionClass: "compliance" }),
        eraseInput({ resourceId: "evt_b", retentionClass: "operational" }),
        eraseInput({
          resourceId: "evt_sud",
          retentionClass: "compliance_42cfr_part2",
          patientId: "pt_alive",
        }),
      ],
    });
    const { ports } = createInMemoryEraserPorts({ patients: { pt_alive: { status: "active" } } });
    registerAuditErasers({ store, ports });

    const result = await getEraser("audit_event").erase({ orgId: ORG }, "pt_alive");

    // Only the two non-Part-2 rows are erased; the protected SUD row is refused, not counted.
    expect(result).toEqual({ erased: 2 });
  });

  it("makes validateErasers() pass during a real buildServer() boot (no deny-stub left standing)", () => {
    wireErasers(); // deny-stub every required class first…
    // …then the registered audit_event eraser must stand over its stub (no NotImplemented throw).
    expect(() =>
      buildServer({
        registerModuleSeams: wireModuleSeams,
        registerModuleErasers: wireModuleErasers,
      }),
    ).not.toThrow();
    expect(() => validateErasers()).not.toThrow();
  });
});
