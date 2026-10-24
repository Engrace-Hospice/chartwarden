import type { DbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { DEATH_BOARD_TEMPLATE } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import { type DeathBoardActor, createDeathBoardService } from "./death-board-service";
import { createMemoryDeathBoardStore } from "./death-board-store-memory";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const RN = "00000000-0000-4000-8000-00000000aaa1";
const NURSE2 = "00000000-0000-4000-8000-00000000bbb1";
const FORMER = "00000000-0000-4000-8000-00000000ccc1";
const SUP = "00000000-0000-4000-8000-00000000eee1";
const STRANGER = "00000000-0000-4000-8000-00000000fff1";
const P1 = "00000000-0000-4000-8000-0000000000e1";
const NOW = new Date("2026-10-14T12:00:00.000Z");

const fakeDb = {
  transaction: async (fn: (tx: unknown) => unknown) => fn({ execute: async () => undefined }),
} as unknown as DbClient;

interface Opts {
  rn?: string | null;
  team?: string[];
  former?: string[];
  inactive?: string[];
  part2Denied?: string[];
  part2Throws?: boolean;
  teamThrows?: boolean;
}

function build(o: Opts = {}) {
  const store = createMemoryDeathBoardStore(() => NOW);
  const emit = vi.fn().mockResolvedValue({ alertId: "a", resolvedRecipientCount: 1 });
  const alerts = { emit } as unknown as AlertEmitter;
  const service = createDeathBoardService({
    db: fakeDb,
    store,
    part2Gate: {
      async allowedUserIds({ userIds }) {
        if (o.part2Throws) throw new Error("gate down");
        return new Set(userIds.filter((u) => !(o.part2Denied ?? []).includes(u)));
      },
    },
    patientLabels: async (_o, ids) =>
      new Map(ids.map((id) => [id, { displayName: "Pat I.", mrnSuffix: "1234" }])),
    displayName: async (_o, u) => `user-${u.slice(-4)}`,
    isActiveUser: async (_o, u) => !(o.inactive ?? []).includes(u),
    careTeamMembers: async () => {
      if (o.teamThrows) throw new Error("seam down");
      return o.team ?? [RN, NURSE2];
    },
    primaryRn: async () => (o.rn === undefined ? RN : o.rn),
    formerTeam: async () => o.former ?? [FORMER],
    alerts,
    now: () => NOW,
  });
  return { service, store, emit };
}

const actor = (userId: string, supervisor = false): DeathBoardActor => ({
  orgId: ORG,
  userId,
  supervisor,
});
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    const err = e as { statusCode?: number; code?: string; message?: string };
    return `${err.statusCode}:${err.code ?? err.message}`;
  }
};

describe("createForDeath", () => {
  it("creates the six template items, each with exactly one owner, the primary RN first", async () => {
    const { service, store } = build();
    const out = await service.createForDeath(ORG, P1);
    expect(out.created).toBe(true);
    const items = [...store.items.values()];
    expect(items).toHaveLength(DEATH_BOARD_TEMPLATE.length);
    expect(items.every((i) => i.ownerUserId === RN && i.status === "open")).toBe(true);
    expect(store.events.every((e) => e.eventType === "created" && e.actorKind === "system")).toBe(
      true,
    );
  });

  it("is idempotent: a duplicate death event makes no second board and no second set of items", async () => {
    const { service, store } = build();
    const a = await service.createForDeath(ORG, P1);
    const b = await service.createForDeath(ORG, P1);
    expect(b).toEqual({ created: false, boardId: a.boardId });
    expect(store.boards.size).toBe(1);
    expect(store.items.size).toBe(DEATH_BOARD_TEMPLATE.length);
  });

  it("falls back to the live care team, then to the former channel members", async () => {
    expect(
      [...(await ownersOf(build({ rn: null, team: [NURSE2] })))].every((o) => o === NURSE2),
    ).toBe(true);
    expect(
      [...(await ownersOf(build({ rn: null, team: [], former: [FORMER] })))].every(
        (o) => o === FORMER,
      ),
    ).toBe(true);
  });

  it("skips inactive and Part 2-refused people, and survives a seam outage", async () => {
    const t = build({ inactive: [RN], part2Denied: [NURSE2], teamThrows: true });
    expect([...(await ownersOf(t))].every((o) => o === FORMER)).toBe(true);
  });

  it("throws, tells supervisors and writes nothing when nobody is eligible (no ownerless item, ever)", async () => {
    const { service, store, emit } = build({ inactive: [RN, NURSE2, FORMER] });
    await expect(service.createForDeath(ORG, P1)).rejects.toThrow(/no eligible owner/);
    expect(store.boards.size).toBe(0);
    expect(emit.mock.calls.some((c) => c[1].eventType === "m36.death_board.needs_owner")).toBe(
      true,
    );
  });

  it("fails closed when the Part 2 gate cannot answer", async () => {
    const { service, store } = build({ part2Throws: true });
    await expect(service.createForDeath(ORG, P1)).rejects.toThrow();
    expect(store.boards.size).toBe(0);
  });

  it("alerts the owner with fixed text that carries no patient, name or item wording", async () => {
    const { service, emit } = build();
    await service.createForDeath(ORG, P1);
    const call = emit.mock.calls.find((c) => c[1].eventType === "m36.death_board.assigned");
    expect(call?.[1].payload.ownerUserId).toBe(RN);
    const text = String(call?.[1].payload.message);
    expect(text).not.toContain(P1);
    expect(text).not.toMatch(/death|died|deceased|pronounce/i);
    expect(call?.[1].correlationId).not.toContain(P1);
  });
});

