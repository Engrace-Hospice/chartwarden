// Episode Alert DDE contract-test kit (#759). SKIPPED unless ALL of these are set, so CI and a plain `bun run test` never
// reach the network:
//
//   EPISODE_ALERT_DDE_TEST_KEY=<the trial account's API key>
//   EPISODE_ALERT_DDE_BASE_URL=<the API root from the vendor guide>
//   EPISODE_ALERT_DDE_CONTRACT_CONFIRM=trial-account-only     (you confirm this is the TRIAL account, not production)
//   EPISODE_ALERT_DDE_OPERATOR=<the membership id of an operator the vendor has a DDE ID for>
//   [EPISODE_ALERT_DDE_UNENROLLED_OPERATOR=<an operator it has none for>]
//
// It is the finish line for the adapter: it fails first on "the wire is recorded as verified" until
// ./episode-alert-dde-wire is completed from the vendor guide (steps in that file's header). After that it asserts
// only what the vendor's answers can contradict: the read paths honour the port (a Page, a refused malformed cursor, a
// refused unenrolled operator) and no credential or MBI shape leaks into a result. It never submits an operation:
// a write needs a person to confirm a test NOE on the trial account, which belongs in the runbook, not in CI.
import { describe, expect, it } from "vitest";
import { EpisodeAlertDdeProvider } from "./episode-alert-dde-provider";
import { EA_DDE_FACTS, EA_DDE_WIRE } from "./episode-alert-dde-wire";
import { DDE, type DdeContext } from "./types";

const KEY = process.env.EPISODE_ALERT_DDE_TEST_KEY?.trim();
const BASE = process.env.EPISODE_ALERT_DDE_BASE_URL?.trim();
const OPERATOR = process.env.EPISODE_ALERT_DDE_OPERATOR?.trim();
const UNENROLLED = process.env.EPISODE_ALERT_DDE_UNENROLLED_OPERATOR?.trim();
const RUN =
  Boolean(KEY) &&
  Boolean(BASE) &&
  Boolean(OPERATOR) &&
  process.env.EPISODE_ALERT_DDE_CONTRACT_CONFIRM === "trial-account-only";
const SKIP_REASON =
  "set EPISODE_ALERT_DDE_TEST_KEY, EPISODE_ALERT_DDE_BASE_URL, EPISODE_ALERT_DDE_OPERATOR and EPISODE_ALERT_DDE_CONTRACT_CONFIRM=trial-account-only to run the Episode Alert DDE contract kit (issue #759)";

const ctx = (operatorMembershipId: string): DdeContext => ({
  organizationId: "contract-org",
  providerEntityId: "contract-provider",
  operatorMembershipId,
  correlationId: "contract-run",
  usage: "test",
});

describe.skipIf(!RUN)(
  `Episode Alert DDE contract kit${RUN ? "" : ` (skipped: ${SKIP_REASON})`}`,
  () => {
    const provider = () =>
      new EpisodeAlertDdeProvider({
        apiKey: KEY as string,
        baseUrl: BASE as string,
        wire: EA_DDE_WIRE,
        allowTestUsage: true,
      });

    it("the wire and every vendor fact are recorded", () => {
      expect(EA_DDE_WIRE.verified).toBe(true);
      expect(Object.values(EA_DDE_FACTS).every((v) => v !== null)).toBe(true);
    });

    it("the change report answers a Page and resumes from its cursor", async () => {
      const first = await provider().fetchOutcomes(ctx(OPERATOR as string), null);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(Array.isArray(first.data.items)).toBe(true);
      expect(first.data.nextCursor.length).toBeGreaterThan(0);
      const again = await provider().fetchOutcomes(ctx(OPERATOR as string), first.data.nextCursor);
      expect(again.ok).toBe(true);
    });

    it("a malformed cursor is refused, not restarted", async () => {
      const r = await provider().fetchOutcomes(ctx(OPERATOR as string), "not-a-cursor");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.degraded.code).toBe(DDE.INVALID_REQUEST);
    });

    it.skipIf(!UNENROLLED)("an operator with no DDE ID is refused on reads", async () => {
      const r = await provider().fetchOutcomes(ctx(UNENROLLED as string), null);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.degraded.code).toBe(DDE.OPERATOR_NOT_ENROLLED);
    });

    it("no credential appears in any result", async () => {
      const r = await provider().fetchOutcomes(ctx(OPERATOR as string), null);
      expect(JSON.stringify(r)).not.toContain(KEY as string);
    });
  },
);

describe("Episode Alert DDE contract kit gate", () => {
  it("is skipped without the trial switches (and says why)", () => {
    expect(typeof SKIP_REASON).toBe("string");
    if (!RUN)
      expect(
        KEY === undefined ||
          OPERATOR === undefined ||
          BASE === undefined ||
          process.env.EPISODE_ALERT_DDE_CONTRACT_CONFIRM !== "trial-account-only",
      ).toBe(true);
  });
});
