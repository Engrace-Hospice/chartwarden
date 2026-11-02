import type { DbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { DEATH_NOTIFICATION_INTERNAL_KINDS } from "@chartwarden/types";
import { PLATFORM_DEFAULT_ALERT_RULES } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import type { DeathBoardActor } from "../death-board/death-board-service";
import {
  DEATH_NOTIFICATION_DEFERRED_ROLE_KINDS,
  DEATH_NOTIFICATION_ROLE_KEYS,
  DEATH_NOTIFICATION_TEXT,
} from "./death-notification-alerts";
import { createDeathNotificationService } from "./death-notification-service";
import { createMemoryDeathNotificationStore } from "./death-notification-store-memory";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const BOARD = "00000000-0000-4000-8000-0000000000b1";
const PATIENT = "00000000-0000-4000-8000-0000000000e1";
const ATT = "00000000-0000-4000-8000-00000000aaa1";
const OTHER = "00000000-0000-4000-8000-00000000fff1";
const SUP = "00000000-0000-4000-8000-00000000eee1";
const FH = "00000000-0000-4000-8000-00000000f001";
const NOW = new Date("2026-10-14T12:00:00.000Z");

const fakeDb = {
  transaction: async (fn: (tx: unknown) => unknown) => fn({ execute: async () => undefined }),
} as unknown as DbClient;

interface Opts {
  attending?: string | null;
  baa?: boolean;
  baaThrows?: boolean;
  noLinks?: boolean;
  linkThrows?: boolean;
  resolved?: number;
  roles?: string[];
  flag?: boolean;
  viewDenied?: boolean;
}

function build(o: Opts = {}) {
  let clock = NOW;
  const store = createMemoryDeathNotificationStore(() => clock);
  const emit = vi.fn().mockResolvedValue({ alertId: "a", resolvedRecipientCount: o.resolved ?? 1 });
  const publish = vi.fn().mockResolvedValue(undefined);
  const issue = vi.fn(async () => {
    if (o.linkThrows) throw new Error("mail down");
  });
  const service = createDeathNotificationService({
    db: fakeDb,
    store,
    alerts: { emit } as unknown as AlertEmitter,
    outbox: { publish } as never,
    boardPatient: async (_o, b) => (b === BOARD ? PATIENT : null),
    viewBoard: async () => {
      if (o.viewDenied) throw new Error("404");
      return { patient_id: PATIENT };
    },
    attendingUserId: async () => (o.attending === undefined ? ATT : o.attending),
    isActiveUser: async () => true,
    roleKeysForUser: async () => o.roles ?? [],
    isBaaActive: async () => {
      if (o.baaThrows) throw new Error("mdm down");
      return o.baa ?? true;
    },
    ...(o.noLinks ? {} : { funeralLinks: { issue } }),
    isEnabled: async () => o.flag ?? true,
    now: () => clock,
  });
  return { service, store, emit, publish, issue, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}
const actor = (userId: string, supervisor = false): DeathBoardActor => ({ orgId: ORG, userId, supervisor });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    const err = e as { statusCode?: number; code?: string; message?: string };
    return `${err.statusCode}:${err.code ?? err.message}`;
  }
};

