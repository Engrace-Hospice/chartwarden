import { createHash } from "node:crypto";
import type { EraserReceipt, ShredEraserCallbackPort } from "@chartwarden/saas-tenant-platform";
import type { DataClass, DataEraser } from "@chartwarden/types";
import { getEraser } from "../../bootstrap/erasers/registry";

/**
 * The subject carried by each registered eraser during a whole-tenant destruction. Keeping this
 * exhaustive prevents a newly registered PHI class from silently falling outside the M34 shred fan-out.
 */
export const TENANT_SHRED_ERASER_SUBJECT = {
  audit_event: "patient",
  clinical_record: "patient",
  documents: "patient",
  messages: "organization",
  consent: "patient",
  telehealth_recording: "patient",
  identity: "sole_tenant_user",
  terminology_tenant_extensions: "organization",
  mdm_tenant_overlays: "organization",
  admission_record: "patient",
  care_plan_record: "patient",
  encounter_record: "patient",
  clinical_assessment: "patient",
  hope_record: "patient",
  order_record: "patient",
  medication_order_record: "patient",
  emar_record: "patient",
  idg_record: "patient",
  discipline_plan_record: "patient",
  bereavement_record: "patient",
  supply_record: "patient",
  operational_schedule: "patient",
  evv_record: "patient",
  triage_record: "patient",
  safety_record: "patient",
  saas_tenant_platform_class: "organization",
  intake_ai_provenance: "patient",
  clinical_record_ai_provenance: "patient",
  fhir_gateway: "organization",
  portal_record: "patient",
  external_interfaces: "organization",
  ipu_record: "patient",
  reporting_class: "organization",
  quality_class: "organization",
  cost_report_class: "organization",
  billing_record: "patient",
  remittance: "patient",
  medicaid_billing_record: "patient",
  cap: "patient",
} as const satisfies Record<DataClass, "organization" | "patient" | "sole_tenant_user">;

export interface TenantShredSubjectEnumerator {
  patientIds(orgId: string): Promise<readonly string[]>;
  /** Users with no non-revoked membership outside this org; shared users must keep global credentials. */
  soleTenantUserIds(orgId: string): Promise<readonly string[]>;
}

export class TenantShredLegalHoldRefusal extends Error {
  constructor(dataClass: DataClass, refusedRows: number) {
    super(
      `tenant shred eraser '${dataClass}' retained ${refusedRows} row(s) under legal hold; refusing DEK destruction`,
    );
    this.name = "TenantShredLegalHoldRefusal";
  }
}

export interface TenantShredEraserAdapterDeps {
  readonly subjects: TenantShredSubjectEnumerator;
  readonly eraserFor?: (dataClass: DataClass) => DataEraser;
}

/**
 * Bind Phase 1 to the boot-validated M4 eraser registry. Every registered data class receives the
 * correct subject grain: all patients, the org itself, or only users whose identity is not shared with
 * another tenant. Part 2 refusals become the worker's typed refusal receipts; legal-hold refusals throw
 * and stop before object/key destruction.
 */
export function createTenantShredEraserCallback(
  deps: TenantShredEraserAdapterDeps,
): Pick<ShredEraserCallbackPort, "callbackAllEraserFns"> {
  const eraserFor = deps.eraserFor ?? getEraser;
  return {
    async callbackAllEraserFns({ orgId }) {
      const [patientIds, soleTenantUserIds] = await Promise.all([
        deps.subjects.patientIds(orgId),
        deps.subjects.soleTenantUserIds(orgId),
      ]);
      const receipts: EraserReceipt[] = [];

      for (const [dataClass, subjectKind] of Object.entries(TENANT_SHRED_ERASER_SUBJECT) as Array<
        [DataClass, (typeof TENANT_SHRED_ERASER_SUBJECT)[DataClass]]
      >) {
        const subjectIds =
          subjectKind === "organization"
            ? [orgId]
            : subjectKind === "patient"
              ? patientIds
              : soleTenantUserIds;
        let erasedRows = 0;
        let refusedPartTwo = 0;
        let refusedLegalHold = 0;

        for (const subjectId of subjectIds) {
          const result = await eraserFor(dataClass).erase({ orgId }, subjectId);
          erasedRows += result.erased;
          refusedPartTwo += result.refusedPartTwo ?? 0;
          refusedLegalHold += result.refusedLegalHold ?? 0;
        }

        if (refusedLegalHold > 0) {
          throw new TenantShredLegalHoldRefusal(dataClass, refusedLegalHold);
        }
        if (erasedRows > 0 || refusedPartTwo === 0) {
          receipts.push({
            module: dataClass,
            outcome: "erased",
            erasedRows,
            sha256: createHash("sha256")
              .update(JSON.stringify({ dataClass, orgId, erasedRows }))
              .digest("hex"),
          });
        }
        if (refusedPartTwo > 0) {
          receipts.push({
            module: dataClass,
            outcome: "refused_part_two_retention",
            refusedRows: refusedPartTwo,
          });
        }
      }
      return receipts;
    },
  };
}
