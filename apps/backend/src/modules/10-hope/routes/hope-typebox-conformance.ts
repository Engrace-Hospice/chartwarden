// apps/backend/src/modules/10-hope/routes/hope-typebox-conformance.ts — compile-time pins between the response schemas of
// `hope-typebox.ts` and the views the route service returns. Types only: this file has no runtime code. It lives apart from
// `hope-typebox.ts` so that file does not import `./service` (the in-memory twin imports `hope-reference-screen.ts`, which reads the
// result-row patterns from `hope-typebox.ts`; with the pins inside it the three would form an import cycle, which the architecture
// gate forbids). `tsc -b` still compiles this file, so a view field added without its schema field is a type error here.
import type { Static } from "@sinclair/typebox";
import type {
  HopeAnswerPatchResponseSchema,
  HopeAssessmentListResponseSchema,
  HopeAssessmentResponseSchema,
  HopeAssessmentReviewResponseSchema,
  HopeAssessmentWorkspaceResponseSchema,
  HopeComplianceResponseSchema,
  HopeRegenerateResponseSchema,
  HopeScheduleListResponseSchema,
  HopeScheduleResponseSchema,
  HopeSfvListResponseSchema,
  HopeSfvResponseSchema,
  HopeSignResponseSchema,
  HopeSubmissionListResponseSchema,
  HopeSubmissionResponseSchema,
  HopeSummaryRequestedResponseSchema,
  HopeValidationResponseSchema,
  HopeWorkflowStateResponseSchema,
} from "./hope-typebox";
import type {
  HopeAnswerPatchResult as ServiceAnswerPatchResult,
  HopeAssessmentView as ServiceAssessmentView,
  HopeAssessmentWorkspace as ServiceAssessmentWorkspace,
  HopeComplianceView as ServiceComplianceView,
  HopeReviewReadModel as ServiceReviewReadModel,
  HopeScheduleView as ServiceScheduleView,
  HopeSfvView as ServiceSfvView,
  HopeSignResult as ServiceSignResult,
  HopeSubmissionView as ServiceSubmissionView,
  HopeValidationRunView as ServiceValidationRunView,
  HopeWorkflowStateView as ServiceWorkflowStateView,
} from "./service";

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _Assessment = Conforms<Static<typeof HopeAssessmentResponseSchema>, ServiceAssessmentView>;
type _Workspace = Conforms<
  Static<typeof HopeAssessmentWorkspaceResponseSchema>,
  ServiceAssessmentWorkspace
>;
type _Review = Conforms<Static<typeof HopeAssessmentReviewResponseSchema>, ServiceReviewReadModel>;
type _AnswerPatch = Conforms<
  Static<typeof HopeAnswerPatchResponseSchema>,
  ServiceAnswerPatchResult
>;
type _Sign = Conforms<Static<typeof HopeSignResponseSchema>, ServiceSignResult>;
type _Schedule = Conforms<Static<typeof HopeScheduleResponseSchema>, ServiceScheduleView>;
type _Sfv = Conforms<Static<typeof HopeSfvResponseSchema>, ServiceSfvView>;
type _Submission = Conforms<Static<typeof HopeSubmissionResponseSchema>, ServiceSubmissionView>;
type _Compliance = Conforms<Static<typeof HopeComplianceResponseSchema>, ServiceComplianceView>;
type _WorkflowState = Conforms<
  Static<typeof HopeWorkflowStateResponseSchema>,
  ServiceWorkflowStateView
>;
type _Validation = Conforms<Static<typeof HopeValidationResponseSchema>, ServiceValidationRunView>;
type _ScheduleList = Conforms<
  Static<typeof HopeScheduleListResponseSchema>,
  { readonly schedules: readonly ServiceScheduleView[] }
>;
type _AssessmentList = Conforms<
  Static<typeof HopeAssessmentListResponseSchema>,
  { readonly assessments: readonly ServiceAssessmentView[] }
>;
type _SfvList = Conforms<
  Static<typeof HopeSfvListResponseSchema>,
  { readonly sfvs: readonly ServiceSfvView[] }
>;
type _SubmissionList = Conforms<
  Static<typeof HopeSubmissionListResponseSchema>,
  { readonly submissions: readonly ServiceSubmissionView[] }
>;
type _SummaryRequested = Conforms<
  Static<typeof HopeSummaryRequestedResponseSchema>,
  { assessmentId: string; requested: true }
>;
type _Regenerate = Conforms<
  Static<typeof HopeRegenerateResponseSchema>,
  { admissionId: string; scheduleCount: number }
>;
