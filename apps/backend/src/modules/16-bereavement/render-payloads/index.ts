// apps/backend/src/modules/16-bereavement/render-payloads — the typed M22 render payloads M16 builds (ADR-0109 D9).
export { buildDischargeSummaryPayload, type DischargeSummaryRows } from "./discharge-summary";
export {
  type DischargeSummaryClosure,
  type DischargeSummaryPlan,
  loadDischargeSummaryRows,
  requestDischargeSummary,
} from "./request-discharge-summary";
export { BEREAVEMENT_LETTER_TEMPLATE_KEY, outreachLetterRequestOf } from "./outreach-letter";