describe("fanOutInternal", () => {
  it("creates one row and one fixed-text notice per internal kind, and marks them sent", async () => {
    const { service, store, emit, publish } = build();
    const out = await service.fanOutInternal(ORG, BOARD, "evt-1");
    expect(out.notified).toBe(DEATH_NOTIFICATION_INTERNAL_KINDS.length);
    expect([...store.rows.values()].every((r) => r.state === "sent")).toBe(true);
    expect(emit).toHaveBeenCalledTimes(DEATH_NOTIFICATION_INTERNAL_KINDS.length);
    for (const [, input] of emit.mock.calls) {
      expect(input.payload.message).toBe(DEATH_NOTIFICATION_TEXT.notice);
      expect(JSON.stringify(input)).not.toContain(PATIENT);
    }
    expect(publish).toHaveBeenCalledTimes(DEATH_NOTIFICATION_INTERNAL_KINDS.length);
  });

  it("is idempotent: a replay creates no second row, alert or event", async () => {
    const { service, store, emit, publish } = build();
    await service.fanOutInternal(ORG, BOARD, "evt-1");
    const again = await service.fanOutInternal(ORG, BOARD, "evt-2");
    expect(again.notified).toBe(0);
    expect(store.rows.size).toBe(DEATH_NOTIFICATION_INTERNAL_KINDS.length);
    expect(emit).toHaveBeenCalledTimes(DEATH_NOTIFICATION_INTERNAL_KINDS.length);
    expect(publish).toHaveBeenCalledTimes(DEATH_NOTIFICATION_INTERNAL_KINDS.length);
  });

  it("does nothing when the flag is off", async () => {
    const { service, store, emit } = build({ flag: false });
    expect((await service.fanOutInternal(ORG, BOARD, "e")).notified).toBe(0);
    expect(store.rows.size).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("falls back to the tenant admins when nobody resolves, and still records the notice", async () => {
    const { service, emit } = build({ resolved: 0 });
    await service.fanOutInternal(ORG, BOARD, "e");
    const types = emit.mock.calls.map((c) => c[1].eventType as string);
    expect(types).toContain("m30.alerts.recipient_fallback");
  });

  it("treats a missing attending as unassigned (still notifies the role fallback)", async () => {
    const { service, store } = build({ attending: null });
    await service.fanOutInternal(ORG, BOARD, "e");
    const att = [...store.rows.values()].find((r) => r.recipientKind === "attending");
    expect(att?.recipientRef).toBe("unassigned");
  });

  it("throws (retry) for an unknown board", async () => {
    const { service } = build();
    await expect(service.fanOutInternal(ORG, "00000000-0000-4000-8000-0000000000ff", "e")).rejects.toThrow();
  });

  it("role keys in the notices match the seeded alert rules (deferred kinds have none)", () => {
    for (const [kind, keys] of Object.entries(DEATH_NOTIFICATION_ROLE_KEYS)) {
      const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === `m36.death_notification.${kind}`);
      if (DEATH_NOTIFICATION_DEFERRED_ROLE_KINDS.includes(kind as never)) {
        expect(keys).toEqual([]);
        expect(rule).toBeUndefined();
      } else {
        expect(rule?.resolverArgs).toMatchObject({ roleKeys: keys });
      }
    }
  });

  it("sends pharmacy and DME straight to the tenant-admin fallback, never a role lookup", async () => {
    const { service, emit } = build();
    await service.fanOutInternal(ORG, BOARD, "e");
    const types = emit.mock.calls.map((c) => c[1].eventType as string);
    expect(types).not.toContain("m36.death_notification.pharmacy_liaison");
    expect(types).not.toContain("m36.death_notification.dme_liaison");
    expect(types.filter((t) => t === "m30.alerts.recipient_fallback")).toHaveLength(2);
  });
});

describe("ack", () => {
  async function seeded(o: Opts = {}) {
    const ctx = build(o);
    await ctx.service.fanOutInternal(ORG, BOARD, "e");
    const rows = [...ctx.store.rows.values()];
    const id = (k: string) => rows.find((r) => r.recipientKind === k)!.id;
    return { ...ctx, id };
  }

  it("the named attending acknowledges explicitly, and a repeat is idempotent", async () => {
    const { service, id, publish } = await seeded();
    const dto = await service.ack(actor(ATT), id("attending"));
    expect(dto.state).toBe("acked");
    expect(dto.acked_by).toBe(ATT);
    const calls = publish.mock.calls.length;
    expect((await service.ack(actor(ATT), id("attending"))).state).toBe("acked");
    expect(publish.mock.calls.length).toBe(calls);
  });

  it("refuses someone who is not the recipient", async () => {
    const { service, id } = await seeded();
    expect(await code(service.ack(actor(OTHER), id("attending")))).toBe("403:DEATH_NOTIFICATION_NOT_RECIPIENT");
  });

  it("a role holder acknowledges a role notice; a non-holder cannot; a supervisor can", async () => {
    const { service, id } = await seeded({ roles: ["medical_director"] });
    expect((await service.ack(actor(OTHER), id("medical_director"))).state).toBe("acked");
    expect(await code(service.ack(actor(OTHER), id("billing_lead")))).toBe("403:DEATH_NOTIFICATION_NOT_RECIPIENT");
    expect((await service.ack(actor(SUP, true), id("billing_lead"))).state).toBe("acked");
  });

  it("a second person cannot take over an acknowledged notice", async () => {
    const { service, id } = await seeded();
    await service.ack(actor(ATT), id("attending"));
    expect(await code(service.ack(actor(SUP, true), id("attending")))).toBe("403:DEATH_NOTIFICATION_NOT_RECIPIENT");
  });

  it("refuses list and send for a viewer who cannot see the board", async () => {
    const { service } = build({ viewDenied: true });
    await expect(service.list(actor(OTHER), BOARD)).rejects.toThrow();
    await expect(
      service.sendFuneralHome(actor(OTHER), BOARD, {
        funeralHomeEntityId: FH,
        recipientEmail: "a@b.example",
      }),
    ).rejects.toThrow();
  });
});

describe("sendFuneralHome", () => {
  const input = { funeralHomeEntityId: FH, recipientEmail: "director@funeral.example" };

  it("with a BAA on file sends the link once and is idempotent", async () => {
    const { service, issue, publish } = build({ baa: true });
    const dto = await service.sendFuneralHome(actor(SUP, true), BOARD, input);
    expect(dto.state).toBe("sent");
    expect(issue).toHaveBeenCalledTimes(1);
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ patientId: PATIENT, recipientEmail: input.recipientEmail }));
    await service.sendFuneralHome(actor(SUP, true), BOARD, input);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("without a BAA records blocked_no_baa, alerts a supervisor and sends nothing", async () => {
    const { service, issue, emit, publish } = build({ baa: false });
    const dto = await service.sendFuneralHome(actor(SUP, true), BOARD, input);
    expect(dto.state).toBe("blocked_no_baa");
    expect(issue).not.toHaveBeenCalled();
    expect(emit.mock.calls[0]![1].eventType).toBe("m36.death_notification.blocked_no_baa");
    expect(publish.mock.calls[0]![1].eventName).toBe("m36.death_notification.blocked");
    // a repeat while still blocked publishes no second blocked event
    await service.sendFuneralHome(actor(SUP, true), BOARD, input);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the BAA lookup throws", async () => {
    const { service, issue } = build({ baaThrows: true });
    expect((await service.sendFuneralHome(actor(SUP, true), BOARD, input)).state).toBe("blocked_no_baa");
    expect(issue).not.toHaveBeenCalled();
  });

  it("later succeeds once the BAA is recorded (blocked -> sent)", async () => {
    const ctx = build({ baa: false });
    await ctx.service.sendFuneralHome(actor(SUP, true), BOARD, input);
    const ok = build({ baa: true });
    await ok.service.sendFuneralHome(actor(SUP, true), BOARD, input);
    expect([...ok.store.rows.values()][0]?.state).toBe("sent");
  });

  it("is a typed 503 when the link channel is not bound, and writes nothing", async () => {
    const { service, store } = build({ noLinks: true });
    expect(await code(service.sendFuneralHome(actor(SUP, true), BOARD, input))).toBe("503:DEATH_NOTIFICATION_LINK_UNAVAILABLE");
    expect(store.rows.size).toBe(0);
  });

  it("marks the row failed when delivery throws", async () => {
    const { service, store } = build({ linkThrows: true });
    expect(await code(service.sendFuneralHome(actor(SUP, true), BOARD, input))).toBe("503:DEATH_NOTIFICATION_LINK_FAILED");
    expect([...store.rows.values()][0]?.state).toBe("failed");
  });

  it("carries no PHI in the blocked alert", async () => {
    const { service, emit } = build({ baa: false });
    await service.sendFuneralHome(actor(SUP, true), BOARD, input);
    expect(JSON.stringify(emit.mock.calls)).not.toContain(PATIENT);
    expect(JSON.stringify(emit.mock.calls)).not.toContain("funeral.example");
  });
});

describe("flagUnackedForOrg", () => {
  it("alerts supervisors only for notices older than the threshold, and not for acked ones", async () => {
    const { service, emit, advance, store } = build();
    await service.fanOutInternal(ORG, BOARD, "e");
    emit.mockClear();
    expect((await service.flagUnackedForOrg(ORG)).examined).toBe(0);
    advance(121 * 60_000);
    const att = [...store.rows.values()].find((r) => r.recipientKind === "attending")!;
    await service.ack(actor(ATT), att.id);
    const out = await service.flagUnackedForOrg(ORG);
    expect(out.examined).toBe(DEATH_NOTIFICATION_INTERNAL_KINDS.length - 1);
    expect(emit.mock.calls.every((c) => c[1].eventType === "m36.death_notification.unacked")).toBe(true);
  });
});
