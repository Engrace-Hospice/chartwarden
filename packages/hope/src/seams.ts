// @wardenx/hope — seam wiring home (§3.1 `seams.ts`, D10).
//
// Per ADR-0005 D2 the seam INTERFACES are declared natively in the leaf `@wardenx/types`
// (`HopeTimepointProvider` + `HopeSubmissionProvider` + `HopeJ2051Provider`); this feature module
// imports them so the M10 service implementations (M10-T05) build against the published contract and
// register into the M1 seam registry at boot. T01 re-exports the interfaces + their DTOs so the rest of
// the package + the backend module have a single import site.

export type {
  HopeTimepointProvider,
  HopeSubmissionProvider,
  HopeJ2051Provider,
  HopeTimepointStatus,
  HopeJ2051Event,
  HopeSubmissionStatusView,
  HopeCaptureContext,
} from "@wardenx/types";
