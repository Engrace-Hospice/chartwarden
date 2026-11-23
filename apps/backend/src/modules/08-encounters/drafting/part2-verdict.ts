// apps/backend/src/modules/08-encounters/drafting/part2-verdict.ts — the viewer's 42 CFR Part 2 verdict for one draft, asked at most once and only by a source
// that needs it (S1 to S4). Shared by the draft's source readers (`inputs.ts`, `discipline-plan-inputs.ts`).
import type { DraftEncounter, DraftPorts, DraftViewer } from "./ports";
import { guarded } from "./unavailable";

/** The viewer's Part 2 verdict, asked at most once per draft and only by a source that needs it. */
export type Part2Verdict = () => Promise<boolean>;

export function part2VerdictFor(
  ports: DraftPorts,
  encounter: DraftEncounter,
  viewer: DraftViewer,
): Part2Verdict {
  let asked: Promise<boolean> | undefined;
  return () => {
    asked ??= guarded("the Part 2 disclosure verdict", () =>
      ports.part2DisclosureAllowed({
        organizationId: encounter.organizationId,
        patientId: encounter.patientId,
        viewer,
      }),
    );
    return asked;
  };
}
