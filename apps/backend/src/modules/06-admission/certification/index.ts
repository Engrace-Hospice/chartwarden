// apps/backend/src/modules/06-admission/certification — M6-T08 recertification CTI sign (§7.3) +
// Face-to-Face window math (§7.4) + the compliance-officer F2F window override (§7.5). PURE domain
// rules the routes/service slice composes over its dataset; the org-timezone window math is the single
// source of truth for the D4 written-cert deadline and the CMS 418.22 F2F window.
export {
  DEFAULT_ORG_TIME_ZONE,
  F2F_PRIOR_WINDOW,
  WRITTEN_CERT_DEADLINE_DAYS,
  type F2fWindow,
  type F2fWindowStatus,
  addCalendarDays,
  endOfOrgDayInstant,
  localDateOfInstant,
  computeWrittenCertDeadline,
  isWrittenCertOverdue,
  computeF2fWindow,
  isF2fScheduledWithinWindow,
  decideF2fWindowStatus,
} from "./window-math";
export {
  type CtiSignProgress,
  type RecertSignFacts,
  type RecertSignOutcome,
  decideRecertSign,
} from "./recert";
export {
  ADEQUACY_FLAG_CODES,
  ADEQUACY_REASON_CODES,
  type AdequacyCtiFact,
  type AdequacyDecisionSummary,
  type AdequacyF2fFact,
  type AdequacyFlagCode,
  type AdequacyInput,
  type AdequacyPeriodFact,
  type AdequacyReasonCode,
  type AdequacyResult,
  type AdequacySection,
  type F2fWindowBasis,
  evaluatePeriodAdequacy,
  f2fRequiredForSequence,
  pickCertification,
  pickFaceToFace,
  summarizeAdequacy,
} from "./adequacy";
