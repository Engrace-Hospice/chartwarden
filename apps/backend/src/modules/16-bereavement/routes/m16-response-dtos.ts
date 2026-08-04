// apps/backend/src/modules/16-bereavement/routes/m16-response-dtos.ts
// Compile-time conformance pins for the M16 §4.2 response DTOs.
//
// These aliases pin each published response schema (defined in `m16-typebox.ts`) to the service read/write
// view it mirrors — so a view field added, renamed, or retyped breaks `bun run build`. They live in THIS
// leaf file (imported by nothing at runtime) rather than in `m16-typebox.ts` because `read-service.ts`
// already imports the branded ids / enums FROM `m16-typebox.ts`; putting the reverse `import type` in the
// typebox would form a `typebox ↔ read-service` import cycle that `arch:boundaries` (no-circular) rejects.
// tsc still type-checks this file (it is inside the module's compilation), so the pins are enforced.
import type { Static } from "@sinclair/typebox";
import type { CursorPage } from "./concurrency";
import type {
  BereavedContactRowViewResponseSchema,
  BereavementClosureViewResponseSchema,
  BereavementContactLogViewResponseSchema,
  BereavementOutreachPageResponseSchema,
  BereavementOutreachRowViewResponseSchema,
  BereavementPlanDetailResponseSchema,
  BereavementPlanListItemResponseSchema,
  BereavementPlanPageResponseSchema,
  BereavementRiskScorePageResponseSchema,
  BereavementRiskScoreViewResponseSchema,
  CounselorDashboardViewResponseSchema,
  PlanActivationViewResponseSchema,
  ScheduleRegenerationViewResponseSchema,
  SupervisorDashboardViewResponseSchema,
} from "./m16-typebox";
import type {
  BereavedContactRowView as SvcBereavedContactRowView,
  BereavementClosureView as SvcBereavementClosureView,
  BereavementOutreachRowView as SvcBereavementOutreachRowView,
  BereavementPlanDetail as SvcBereavementPlanDetail,
  BereavementPlanListItem as SvcBereavementPlanListItem,
  BereavementRiskScoreView as SvcBereavementRiskScoreView,
  CounselorDashboardView as SvcCounselorDashboardView,
  SupervisorDashboardView as SvcSupervisorDashboardView,
} from "./read-service";
import type {
  BereavementContactLogView as SvcBereavementContactLogView,
  PlanActivationView as SvcPlanActivationView,
  ScheduleRegenerationView as SvcScheduleRegenerationView,
} from "./write-service";

// `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _PlanListItem = Conforms<
  Static<typeof BereavementPlanListItemResponseSchema>,
  SvcBereavementPlanListItem
>;
type _ContactRow = Conforms<
  Static<typeof BereavedContactRowViewResponseSchema>,
  SvcBereavedContactRowView
>;
type _PlanDetail = Conforms<
  Static<typeof BereavementPlanDetailResponseSchema>,
  SvcBereavementPlanDetail
>;
type _Closure = Conforms<
  Static<typeof BereavementClosureViewResponseSchema>,
  SvcBereavementClosureView
>;
type _Outreach = Conforms<
  Static<typeof BereavementOutreachRowViewResponseSchema>,
  SvcBereavementOutreachRowView
>;
type _RiskScore = Conforms<
  Static<typeof BereavementRiskScoreViewResponseSchema>,
  SvcBereavementRiskScoreView
>;
type _ContactLog = Conforms<
  Static<typeof BereavementContactLogViewResponseSchema>,
  SvcBereavementContactLogView
>;
type _ScheduleRegen = Conforms<
  Static<typeof ScheduleRegenerationViewResponseSchema>,
  SvcScheduleRegenerationView
>;
type _PlanActivation = Conforms<
  Static<typeof PlanActivationViewResponseSchema>,
  SvcPlanActivationView
>;
type _CounselorDash = Conforms<
  Static<typeof CounselorDashboardViewResponseSchema>,
  SvcCounselorDashboardView
>;
type _SupervisorDash = Conforms<
  Static<typeof SupervisorDashboardViewResponseSchema>,
  SvcSupervisorDashboardView
>;
type _PlanPage = Conforms<
  Static<typeof BereavementPlanPageResponseSchema>,
  CursorPage<SvcBereavementPlanListItem>
>;
type _OutreachPage = Conforms<
  Static<typeof BereavementOutreachPageResponseSchema>,
  CursorPage<SvcBereavementOutreachRowView>
>;
type _RiskScorePage = Conforms<
  Static<typeof BereavementRiskScorePageResponseSchema>,
  CursorPage<SvcBereavementRiskScoreView>
>;
