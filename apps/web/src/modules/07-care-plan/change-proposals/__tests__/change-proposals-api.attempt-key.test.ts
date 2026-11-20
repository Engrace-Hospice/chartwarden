// POST .../change-proposals DECLARES an Idempotency-Key, so recording a proposal holds one key per intent (shared declared-key contract).
import { type WriteSite, describeDeclaredKeyContract } from "@chartwarden/ui/testing";
import { createProposal } from "../change-proposals-api";

const PLAN = "11111111-1111-4111-8111-111111111111";
const VISIT = "22222222-2222-4222-8222-222222222222";
const PROBLEM = "33333333-3333-4333-8333-333333333333";

// The shared contract reads "no answer" as a rejection; this layer reports it as `{ ok: false, status: null }`, so the site maps it back.
async function createOrReject(
  client: Parameters<typeof createProposal>[0],
  changed: boolean | undefined,
): Promise<unknown> {
  const result = await createProposal(client, PLAN, {
    sourceEncounterId: VISIT,
    kind: "goal_add",
    problemId: PROBLEM,
    originalText: changed ? "Sit on the porch" : "Sleep through the night",
  });
  if (!result.ok && result.status === null) throw new TypeError("Failed to fetch");
  return result;
}

const SITES: readonly WriteSite[] = [["createProposal", createOrReject]];

describeDeclaredKeyContract("the change-proposal create write", SITES);