async function ownersOf(t: ReturnType<typeof build>): Promise<string[]> {
  await t.service.createForDeath(ORG, P1);
  return [...t.store.items.values()].map((i) => i.ownerUserId);
}

async function boardWith(o: Opts = {}) {
  const t = build(o);
  const { boardId } = await t.service.createForDeath(ORG, P1);
  const itemId = [...t.store.items.values()][0]!.id;
  return { ...t, boardId, itemId };
}

describe("visibility (uniform 404)", () => {
  it("shows the board to the owner, a supervisor and a live care-team member", async () => {
    const t = await boardWith();
    for (const a of [actor(RN), actor(SUP, true), actor(NURSE2)]) {
      expect((await t.service.get(a, t.boardId)).items).toHaveLength(6);
    }
  });

  it("answers the same 404 for a stranger, a missing board, a foreign-looking id and a Part 2-refused viewer", async () => {
    const t = await boardWith({ part2Denied: [NURSE2] });
    const stranger = await code(t.service.get(actor(STRANGER), t.boardId));
    expect(stranger).toBe(
      await code(t.service.get(actor(RN), "00000000-0000-4000-8000-000000000999")),
    );
    expect(stranger).toMatch(/^404/);
    expect(await code(t.service.get(actor(NURSE2), t.boardId))).toBe(stranger);
    expect(await code(t.service.get(actor(SUP, true), t.boardId))).toBe("ok");
  });

  it("fails closed for everyone, supervisors included, when the Part 2 gate cannot answer", async () => {
    const opts: Opts = {};
    const t = await boardWith(opts);
    opts.part2Throws = true;
    expect(await code(t.service.get(actor(SUP, true), t.boardId))).toMatch(/^404/);
    expect(await code(t.service.get(actor(RN), t.boardId))).toMatch(/^404/);
    expect(await t.service.list(actor(SUP, true), 25)).toHaveLength(0);
  });

  it("lists only the boards the viewer may see", async () => {
    const t = await boardWith();
    expect(await t.service.list(actor(RN), 25)).toHaveLength(1);
    expect(await t.service.list(actor(STRANGER), 25)).toHaveLength(0);
  });

  it("computes actions server-side: only the owner can complete, owner and supervisor can reassign", async () => {
    const t = await boardWith();
    const owner = (await t.service.get(actor(RN), t.boardId)).items[0]!;
    const sup = (await t.service.get(actor(SUP, true), t.boardId)).items[0]!;
    const peer = (await t.service.get(actor(NURSE2), t.boardId)).items[0]!;
    expect(owner.actions).toEqual(["complete", "reassign"]);
    expect(sup.actions).toEqual(["reassign"]);
    expect(peer.actions).toEqual([]);
  });
});

describe("complete", () => {
  it("is the owner's alone, explicit, recorded and idempotent", async () => {
    const t = await boardWith();
    expect(await code(t.service.complete(actor(NURSE2), t.itemId))).toMatch(
      /^403:DEATH_BOARD_NOT_OWNER/,
    );
    const first = await t.service.complete(actor(RN), t.itemId);
    expect(first.status).toBe("done");
    expect(first.completed_by_user_id).toBe(RN);
    const before = t.store.events.length;
    const again = await t.service.complete(actor(RN), t.itemId);
    expect(again.completed_at).toBe(first.completed_at);
    expect(t.store.events.length).toBe(before);
    expect(t.store.events.filter((e) => e.eventType === "completed")).toHaveLength(1);
  });

  it("a stranger gets the 404, not the ownership answer", async () => {
    const t = await boardWith();
    expect(await code(t.service.complete(actor(STRANGER), t.itemId))).toMatch(/^404/);
  });

  it("refuses a flagged item until it is reassigned", async () => {
    const t = await boardWith({ inactive: [], former: [] });
    await t.store.flagNeedsOwner(null as never, { orgId: ORG, itemId: t.itemId });
    expect(await code(t.service.complete(actor(RN), t.itemId))).toMatch(/^409/);
  });
});

