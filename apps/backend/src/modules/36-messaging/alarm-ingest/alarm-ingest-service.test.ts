import { createHash } from "node:crypto";
import type { AlarmMappingInput } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import { alarmKeyId, signAlarmRequest } from "./alarm-ingest-core";
import { createAlarmIngestService } from "./alarm-ingest-service";
import { fakeAlarmCipher as cipher, makeFakeAlarmIngestStore as makeStore } from "./alarm-ingest-fake-store";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const USER = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-23T12:00:00.000Z");
const TS = String(Math.floor(NOW.getTime() / 1000));
const ACTOR = { organizationId: ORG, userId: USER };

const MAPPINGS: AlarmMappingInput[] = [
  { alarmKind: "bed_exit", alertType: "alarm_ingest.patient_sensor", severityCeiling: "warn" },
  { alarmKind: "call", alertType: "alarm_ingest.nurse_call", severityCeiling: "info" },
];

async function setup(opts: { emit?: ReturnType<typeof vi.fn> } = {}) {
  let flag = true;
  const { store, events } = makeStore();
  const emit =
    opts.emit ?? vi.fn(async () => ({ alertId: "alert-1", resolvedRecipientCount: 2 }));
  const warn = vi.fn();
  const svc = createAlarmIngestService({
    store,
    cipher,
    alerts: () => ({ emit }) as never,
    flags: { forOrg: async () => ({ "messaging.alarm_ingest": flag }) },
    now: () => NOW,
    warn,
  });
  const created = await svc.create(ACTOR, { name: "Ward 2 bed sensors", mappings: MAPPINGS });
  const send = (
    body: unknown,
    over: { secret?: string; keyId?: string; timestamp?: string; signature?: unknown; ip?: string } = {},
  ) => {
    const rawBody = typeof body === "string" ? body : JSON.stringify(body);
    const keyId = over.keyId ?? created.keyId;
    const timestamp = over.timestamp ?? TS;
    return svc.ingest({
      keyId,
      timestamp,
      rawBody,
      signature:
        "signature" in over
          ? over.signature
          : signAlarmRequest({ secret: over.secret ?? created.secret, keyId, timestamp, rawBody }),
      ip: over.ip ?? "203.0.113.5",
    });
  };
  return { svc, created, send, emit, events, warn, setFlag: (on: boolean) => void (flag = on) };
}

const refusal = { name: "UnauthorizedError", message: "Alarm request refused" };

