// The care-plan PATCH writes: the route DECLARES the Idempotency-Key header, so each holds one key per intent (see
// ../__tests__/declared-key-contract).
import {
  type WriteSite,
  describeDeclaredKeyContract,
} from "../../../../../packages/ui/src/testing/declared-key-contract";
import { patchGoal, patchIntervention, patchProblem } from "./care-plan-api";

const PLAN = "11111111-1111-4111-8111-111111111111";
const ELEMENT = "22222222-2222-4222-8222-222222222222";

const SITES: readonly WriteSite[] = [
  [
    "patchProblem",
    (c, changed) =>
      patchProblem(c, PLAN, ELEMENT, changed ? 5 : 4, { description: "Dyspnea at rest" } as never),
  ],
  [
    "patchGoal",
    (c, changed) =>
      patchGoal(c, PLAN, ELEMENT, changed ? 3 : 2, { revisedText: "Sit on the porch" } as never),
  ],
  [
    "patchIntervention",
    (c, changed) =>
      patchIntervention(c, PLAN, ELEMENT, changed ? 2 : 1, { description: "Oxygen 2 L" } as never),
  ],
];

describeDeclaredKeyContract("care-plan PATCH writes", SITES);