describe("reassign", () => {
  it("moves the item to an eligible person, audits it and tells the new owner", async () => {
    const t = await boardWith();
    const out = await t.service.reassign(actor(RN), t.itemId, NURSE2);
    expect(out.owner_user_id).toBe(NURSE2);
    const ev = t.store.events.filter((e) => e.eventType === "reassigned");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      actorUserId: RN,
      fromOwnerUserId: RN,
      toOwnerUserId: NURSE2,
      reasonCode: "manual",
    });
    expect(
      t.emit.mock.calls.some(
        (c) => c[1].eventType === "m36.death_board.assigned" && c[1].payload.ownerUserId === NURSE2,
      ),
    ).toBe(true);
  });

  it("a supervisor can reassign (reason supervisor); a non-owner non-supervisor cannot", async () => {
    const t = await boardWith();
    expect(await code(t.service.reassign(actor(NURSE2), t.itemId, NURSE2))).toMatch(/^403/);
    await t.service.reassign(actor(SUP, true), t.itemId, NURSE2);
    expect(t.store.events.at(-1)?.reasonCode).toBe("supervisor");
  });

  it("is idempotent when the item is already on the target", async () => {
    const t = await boardWith();
    await t.service.reassign(actor(RN), t.itemId, NURSE2);
    const n = t.store.events.length;
    const again = await t.service.reassign(actor(SUP, true), t.itemId, NURSE2);
    expect(again.owner_user_id).toBe(NURSE2);
    expect(t.store.events.length).toBe(n);
  });

  it("refuses an inactive or Part 2-refused target with 422, and a done item with 409", async () => {
    const t = await boardWith({ inactive: [FORMER], part2Denied: [STRANGER] });
    expect(await code(t.service.reassign(actor(RN), t.itemId, FORMER))).toMatch(
      /^422:DEATH_BOARD_OWNER_INVALID/,
    );
    expect(await code(t.service.reassign(actor(RN), t.itemId, STRANGER))).toMatch(/^422/);
    await t.service.complete(actor(RN), t.itemId);
    expect(await code(t.service.reassign(actor(RN), t.itemId, NURSE2))).toMatch(/^409/);
  });

  it("a reassignment clears the needs_owner flag", async () => {
    const t = await boardWith();
    await t.store.flagNeedsOwner(null as never, { orgId: ORG, itemId: t.itemId });
    const out = await t.service.reassign(actor(SUP, true), t.itemId, NURSE2);
    expect(out.needs_owner).toBe(false);
  });
});

describe("offboarding", () => {
  it("moves every open item of the leaver to the next eligible person and records the system actor", async () => {
    const t = await boardWith();
    const out = await t.service.reassignForLeaver(ORG, RN);
    expect(out).toEqual({ reassigned: 6, flaggedNeedsOwner: 0 });
    const owners = new Set([...t.store.items.values()].map((i) => i.ownerUserId));
    expect(owners).toEqual(new Set([NURSE2]));
    expect(t.store.events.filter((e) => e.reasonCode === "offboarding")).toHaveLength(6);
    const again = await t.service.reassignForLeaver(ORG, RN);
    expect(again).toEqual({ reassigned: 0, flaggedNeedsOwner: 0 });
  });

  it("flags needs_owner and alerts supervisors when nobody can take the items; the owner is never empty", async () => {
    const t = await boardWith({ rn: RN, team: [RN], former: [] });
    const out = await t.service.reassignForLeaver(ORG, RN);
    expect(out).toEqual({ reassigned: 0, flaggedNeedsOwner: 6 });
    expect([...t.store.items.values()].every((i) => i.needsOwner && i.ownerUserId === RN)).toBe(
      true,
    );
    expect(t.emit.mock.calls.some((c) => c[1].eventType === "m36.death_board.needs_owner")).toBe(
      true,
    );
  });

  it("leaves completed items alone", async () => {
    const t = await boardWith();
    await t.service.complete(actor(RN), t.itemId);
    const out = await t.service.reassignForLeaver(ORG, RN);
    expect(out.reassigned).toBe(5);
    expect(t.store.items.get(t.itemId)?.ownerUserId).toBe(RN);
  });
});
