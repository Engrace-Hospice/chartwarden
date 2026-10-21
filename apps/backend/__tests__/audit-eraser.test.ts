import { type EraseInput, createInMemoryEraserPorts } from "@chartwarden/audit";
// apps/backend/__tests__/audit-eraser.test.ts — M4-T08 the `audit_event` data eraser.
//
// Proves M4 registers a REAL eraser for the `audit_event` data class over the Phase-0 deny-stub,
// and that the registered eraser honors §6 Part 2 lifetime retention + §10.6 legal-hold supremacy:
//   • the composition-root wireModuleErasers hook makes validateErasers() pass during a real
//     buildServer() boot (the deny-stub would otherwise have stood);
//   • a right-to-erasure refuses a live patient's Part 2 audit rows (W-M4-09) while erasing the
//     subject's ordinary rows — it never silently destroys protected SUD history;
//   • the Drizzle ports' `performErasure` leg binds to the packages/audit destruction executor
//     ONLY when a destruction-granted client is injected, and stays the loud UNBOUND throw
//     otherwise (chartwarden_app holds no DELETE — migration 0001 append-only).
import type { DbClient } from "@chartwarden/db";
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
  createDrizzleAuditEraserPorts,
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
    expect(result).toEqual({ erased: 2, refusedPartTwo: 1, refusedLegalHold: 0 });
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

/**
 * A fake destruction-granted DbClient: `transaction → tx` whose delete().where().returning()
 * resolves the seeded destroyed rows (the death-discharge-reader fake-db pattern). The full
 * envelope/predicate semantics of the executor are asserted in packages/audit
 * (__tests__/drizzle-erase.test.ts); here we prove the ports factory ROUTES to it.
 */
function makeFakeDestructionDb(rows: readonly { id: string }[]): DbClient {
  const tx = {
    async execute() {
      return undefined; // withOrgContext's set_config calls
    },
    delete() {
      return {
        where() {
          return {
            returning() {
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
  };
  return {
    async transaction<R>(fn: (t: typeof tx) => Promise<R>): Promise<R> {
      return fn(tx);
    },
  } as unknown as DbClient;
}

describe("createDrizzleAuditEraserPorts — the performErasure destruction leg", () => {
  // The tenant pool is never reached by these cases; a throwing stand-in proves it.
  const tenantDb = new Proxy({} as DbClient, {
    get() {
      throw new Error("tenant pool must not be touched by performErasure");
    },
  });

  it("stays the loud UNBOUND throw when no destruction-granted client is injected", async () => {
    const ports = createDrizzleAuditEraserPorts(tenantDb);
    await expect(ports.performErasure(eraseInput({}))).rejects.toThrow(
      /M4_ERASER_PERFORM_ERASURE_UNBOUND/,
    );
  });

  it("binds to the packages/audit executor over destructionDb and reports rows destroyed", async () => {
    const ports = createDrizzleAuditEraserPorts(tenantDb, {
      destructionDb: makeFakeDestructionDb([{ id: "evt_1" }, { id: "evt_2" }]),
    });
    await expect(ports.performErasure(eraseInput({}))).resolves.toBe(2);
  });
});
