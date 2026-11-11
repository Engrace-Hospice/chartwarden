// Owner decision (round 2, Q1): a notice at risk files NO DDE work item when the org bills outside ChartWarden. The DDE queue is a
// ChartWarden-side work list (staff key the notice into Medicare's Direct Data Entry); an outside tenant's notice is filed by its own
// biller, and the queue routes are gated for such an org, so an item would be a dead end. The deadline watch and its warning /
// breach events are unchanged. No database: the notice repositories are recording fakes (the gap-069-070 harness).
import {
  UNBOUND_NOT_ACTIVE,
  UNBOUND_NOT_CHOSEN,
  UNBOUND_OUTSIDE,
} from "@chartwarden/x12-837-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const fakes = vi.hoisted(() => ({
  window: [] as Row[],
  dde: [] as Row[],
}));

vi.mock("@chartwarden/billing", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const repos = original.repositories as Record<string, unknown>;
  class NoeRepository {
    listWindowWatchCandidates = async () => fakes.window;
    listDdeWatchCandidates = async () => fakes.dde;
  }
  class NotrRepository {
    listWindowWatchCandidates = async () => fakes.window;
    listDdeWatchCandidates = async () => fakes.dde;
  }
  return { ...original, repositories: { ...repos, NoeRepository, NotrRepository } };
});

vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ transaction: async (inner: (t: unknown) => Promise<unknown>) => inner({}) }),
}));

import {
  type M23WorkerDeps,
  runNoeWindowWatch,
  runNotrWindowWatch,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";

const ORG_OUTSIDE = "00000000-0000-4000-8000-0000000000a1";
const ORG_VENDOR = "00000000-0000-4000-8000-0000000000b2";
const ORG_NONE = "00000000-0000-4000-8000-0000000000c3";
const ORG_DRAFT = "00000000-0000-4000-8000-0000000000d4";
const NOW = new Date("2026-10-05T12:00:00.000Z");

const NOTICE = {
  id: "notice-1",
  admissionId: "adm-1",
  providerEntityId: "pe-1",
  patientId: "patient-1",
  version: 2,
  windowTargetAt: "2026-10-06",
};

function harness(orgs: string[]) {
  const items: { organizationId: string; itemType: string; noticeId: string }[] = [];
  const published: string[] = [];
  const binding = {
    ...UNBOUND_NOT_CHOSEN,
    forOrg: async (org: string) => {
      if (org === ORG_OUTSIDE) return UNBOUND_OUTSIDE;
      if (org === ORG_NONE) return UNBOUND_NOT_CHOSEN;
      if (org === ORG_DRAFT) return UNBOUND_NOT_ACTIVE;
      return { vendor: "stedi" as const, transport: {} as never };
    },
  };
  const deps = {
    connection: {} as never,
    db: {} as never,
    now: () => NOW,
    outbox: {
      publish: async (_tx: unknown, e: { eventName: string }) => void published.push(e.eventName),
    },
    alerts: { dispatch: async () => undefined },
    activeOrgs: { listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })) },
    noticeWindow: { recordBreach: async () => undefined },
    transport: { binding, contexts: {} as never },
    ddeWatchdog: {
      ensureNoticeItem: async (
        _tx: unknown,
        n: { organizationId: string; itemType: string; noticeId: string },
      ) => {
        items.push({
          organizationId: n.organizationId,
          itemType: n.itemType,
          noticeId: n.noticeId,
        });
        return { created: true };
      },
      ensureClaimRtpItem: async () => ({ created: false }),
      supersedeForSubject: async () => ({ closed: 0 }),
    },
  } as unknown as M23WorkerDeps;
  return { deps, items, published };
}

beforeEach(() => {
  fakes.window = [];
  fakes.dde = [{ ...NOTICE }];
});

describe("the DDE watchdog skips an org that bills outside ChartWarden", () => {
  for (const [kind, run] of [
    ["noe", runNoeWindowWatch],
    ["notr", runNotrWindowWatch],
  ] as const) {
    it(`${kind}: files an item for a vendor org and for orgs still setting up, none for the outside org`, async () => {
      const { deps, items } = harness([ORG_OUTSIDE, ORG_VENDOR, ORG_NONE, ORG_DRAFT]);
      await run(deps);
      expect(items.map((i) => i.organizationId).sort()).toEqual(
        [ORG_VENDOR, ORG_NONE, ORG_DRAFT].sort(),
      );
      expect(items.every((i) => i.itemType === kind)).toBe(true);
    });

    it(`${kind}: the deadline watch itself is unchanged for the outside org (warning event still published)`, async () => {
      fakes.window = [{ ...NOTICE, windowTargetAt: "2026-10-05" }]; // the target day: a warning
      const { deps, published, items } = harness([ORG_OUTSIDE]);
      await run(deps);
      expect(published).toEqual([`m23.${kind}.window_warning`]);
      expect(items).toEqual([]);
    });
  }

  it("a binding that cannot be resolved does not hide the notice: the item is still filed (never a silent skip)", async () => {
    const { deps, items } = harness([ORG_VENDOR]);
    const broken = {
      ...deps,
      transport: {
        ...(deps.transport as object),
        binding: {
          ...UNBOUND_NOT_CHOSEN,
          forOrg: async () => {
            throw new Error("config unreadable");
          },
        },
      },
    } as unknown as M23WorkerDeps;
    await runNoeWindowWatch(broken);
    expect(items.map((i) => i.organizationId)).toEqual([ORG_VENDOR]);
  });

  it("a legacy single-vendor deployment (no per-org binding) files items as before", async () => {
    const { deps, items } = harness([ORG_VENDOR]);
    const legacy = { ...deps, transport: undefined } as unknown as M23WorkerDeps;
    await runNoeWindowWatch(legacy);
    expect(items).toHaveLength(1);
  });
});
