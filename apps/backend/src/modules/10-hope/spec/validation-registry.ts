import {
  HopeValidationSpecUnsupportedError,
  type HopeValidationEngine,
} from "./validation";
import { createHopeV1_00_1ValidationEngine } from "./v1_00_1/validation";

export function createHopeValidationEngine(specVersionCode: string): HopeValidationEngine {
  if (specVersionCode === "1.00.1") return createHopeV1_00_1ValidationEngine();
  throw new HopeValidationSpecUnsupportedError(specVersionCode);
}
