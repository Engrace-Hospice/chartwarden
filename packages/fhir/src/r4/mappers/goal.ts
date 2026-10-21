// @chartwarden/fhir — Goal mapper (us-core-goal, M7, M28-T04).

import type { FhirMapper, MapperContext } from "../../interfaces/mapper";
import type { Goal } from "../types";
import type { GoalDomain } from "./domain";

export const US_CORE_GOAL_PROFILE = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-goal";

const ACHIEVEMENT_STATUS_SYSTEM = "http://terminology.hl7.org/CodeSystem/goal-achievement";

export const goalMapper: FhirMapper<GoalDomain, Goal> = {
  version: "4.0.1",
  profile: US_CORE_GOAL_PROFILE,
  map(row: GoalDomain, ctx: MapperContext): Goal {
    return {
      resourceType: "Goal",
      id: row.id,
      meta: { lastUpdated: ctx.asOfDate, profile: [US_CORE_GOAL_PROFILE] },
      lifecycleStatus: row.lifecycleStatus,
      achievementStatus: row.achievementStatus
        ? { coding: [{ system: ACHIEVEMENT_STATUS_SYSTEM, code: row.achievementStatus }] }
        : undefined,
      description: { text: row.description },
      subject: { reference: `Patient/${row.patientId}` },
      target: row.targetDueDate ? [{ dueDate: row.targetDueDate }] : undefined,
    };
  },
};
