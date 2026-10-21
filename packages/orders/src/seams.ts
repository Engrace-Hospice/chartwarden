// @chartwarden/orders — seam wiring home (§3.1 `seams.ts`, §2.8 D14 / §4.3).
//
// Per ADR-0005 D2 the seam INTERFACES are declared natively in the leaf `@chartwarden/types`
// (`OrderSignatureProvider` + `OrderProvider`); this feature module re-exports them so the M11 service
// implementations (M11-T05) build against the published contract and register into the M1 seam registry
// at boot, and so M12/M13/M14 have a single `@chartwarden/orders` import site. T01 re-exports the interfaces
// + their input/DTO types.

export type {
  OrderSignatureProvider,
  OrderProvider,
  SignOrderTargetInput,
  RecordVerbalOrderInput,
  CosignOrderInput,
  DiscontinueOrderInput,
  OrderRecordDto,
  OrderDiscontinuationDto,
  OrderCaptureContext,
} from "@chartwarden/types";