describe("alarm ingest: the sender credential", () => {
  it("create returns the secret once, stores it sealed, and never returns it from list", async () => {
    const { svc, created } = await setup();
    expect(created.secret).toMatch(/^wxas_/);
    expect(created.keyId).toBe(alarmKeyId(ORG, created.id));
    const listed = await svc.list(ACTOR);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    expect(listed[0]).not.toHaveProperty("secret");
  });

  it("refuses to create or rotate while the tenant flag is off, but still lists and disables", async () => {
    const on = await setup();
    const { svc, store } = (() => {
      const m = makeStore();
      return {
        store: m.store,
        svc: createAlarmIngestService({
          store: m.store,
          cipher,
          alerts: () => ({ emit: vi.fn() }) as never,
          flags: { forOrg: async () => ({}) },
        }),
      };
    })();
    await expect(svc.create(ACTOR, { name: "x", mappings: MAPPINGS })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(svc.rotate(ACTOR, on.created.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.list(ACTOR)).resolves.toEqual([]);
    expect(await store.listSources(ACTOR)).toEqual([]);
    await expect(on.svc.disable(ACTOR, on.created.id)).resolves.toMatchObject({ enabled: false });
  });

  it("validates mappings: closed alert types, info or warn ceilings only, no repeats, bounded", async () => {
    const { svc } = await setup();
    const base = { alarmKind: "x", alertType: "alarm_ingest.equipment", severityCeiling: "warn" };
    const bad = [
      { name: "", mappings: [base] },
      { name: "ok", mappings: [] },
      { name: "ok", mappings: [{ ...base, alertType: "m36.message.urgent_sent" }] },
      { name: "ok", mappings: [{ ...base, alertType: "m36.ack.requested" }] },
      { name: "ok", mappings: [{ ...base, alertType: "sos.triggered" }] },
      { name: "ok", mappings: [{ ...base, severityCeiling: "critical" }] },
      { name: "ok", mappings: [{ ...base, alarmKind: "Bad Kind" }] },
      { name: "ok", mappings: [base, base] },
    ];
    for (const body of bad) {
      await expect(svc.create(ACTOR, body), JSON.stringify(body)).rejects.toMatchObject({
        statusCode: 422,
      });
    }
  });

  it("rotation replaces the secret: the old one stops verifying at once and the new one works", async () => {
    const { svc, created, send } = await setup();
    const rotated = await svc.rotate(ACTOR, created.id);
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.secretGeneration).toBe(2);
    await expect(send({ eventId: "a1", alarmKind: "call" })).rejects.toMatchObject(refusal);
    await expect(
      send({ eventId: "a1", alarmKind: "call" }, { secret: rotated.secret }),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it("a disabled source refuses everything, and cannot be rotated", async () => {
    const { svc, created, send } = await setup();
    await svc.disable(ACTOR, created.id);
    await expect(send({ eventId: "a1", alarmKind: "call" })).rejects.toMatchObject(refusal);
    await expect(svc.rotate(ACTOR, created.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.disable(ACTOR, created.id)).resolves.toMatchObject({ enabled: false });
  });
});

describe("alarm ingest: inbound authentication (one refusal for everything)", () => {
  it("unknown credential, wrong secret, other tenant, bad shape, stale timestamp, flag off: the SAME refusal", async () => {
    const { created, send } = await setup();
    const body = { eventId: "a1", alarmKind: "call" };
    const stale = String(Number(TS) - 301);
    const cases: Parameters<typeof send>[1][] = [
      { secret: "wxas_wrong" },
      { keyId: alarmKeyId(ORG, "55555555-5555-4555-8555-555555555555") },
      { keyId: alarmKeyId(OTHER_ORG, created.id) },
      { keyId: "not-a-key-id" },
      { timestamp: stale },
      { timestamp: "later" },
      { signature: undefined },
      { signature: "v1=abc" },
      { signature: `v1=${"0".repeat(64)}` },
    ];
    const seen = new Set<string>();
    for (const c of cases) {
      const err = await send(body, c).catch((e) => e);
      expect(err, JSON.stringify(c)).toMatchObject({ statusCode: 401, ...refusal });
      seen.add(JSON.stringify({ code: err.code, message: err.message, status: err.statusCode }));
    }
    expect(seen.size).toBe(1);
    const off = await setup();
    off.setFlag(false);
    const err = await off.send(body).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 401, ...refusal });
  });

  it("a body that is not a string is refused before anything is read", async () => {
    const { svc, created } = await setup();
    await expect(
      svc.ingest({ keyId: created.keyId, timestamp: TS, signature: "v1=" + "0".repeat(64), rawBody: undefined, ip: "x" }),
    ).rejects.toMatchObject(refusal);
  });

  it("the signature binds the body: a tampered body with the old signature is refused", async () => {
    const { created, send } = await setup();
    const rawBody = JSON.stringify({ eventId: "a1", alarmKind: "call" });
    const signature = signAlarmRequest({ secret: created.secret, keyId: created.keyId, timestamp: TS, rawBody });
    const tampered = JSON.stringify({ eventId: "a1", alarmKind: "bed_exit" });
    await expect(send(tampered, { signature })).rejects.toMatchObject(refusal);
  });
});

describe("alarm ingest: budgets", () => {
  it("the per-address budget answers 429 before any lookup; the per-source budget after a proven signature", async () => {
    const m = makeStore();
    const load = vi.spyOn(m.store, "loadSource");
    const svc = createAlarmIngestService({
      store: m.store,
      cipher,
      alerts: () => ({ emit: vi.fn(async () => ({ alertId: "a", resolvedRecipientCount: 1 })) }) as never,
      flags: { forOrg: async () => ({ "messaging.alarm_ingest": true }) },
      now: () => NOW,
      ipLimiter: { consume: async (k) => ({ allowed: k !== "blocked-ip" }) },
      sourceLimiter: { consume: async () => ({ allowed: false }) },
    });
    const created = await svc.create(ACTOR, { name: "n", mappings: MAPPINGS });
    const rawBody = JSON.stringify({ eventId: "a1", alarmKind: "call" });
    const signed = signAlarmRequest({ secret: created.secret, keyId: created.keyId, timestamp: TS, rawBody });
    await expect(
      svc.ingest({ keyId: created.keyId, timestamp: TS, signature: signed, rawBody, ip: "blocked-ip" }),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(load).not.toHaveBeenCalled();
    await expect(
      svc.ingest({ keyId: created.keyId, timestamp: TS, signature: signed, rawBody, ip: "ok-ip" }),
    ).rejects.toMatchObject({ statusCode: 429 });
    // a forged signature never reaches the per-source budget (it cannot be used to exhaust a real sender's budget)
    await expect(
      svc.ingest({ keyId: created.keyId, timestamp: TS, signature: `v1=${"1".repeat(64)}`, rawBody, ip: "ok-ip" }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("alarm ingest: strict body", () => {
  it("refuses extra fields, free text, bad ids, bad kinds, a wild severity and a far-off device clock", async () => {
    const { send, events } = await setup();
    const bad = [
      "not json",
      "[]",
      { eventId: "a1" },
      { alarmKind: "call" },
      { eventId: "a1", alarmKind: "call", note: "Mrs Jones in room 4 has fallen" },
      { eventId: "a1", alarmKind: "call", patient: "x" },
      { eventId: "a b", alarmKind: "call" },
      { eventId: "a".repeat(65), alarmKind: "call" },
      { eventId: "a1", alarmKind: "Call!" },
      { eventId: "a1", alarmKind: "call", severity: "emergency" },
      { eventId: "a1", alarmKind: "call", occurredAt: "yesterday" },
      { eventId: "a1", alarmKind: "call", occurredAt: "2020-01-01T00:00:00Z" },
    ];
    for (const body of bad) {
      await expect(send(body), JSON.stringify(body)).rejects.toMatchObject({ statusCode: 422 });
    }
    expect(events).toHaveLength(0);
  });

  it("accepts an optional device time near the server clock", async () => {
    const { send } = await setup();
    await expect(
      send({ eventId: "a1", alarmKind: "call", occurredAt: "2026-10-23T11:59:00Z" }),
    ).resolves.toMatchObject({ status: "accepted" });
  });
});

describe("alarm ingest: an alarm becomes an ordinary alert, capped and idempotent", () => {
  it("emits the mapped catalog type with a fixed generic message and ids only", async () => {
    const { send, emit } = await setup();
    const result = await send({ eventId: "bed-9", alarmKind: "bed_exit", severity: "warn" });
    expect(result).toEqual({ status: "accepted", outcome: "alerted" });
    expect(emit).toHaveBeenCalledTimes(1);
    const [org, input] = emit.mock.calls[0]!;
    expect(org).toBe(ORG);
    expect(input).toMatchObject({
      eventType: "alarm_ingest.patient_sensor",
      severity: "warn",
      correlationId: "alarm:ev-1",
    });
    expect(Object.keys(input.payload).sort()).toEqual(
      ["alarmEventId", "alarmKind", "eventType", "message", "sourceId"].sort(),
    );
    expect(input.payload.message).toMatch(/does not replace the nurse-call/);
  });

  it("caps severity at the mapping ceiling: a sender asking for critical gets warn, or info under an info ceiling", async () => {
    const { send, emit } = await setup();
    await send({ eventId: "a1", alarmKind: "bed_exit", severity: "critical" });
    await send({ eventId: "a2", alarmKind: "call", severity: "critical" });
    await send({ eventId: "a3", alarmKind: "bed_exit" });
    expect(emit.mock.calls.map((c) => c[1].severity)).toEqual(["warn", "info", "info"]);
    expect(emit.mock.calls.every((c) => c[1].severity !== "critical")).toBe(true);
  });

  it("a replay of the same event id alerts once and answers duplicate", async () => {
    const { send, emit } = await setup();
    await send({ eventId: "dup", alarmKind: "call" });
    await expect(send({ eventId: "dup", alarmKind: "call" })).resolves.toEqual({
      status: "duplicate",
      outcome: "alerted",
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("the same event id with a different body is a 409, never a second alert", async () => {
    const { send, emit } = await setup();
    await send({ eventId: "dup", alarmKind: "call" });
    await expect(send({ eventId: "dup", alarmKind: "call", severity: "warn" })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("an unmapped alarm kind is recorded and refused 422 (a visible count), and never alerts", async () => {
    const { send, emit, events, warn } = await setup();
    await expect(send({ eventId: "u1", alarmKind: "smoke" })).rejects.toMatchObject({
      statusCode: 422,
      code: "ALARM_KIND_UNMAPPED",
    });
    await expect(send({ eventId: "u1", alarmKind: "smoke" })).rejects.toMatchObject({ statusCode: 422 });
    expect(emit).not.toHaveBeenCalled();
    expect(events[0]?.status).toBe("unmapped");
    expect(warn).toHaveBeenCalledWith("m36.alarm_ingest.unmapped", expect.any(Object));
  });

  it("an alert nobody receives is recorded as no_recipients and warned, not silently dropped", async () => {
    const emit = vi.fn(async () => ({ alertId: "alert-1", resolvedRecipientCount: 0 }));
    const { send, warn, events } = await setup({ emit });
    await expect(send({ eventId: "n1", alarmKind: "call" })).resolves.toEqual({
      status: "accepted",
      outcome: "no_recipients",
    });
    expect(events[0]?.status).toBe("no_recipients");
    expect(warn).toHaveBeenCalledWith("m36.alarm_ingest.no_recipients", expect.any(Object));
  });

  it("a failed emit answers 503 and leaves the event received, so the sender's retry alerts exactly once", async () => {
    const emit = vi
      .fn()
      .mockRejectedValueOnce(new Error("fan-out down"))
      .mockResolvedValue({ alertId: "alert-1", resolvedRecipientCount: 1 });
    const { send, events } = await setup({ emit });
    await expect(send({ eventId: "r1", alarmKind: "call" })).rejects.toMatchObject({
      statusCode: 503,
      code: "ALARM_NOT_ALERTED",
    });
    expect(events[0]?.status).toBe("received");
    await expect(send({ eventId: "r1", alarmKind: "call" })).resolves.toMatchObject({
      outcome: "alerted",
    });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0]![1].correlationId).toBe(emit.mock.calls[1]![1].correlationId);
  });

  it("if only the outcome cannot be settled the sender is told to retry (503), and the retry settles without a second alert", async () => {
    const { store } = makeStore();
    let failSettle = true;
    const settle = store.settleEvent.bind(store);
    store.settleEvent = async (...args) => {
      if (failSettle) throw new Error("db blip");
      return settle(...args);
    };
    const emit = vi.fn(async (_org: string, _input: { correlationId: string }) => ({ alertId: "alert-1", resolvedRecipientCount: 1 }));
    const svc = createAlarmIngestService({
      store,
      cipher,
      alerts: () => ({ emit }) as never,
      flags: { forOrg: async () => ({ "messaging.alarm_ingest": true }) },
      now: () => NOW,
    });
    const created = await svc.create(ACTOR, { name: "n", mappings: MAPPINGS });
    const rawBody = JSON.stringify({ eventId: "s1", alarmKind: "call" });
    const req = {
      keyId: created.keyId,
      timestamp: TS,
      rawBody,
      signature: signAlarmRequest({ secret: created.secret, keyId: created.keyId, timestamp: TS, rawBody }),
      ip: "x",
    };
    await expect(svc.ingest(req)).rejects.toMatchObject({ statusCode: 503, code: "ALARM_NOT_ALERTED" });
    failSettle = false;
    await expect(svc.ingest(req)).resolves.toMatchObject({ outcome: "alerted" });
    expect(emit.mock.calls[0]![1].correlationId).toBe(emit.mock.calls[1]![1].correlationId);
  });

  it("the stored digest is the sha256 of the exact bytes received", async () => {
    const { send, events } = await setup();
    const raw = '{"eventId":"d1","alarmKind":"call"}';
    await send(raw);
    expect(events[0]?.payloadDigest).toBe(createHash("sha256").update(raw).digest("hex"));
  });
});
