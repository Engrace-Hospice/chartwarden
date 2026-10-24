// WP 4.10 (ADR-0077) - the snooze / reminder service, adversarially: an urgent conversation is refused on every path (also one whose
// request opened AFTER the snooze), the hard bounds hold at their exact edges, the owner and the tenant are never crossed, an expired
// snooze reads as ended, a repeat is idempotent, and a feature that is off is one uniform 404.
import {
  ChartWardenError,
  NotFoundError,
  REMINDER_MAX_PENDING,
  SNOOZE_MAX_MINUTES,
  SNOOZE_MIN_MINUTES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { type Actor, createSnoozeReminderService } from "./snooze-reminder-service";
import { createMemorySnoozeReminderStore } from "./snooze-reminder-test-kit";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const ME: Actor = { orgId: ORG, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const PEER: Actor = { orgId: ORG, userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const OUTSIDER: Actor = { orgId: OTHER_ORG, userId: ME.userId };
const CH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MSG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const URGENT_MSG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const T0 = new Date("2026-10-18T12:00:00.000Z");
const MIN = 60_000;
const key = (a: Actor, channelId = CH) => `${a.orgId}:${a.userId}:${channelId}`;

function setup(options: { enabled?: boolean; visible?: boolean } = {}) {
  let now = T0;
  const kit = createMemorySnoozeReminderStore({
    messages: new Map([
      [`${ORG}:${MSG}`, { channelId: CH }],
      [`${ORG}:${URGENT_MSG}`, { channelId: CH, urgent: true }],
    ]),
  });
  const viewChecks: string[] = [];
  const service = createSnoozeReminderService({
    isEnabled: async () => options.enabled !== false,
    store: kit.store,
    canViewChannel: async (_org, user) => {
      viewChecks.push(user);
      return options.visible !== false;
    },
    now: () => now,
  });
  return {
    service,
    kit,
    viewChecks,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof ChartWardenError ? e.code : "OTHER";
  }
  return "NO_ERROR";
};

describe("snooze: urgent and acknowledgment-bound conversations are never snoozable", () => {
  it("is refused with the typed 409 while the caller is in an open request, and writes nothing", async () => {
    const { service, kit } = setup();
    kit.openRequests.add(key(ME));
    await expect(service.snooze(ME, CH, 60)).rejects.toMatchObject({
      code: "SNOOZE_URGENT_NOT_ALLOWED",
      statusCode: 409,
    });
    expect(kit.snoozes.size).toBe(0);
    expect((await service.getSnooze(ME, CH)).snoozable).toBe(false);
  });

  it("a request opened AFTER the snooze voids it: reads as not snoozed and cannot be re-snoozed", async () => {
    const { service, kit } = setup();
    await service.snooze(ME, CH, 120);
    expect((await service.getSnooze(ME, CH)).snoozed_until).not.toBeNull();
    kit.openRequests.add(key(ME));
    const view = await service.getSnooze(ME, CH);
    expect(view).toEqual({ channel_id: CH, snoozed_until: null, snoozable: false });
    expect(await codeOf(service.snooze(ME, CH, 30))).toBe("SNOOZE_URGENT_NOT_ALLOWED");
  });

  it("a request that opens between the check and the write is still refused (the store re-checks)", async () => {
    const { service, kit } = setup();
    // The service's own pre-read says "no request"; the write then finds one.
    const real = kit.store.setSnooze;
    kit.store.setSnooze = async (...args) => {
      kit.openRequests.add(key(ME));
      return real(...args);
    };
    expect(await codeOf(service.snooze(ME, CH, 60))).toBe("SNOOZE_URGENT_NOT_ALLOWED");
  });

  it("ending a snooze is always allowed, even with an open request", async () => {
    const { service, kit } = setup();
    await service.snooze(ME, CH, 60);
    kit.openRequests.add(key(ME));
    expect(await service.clearSnooze(ME, CH)).toEqual({ cleared: true });
  });

  it("another user's open request does not stop me; mine does not stop them", async () => {
    const { service, kit } = setup();
    kit.openRequests.add(key(PEER));
    await expect(service.snooze(ME, CH, 60)).resolves.toMatchObject({ snoozable: true });
    expect(await codeOf(service.snooze(PEER, CH, 60))).toBe("SNOOZE_URGENT_NOT_ALLOWED");
  });
});

describe("snooze: the duration is bounded at both edges", () => {
  it.each([SNOOZE_MIN_MINUTES, 60, SNOOZE_MAX_MINUTES])("accepts %i minutes", async (minutes) => {
    const { service } = setup();
    const view = await service.snooze(ME, CH, minutes);
    expect(new Date(view.snoozed_until as string).getTime()).toBe(T0.getTime() + minutes * MIN);
  });

  it.each([
    SNOOZE_MIN_MINUTES - 1,
    SNOOZE_MAX_MINUTES + 1,
    0,
    -5,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "60" as unknown as number,
    null as unknown as number,
  ])("refuses %s", async (minutes) => {
    const { service, kit } = setup();
    expect(await codeOf(service.snooze(ME, CH, minutes))).toBe("SNOOZE_DURATION_INVALID");
    expect(kit.snoozes.size).toBe(0);
  });

  it("the hard maximum is 24 hours", () => {
    expect(SNOOZE_MAX_MINUTES).toBe(1440);
  });

  it("re-snoozing replaces the window (an extension cannot exceed the maximum from now)", async () => {
    const { service, advance } = setup();
    await service.snooze(ME, CH, SNOOZE_MAX_MINUTES);
    advance(10 * MIN);
    const view = await service.snooze(ME, CH, SNOOZE_MAX_MINUTES);
    expect(new Date(view.snoozed_until as string).getTime()).toBe(
      T0.getTime() + 10 * MIN + SNOOZE_MAX_MINUTES * MIN,
    );
  });
});

describe("snooze: expiry, ownership, tenancy, flag, visibility", () => {
  it("a snooze that has run out reads as ended, exactly at its end instant", async () => {
    const { service, advance } = setup();
    await service.snooze(ME, CH, 60);
    advance(60 * MIN - 1);
    expect((await service.getSnooze(ME, CH)).snoozed_until).not.toBeNull();
    advance(1);
    expect((await service.getSnooze(ME, CH)).snoozed_until).toBeNull();
  });

  it("never shows or clears another user's snooze", async () => {
    const { service } = setup();
    await service.snooze(ME, CH, 60);
    expect((await service.getSnooze(PEER, CH)).snoozed_until).toBeNull();
    expect(await service.clearSnooze(PEER, CH)).toEqual({ cleared: false });
    expect((await service.getSnooze(ME, CH)).snoozed_until).not.toBeNull();
  });

  it("never shows a snooze across tenants (same user id, other organisation)", async () => {
    const { service } = setup();
    await service.snooze(ME, CH, 60);
    expect((await service.getSnooze(OUTSIDER, CH)).snoozed_until).toBeNull();
  });

  it("an invisible conversation is the uniform 404 and writes nothing", async () => {
    const { service, kit } = setup({ visible: false });
    await expect(service.snooze(ME, CH, 60)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.getSnooze(ME, CH)).rejects.toBeInstanceOf(NotFoundError);
    expect(kit.snoozes.size).toBe(0);
  });

  it("with the flag off every call is the uniform 404 and nothing is looked up or written", async () => {
    const { service, kit, viewChecks } = setup({ enabled: false });
    for (const call of [
      () => service.getSnooze(ME, CH),
      () => service.snooze(ME, CH, 60),
      () => service.clearSnooze(ME, CH),
      () => service.setReminder(ME, MSG, new Date(T0.getTime() + 2 * MIN).toISOString()),
      () => service.clearReminder(ME, MSG),
      () => service.listReminders(ME),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(viewChecks).toEqual([]);
    expect(kit.snoozes.size + kit.reminders.size).toBe(0);
  });

  it("a flag read that throws is a failure, never a fake 404 or a fake success", async () => {
    const kit = createMemorySnoozeReminderStore();
    const service = createSnoozeReminderService({
      isEnabled: async () => {
        throw new Error("flag store down");
      },
      store: kit.store,
      canViewChannel: async () => true,
    });
    await expect(service.snooze(ME, CH, 60)).rejects.toThrow("flag store down");
  });

  it("a repeat of the same snooze is idempotent: one row, the same end", async () => {
    const { service, kit } = setup();
    const first = await service.snooze(ME, CH, 60);
    const again = await service.snooze(ME, CH, 60);
    expect(again).toEqual(first);
    expect(kit.snoozes.size).toBe(1);
  });
});

describe("reminders", () => {
  const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();

  it("accepts exactly 1 minute and exactly 30 days ahead, refuses a millisecond outside", async () => {
    const { service } = setup();
    await expect(service.setReminder(ME, MSG, at(MIN))).resolves.toMatchObject({ message_id: MSG });
    await expect(service.setReminder(ME, MSG, at(30 * 24 * 60 * MIN))).resolves.toBeDefined();
    expect(await codeOf(service.setReminder(ME, MSG, at(MIN - 1)))).toBe("REMINDER_TIME_INVALID");
    expect(await codeOf(service.setReminder(ME, MSG, at(30 * 24 * 60 * MIN + 1)))).toBe(
      "REMINDER_TIME_INVALID",
    );
    expect(await codeOf(service.setReminder(ME, MSG, at(-MIN)))).toBe("REMINDER_TIME_INVALID");
  });

  it.each([
    "2026-10-18T13:00:00", // no offset: would be read in the server's zone
    "tomorrow",
    "2026-13-45T25:61:00Z",
    "",
  ])("refuses the time %j", async (raw) => {
    const { service, kit } = setup();
    expect(await codeOf(service.setReminder(ME, MSG, raw))).toBe("REMINDER_TIME_INVALID");
    expect(kit.reminders.size).toBe(0);
  });

  it("reads a numeric offset as the same instant (a viewer in another zone, across a DST change)", async () => {
    const { service } = setup();
    // 13:00 at -05:00 is 18:00Z, 6 hours after T0.
    const view = await service.setReminder(ME, MSG, "2026-10-18T13:00:00-05:00");
    expect(view.remind_at).toBe("2026-10-18T18:00:00.000Z");
  });

  it("is refused on an urgent message (typed 409), writing nothing", async () => {
    const { service, kit } = setup();
    await expect(service.setReminder(ME, URGENT_MSG, at(2 * MIN))).rejects.toMatchObject({
      code: "REMINDER_URGENT_NOT_ALLOWED",
      statusCode: 409,
    });
    expect(kit.reminders.size).toBe(0);
  });

  it("holds at most REMINDER_MAX_PENDING: the next is a typed 409; replacing an existing one still works", async () => {
    const { service, kit } = setup();
    const ids = Array.from(
      { length: REMINDER_MAX_PENDING + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    for (const id of ids) kit.messages.set(`${ORG}:${id}`, { channelId: CH });
    for (const id of ids.slice(0, REMINDER_MAX_PENDING)) {
      await service.setReminder(ME, id, at(2 * MIN));
    }
    await expect(
      service.setReminder(ME, ids[REMINDER_MAX_PENDING] as string, at(2 * MIN)),
    ).rejects.toMatchObject({ code: "REMINDER_LIMIT_REACHED", statusCode: 409 });
    // Re-setting one that already counts is not a new reminder.
    await expect(service.setReminder(ME, ids[0] as string, at(9 * MIN))).resolves.toBeDefined();
    // The cap is per user: a colleague is unaffected.
    await expect(
      service.setReminder(PEER, ids[REMINDER_MAX_PENDING] as string, at(2 * MIN)),
    ).resolves.toBeDefined();
  });

  it("is idempotent for the same message: one row, the time is replaced", async () => {
    const { service, kit } = setup();
    const first = await service.setReminder(ME, MSG, at(2 * MIN));
    const again = await service.setReminder(ME, MSG, at(5 * MIN));
    expect(again.id).toBe(first.id);
    expect(again.remind_at).toBe(at(5 * MIN));
    expect(kit.reminders.size).toBe(1);
  });

  it("is the caller's own: lists, cancels and counts never cross users or tenants", async () => {
    const { service } = setup();
    await service.setReminder(ME, MSG, at(2 * MIN));
    expect((await service.listReminders(PEER)).reminders).toEqual([]);
    expect((await service.listReminders(OUTSIDER)).reminders).toEqual([]);
    expect(await service.clearReminder(PEER, MSG)).toEqual({ cleared: false });
    expect(await service.clearReminder(ME, MSG)).toEqual({ cleared: true });
    expect(await service.clearReminder(ME, MSG)).toEqual({ cleared: false });
  });

  it("a missing or other-tenant message, and one in an invisible conversation, are the same 404", async () => {
    const { service } = setup();
    const unknown = "99999999-9999-4999-8999-999999999999";
    await expect(service.setReminder(ME, unknown, at(2 * MIN))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.setReminder(OUTSIDER, MSG, at(2 * MIN))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const hidden = setup({ visible: false });
    await expect(hidden.service.setReminder(ME, MSG, at(2 * MIN))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
