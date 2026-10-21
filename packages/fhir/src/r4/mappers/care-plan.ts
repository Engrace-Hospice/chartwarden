// @chartwarden/fhir — CarePlan mapper (us-core-careplan, M7, M28-T04).

import type { FhirMapper, MapperContext } from "../../interfaces/mapper";
import type { CarePlan, FhirReference } from "../types";
import type { CarePlanDomain } from "./domain";

export const US_CORE_CARE_PLAN_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-careplan";

const CARE_PLAN_CATEGORY_SYSTEM = "http://hl7.org/fhir/us/core/CodeSystem/careplan-category";

export const carePlanMapper: FhirMapper<CarePlanDomain, CarePlan> = {
  version: "4.0.1",
  profile: US_CORE_CARE_PLAN_PROFILE,
  map(row: CarePlanDomain, ctx: MapperContext): CarePlan {
    const goals: FhirReference[] = (row.goalIds ?? []).map((id) => ({ reference: `Goal/${id}` }));
    const addresses: FhirReference[] = (row.addressesConditionIds ?? []).map((id) => ({
      reference: `Condition/${id}`,
    }));

    return {
      resourceType: "CarePlan",
      id: row.id,
      meta: { lastUpdated: ctx.asOfDate, profile: [US_CORE_CARE_PLAN_PROFILE] },
      status: row.status,
      intent: row.intent,
      category: [{ coding: [{ system: CARE_PLAN_CATEGORY_SYSTEM, code: "assess-plan" }] }],
      title: row.title ?? undefined,
      description: row.description ?? undefined,
      subject: { reference: `Patient/${row.patientId}` },
      period:
        row.periodStart || row.periodEnd
          ? { start: row.periodStart ?? undefined, end: row.periodEnd ?? undefined }
          : undefined,
      addresses: addresses.length ? addresses : undefined,
      goal: goals.length ? goals : undefined,
    };
  },
};
