// @chartwarden/intake-extraction — F-238 ICD-10-CM coding: the code scanner (codes come from the page, never the
// model) and the deterministic coding checks, over a terminology port the backend implements on M38.
export {
  type CodeToken,
  type ScanBlock,
  type ScanPage,
  type ScannedCode,
  findCodeTokens,
  resolveCodeTokens,
  titleAgreement,
} from "./icd-scanner";
export {
  type CodeInDocument,
  type CodingCheckInput,
  type CodingFlag,
  type CodingFlagKind,
  UNACCEPTABLE_HOSPICE_PRINCIPAL,
  runCodingChecks,
} from "./coding-checks";
export type { CodingTerminology, IcdCodeFacts, IcdDeprecation } from "./terminology-port";
export {
  type Box,
  type CodeOnPage,
  type DiagnosisCandidate,
  type GroundedDiagnosis,
  attachCodesToDiagnoses,
  flagsFor,
} from "./attach-codes";
