// packages/hearthnote/src/assembly/index.ts — M8-T05. Layer-1 assembly barrel.
export type {
  AssemblyContext,
  AssemblyResult,
  EntrySelection,
  LinkedFall,
  RecordedVitals,
  SectionSelection,
  SelectionState,
  SlotValue,
} from "./types";
export { finishSentence, interpolate, joinSentences } from "./grammar";
export { describeRecordedVitals } from "./vitals";
export {
  HearthnoteAssemblyError,
  assemble,
  assembleLayer1,
  missingRequiredSections,
  type AssemblyErrorCode,
} from "./assemble";
