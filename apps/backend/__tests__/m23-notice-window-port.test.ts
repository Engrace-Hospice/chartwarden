// The breach stamp the deadline watchdog writes is an Eastern (CMS) calendar day, like every other date in the window math
// (the watch counts days to the target, and a tenant's external filing record is judged, by the Eastern day). No database: the
// notice repositories are recording fakes.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const fakes = vi.hoisted(() => ({
  patches: [] as { id: string; state: string; patch: Row }[],
}));

vi.mock("@chartwarden/billing", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const repos = original.repositories as Record<string, unknown>;
  const notice = class {
    findById = async (id: string) => ({ id, state: "ready", version: 3 });
    transitionToState = async (id: string, _version: number, state: string, patch: Row) => {
      fakes.patches.push({ id, state, patch });
      return { ok: true, row: { id } };
    };
  };
  return { ...original, repositories: { ...repos, NoeRepository: notice, NotrRepository: notice } };
});

import { buildNoticeWindowPort } from "../src/modules/23-billing-medicare/jobs/m23-worker-ports";

beforeEach(() => {
  fakes.patches.length = 0;
});

describe("the window-breach stamp", () => {
  it.each(["noe", "notr"] as const)(
    "%s: stamps the EASTERN day (21:00 Eastern on 10-06 is 01:00 UTC on 10-07, still 10-06)",
    async (kind) => {
      await buildNoticeWindowPort().recordBreach({
        tx: {} as never,
        kind,
        noticeId: "n-1",
        expectedVersion: 3,
        breachedAt: new Date("2026-10-07T01:00:00.000Z"),
      });
      expect(fakes.patches).toEqual([
        { id: "n-1", state: "ready", patch: { windowBreachedAt: "2026-10-06" } },
      ]);
    },
  );
});
