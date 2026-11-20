// apps/web/src/modules/08-encounters/findings — the visit findings UI the note composer mounts (WF09): ADLs, nutrition, weight and height.
export { AdlPanel } from "./adl-panel";
export type { AdlPanelProps } from "./adl-panel";
export { NutritionPanel } from "./nutrition-panel";
export type { NutritionPanelProps } from "./nutrition-panel";
export { BodyMeasureFields, useWeightHistory } from "./body-measure-fields";
export type { BodyMeasureFieldsProps } from "./body-measure-fields";
export {
  EMPTY_BODY_MEASURES,
  bodyMeasureErrors,
  bodyMeasurePayload,
  computeBmi,
} from "./findings-model";
export type { BodyMeasureValues, HeightUnit, WeightUnit } from "./findings-model";
export type { WeightHistoryView, WeightReading } from "./findings-api";
