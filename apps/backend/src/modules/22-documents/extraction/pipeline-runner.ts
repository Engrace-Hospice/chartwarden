// apps/backend/src/modules/22-documents/extraction/pipeline-runner.ts — M22-T08 (§7.1 W1 / §8.5).
//
// The backend's consumption of the `@wardenx/intake-extraction` DocLens pipeline. It wires the §7.1 W1 orchestrator
// over the FOUR §8.5 M32 capabilities — defaulting all of them to the deny-stubs (`@wardenx/intake-extraction`)
// since M32 is not yet bound (Phase 1). This is the concrete "consume M32 as a deny-stub" wiring: when the runner is
// invoked with the deny-stubbed capabilities, the orchestrator fails safe at the docling stage with
// `awaiting_capability` — no AI runs, no chart write, no auto-commit. In Phase 1 the `documents.doclens` route gate
// (see ./doclens-gate) returns 503 BEFORE this runner is ever invoked; this slice proves the seam contract holds and
// is ready to flip live the moment M32 registers the real capabilities (the runner takes them by injection).
//
// Per the §25.14 adapter mandate the backend touches the docling client / M32 seams ONLY through
// `@wardenx/intake-extraction` — never an Anthropic SDK / Ollama / docling import of its own.
import { randomUUID } from "node:crypto";
import {
  type DocLensCapabilities,
  type IntakeBatchInput,
  type IntakePipelineOutcome,
  denyStubDocLensCapabilities,
  runIntakePipeline,
} from "@wardenx/intake-extraction";

/** The DocLens pipeline runner the backend extraction worker drives (once `documents.doclens` is on). */
export interface DocLensPipelineRunner {
  run(batch: IntakeBatchInput): Promise<IntakePipelineOutcome>;
}

export interface DocLensPipelineRunnerDeps {
  /** The four §8.5 M32 capabilities (defaults to the deny-stubs until M32 registers the real ones). */
  readonly capabilities?: DocLensCapabilities;
  /** Id minter for jobs/candidates (injected so tests are deterministic; `randomUUID`-prefixed in prod). */
  readonly mintId?: (prefix: "job" | "cand") => string;
}

/**
 * Build the DocLens pipeline runner. With no `capabilities` supplied it runs over the deny-stubs, so an invoked
 * pipeline returns `awaiting_capability` (fail safe). The M22 boot wires this with the M32-registered capabilities
 * once they land (the seam-registry `m32.doclens-*` keys, §4.4) — the runner code is unchanged.
 */
export function createDocLensPipelineRunner(deps: DocLensPipelineRunnerDeps = {}): DocLensPipelineRunner {
  const capabilities = deps.capabilities ?? denyStubDocLensCapabilities;
  const mintId = deps.mintId ?? ((prefix) => `${prefix}-${randomUUID()}`);
  return {
    run(batch: IntakeBatchInput): Promise<IntakePipelineOutcome> {
      return runIntakePipeline(batch, { capabilities, mintId });
    },
  };
}
