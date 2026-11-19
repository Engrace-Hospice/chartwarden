// packages/hearthnote/src/assembly/index.ts — M8-T05. Layer-1 assembly barrel.
export type {
  AssemblyContext,
  AssemblyResult,
  EntrySelection,
  SectionSelection,
  SelectionState,
  SlotValue,
} from "./types";
export { finishSentence, interpolate, joinSentences } from "./grammar";
export {
  HearthnoteAssemblyError,
  NOTE_BLOCK_SEPARATOR,
  assemble,
  assembleBlocks,
  assembleLayer1,
  joinBlocks,
  missingRequiredSections,
  renderSection,
  resolveSelectionTemplate,
  type AssembledBlock,
  type AssemblyErrorCode,
} from "./assemble";
