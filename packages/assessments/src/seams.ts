// @chartwarden/assessments — seam wiring home (§3.1 `seams.ts`, D7).
//
// Per ADR-0005 D2 (finding M09-F01) the seam INTERFACES are declared natively in the leaf
// `@chartwarden/types` (`LatestAssessmentProvider` + `ScaleSeriesProvider`); this feature module imports
// them so the M9 service implementations (`latest-provider.ts` / `series-provider.ts`, M9-T04) build
// against the published contract and register into the M1 seam registry at boot. T01 re-exports the
// interfaces + their DTOs so the rest of the package + the backend module have a single import site.

export type {
  LatestAssessmentProvider,
  ScaleSeriesProvider,
  LatestAssessment,
  ScaleSeriesPoint,
  ScaleSeries,
  ScaleDelta,
  AssessmentCaptureContext,
} from "@chartwarden/types";
