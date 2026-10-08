// apps/backend/src/modules/29-external-interfaces/inbound/inbound-seam-ports.ts — GAP-086. Binds the inbound parse worker's
// consumed-module ports to the REGISTERED seams — resolved opaquely through `getSeam` and cast to locally-declared structural
// interfaces (the `outbound/resolve-baa.ts` precedent: M29 carries no compile-time edge to M11 / M38 / M39, ADR-0005):
//
//   terminology   M38 `TerminologyProvider` → `LabSudTerminologyPort`
//                   validateLoinc  = `validate("loinc", code, asOf)`
//                   classifyLoinc  = membership in the `SUD_TEST_LOINC_VALUE_SET` value set, as of the observation date and
//                                    INCLUDING the tenant's own extension members. The platform members are seeded by
//                                    migration 0500 (docs/history/m29-m38-sud-test-loinc-seed.md). Membership ⇒ category `sud_test`.
//   consent       M39 `ConsentEvaluator.evaluateForIngressRedaction` → `LabConsentPort` (allowDisclosure = !redactSUD)
//   orders        M11 `OrderProvider.getOrder` → `LabOrderPort` (OBR-2 placer order number = `order_record.id`, D8)
//
// The seams read ambient request context, so each call runs inside a system-actor `runWithRequestContext` for the org being
// processed (a worker tick is not a request). Every seam is resolved at CALL time (they register after this is built).
import { runWithRequestContext } from "@wardenx/tenancy";

import { getSeam } from "../../../bootstrap/index";
import type { LabOrderPort } from "./lab-patient-resolver";
import type { LabConsentPort, LabSudTerminologyPort } from "./lab-sud-redaction";

/** The M38 value set whose LOINC members are 42 CFR Part 2 substance-use-disorder tests. */
export const SUD_TEST_LOINC_VALUE_SET = "sud_test_loinc";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TerminologySeam {
  validate(
    system: "loinc",
    code: string,
    asOf?: Date,
  ): Promise<{ readonly valid: boolean; readonly status?: string }>;
  isMemberOf(
    valueSetId: string,
    system: "loinc",
    code: string,
    opts?: { readonly asOf?: Date; readonly orgId?: string },
  ): Promise<{ readonly isMember: boolean }>;
}
interface ConsentSeam {
  evaluateForIngressRedaction(args: {
    organizationId: string;
    patientId: string;
    asOf?: string;
    callerModule: string;
  }): Promise<{ readonly redactSubstanceUseDisorderFields: boolean }>;
}
interface OrderSeam {
  getOrder(input: {
    orderId: string;
  }): Promise<{ readonly orderId: string; readonly patientId: string } | null>;
}

const asSystem = <T>(organizationId: string, fn: () => Promise<T>): Promise<T> =>
  runWithRequestContext({ organizationId, userId: "", systemActor: true }, fn);

export interface M29InboundSeamPorts {
  readonly terminology: LabSudTerminologyPort;
  readonly consent: LabConsentPort;
  readonly orderReader: LabOrderPort;
}

export function buildM29InboundSeamPorts(): M29InboundSeamPorts {
  return {
    terminology: {
      async validateLoinc({ code, asOfDate }) {
        const r = await (getSeam("TerminologyProvider") as TerminologySeam).validate(
          "loinc",
          code,
          new Date(asOfDate),
        );
        return {
          exists: r.valid || r.status === "deprecated",
          deprecated: r.status === "deprecated",
        };
      },
      async classifyLoinc({ code, asOfDate, organizationId }) {
        const member = await (getSeam("TerminologyProvider") as TerminologySeam).isMemberOf(
          SUD_TEST_LOINC_VALUE_SET,
          "loinc",
          code,
          { asOf: new Date(asOfDate), ...(organizationId ? { orgId: organizationId } : {}) },
        );
        return { categories: member.isMember ? ["sud_test"] : [] };
      },
    },

    consent: {
      async evaluateForIngressRedaction({ organizationId, patientId, asOf }) {
        // Fail safe: without a tenant the real evaluator cannot answer — the gate redacts on a throw.
        if (!organizationId) {
          throw new Error("organizationId is required to evaluate SUD ingress consent");
        }
        const decision = await asSystem(organizationId, () =>
          (getSeam("ConsentEvaluator") as ConsentSeam).evaluateForIngressRedaction({
            organizationId,
            patientId,
            asOf,
            callerModule: "m29",
          }),
        );
        return { allowDisclosure: !decision.redactSubstanceUseDisorderFields };
      },
    },

    orderReader: {
      async getOrderByPlacerId({ organizationId, placerOrderNumber }) {
        // The placer number IS `order_record.id` (a uuid); anything else cannot name an order.
        if (!UUID_RE.test(placerOrderNumber)) return null;
        const order = await asSystem(organizationId, () =>
          (getSeam("OrderProvider") as OrderSeam).getOrder({ orderId: placerOrderNumber }),
        );
        return order ? { id: order.orderId, patientId: order.patientId } : null;
      },
    },
  };
}
