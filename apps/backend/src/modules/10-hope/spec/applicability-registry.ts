import {
  type HopeApplicabilityEngine,
  HopeApplicabilitySpecUnsupportedError,
} from "./applicability";
import { createHopeV1_00_1ApplicabilityEngine } from "./v1_00_1/applicability";

export function createHopeApplicabilityEngine(specVersionCode: string): HopeApplicabilityEngine {
  if (specVersionCode === "1.00.1") return createHopeV1_00_1ApplicabilityEngine();
  throw new HopeApplicabilitySpecUnsupportedError(specVersionCode);
}
