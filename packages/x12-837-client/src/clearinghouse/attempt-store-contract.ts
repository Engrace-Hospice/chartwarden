// @chartwarden/x12-837-client — the SubmissionAttemptStore CONTRACT cases. Framework-free like ./conformance.ts: a case
// fails by throwing, so the same list runs against the in-memory store (attempt-store.test.ts) and against the
// durable Postgres store (the backend's live suite, as the NOBYPASSRLS app role). A store is "durable" only when
// every case passes against it.
import {
  PlatformControlNumberTaken,
  type SubmissionAttempt,
  type SubmissionAttemptStore,
} from "./attempt-store";

export interface AttemptStoreContractCase {
  readonly id: string;
  readonly title: string;
  /** `make` returns a fresh, empty store each call. `ids` are valid for the store's backing (uuids for Postgres). */
  run(make: () => Promise<SubmissionAttemptStore>, ids: AttemptStoreContractIds): Promise<void>;
}

export interface AttemptStoreContractIds {
  readonly orgA: string;
  readonly orgB: string;
  readonly providerEntityA: string;
  readonly providerEntityB: string;
}

export const IN_MEMORY_CONTRACT_IDS: AttemptStoreContractIds = {
  orgA: "org-a",
  orgB: "org-b",
  providerEntityA: "pe-a",
  providerEntityB: "pe-b",
};

const T0 = "2026-10-11T10:00:00.000Z";
const T1 = "2026-10-11T10:20:00.000Z";
const IDENTITY = "a".repeat(64);
/** A user id; the Postgres store stamps it into the audit trail, where it is a uuid. */
export const CONTRACT_OPERATOR_ID = "00000000-0000-4000-8000-0000000000a1";
const OPERATOR = CONTRACT_OPERATOR_ID;
const OTHER_IDENTITY = "b".repeat(64);

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`attempt-store contract: ${message}`);
}

export function reservation(
  ids: AttemptStoreContractIds,
  overrides: Partial<SubmissionAttempt> = {},
): SubmissionAttempt {
  return {
    organizationId: ids.orgA,
    providerEntityId: ids.providerEntityA,
    scope: `scope-${ids.orgA}`,
    usage: "test",
    idempotencyKey: "idem-1",
    controlNumber: "CCN-1",
    kind: "claim",
    identity: IDENTITY,
    status: "reserved",
    clearinghouseSubmissionId: null,
    firstReservedAt: T0,
    reservedAt: T0,
    receivedAt: null,
    ...overrides,
  };
}

export const ATTEMPT_STORE_CONTRACT: readonly AttemptStoreContractCase[] = [
  {
    id: "AS-01",
    title: "reserve writes a reserved row once",
    async run(make, ids) {
      const store = await make();
      const first = await store.reserve(reservation(ids));
      assert(first.reserved, "first reserve must write");
      assert(first.attempt.status === "reserved", "a new row is reserved");
      assert(first.attempt.clearinghouseSubmissionId === null, "no vendor id yet");
      const again = await store.reserve(reservation(ids));
      assert(!again.reserved, "the same key must not reserve twice");
      assert(again.attempt.idempotencyKey === "idem-1", "returns the existing row");
    },
  },
  {
    id: "AS-02",
    title: "a control number already reserved under another key is reported, not overwritten",
    async run(make, ids) {
      const store = await make();
      await store.reserve(reservation(ids));
      const clash = await store.reserve(reservation(ids, { idempotencyKey: "idem-2" }));
      assert(!clash.reserved, "same control number under another key must not reserve");
      assert(clash.attempt.idempotencyKey === "idem-1", "returns the row that holds the number");
    },
  },
  {
    id: "AS-03",
    title: "scopes and tenants never collide",
    async run(make, ids) {
      const store = await make();
      await store.reserve(reservation(ids));
      const otherScope = await store.reserve(
        reservation(ids, { scope: "scope-live", usage: "production" }),
      );
      assert(otherScope.reserved, "another scope (usage) is independent");
      const otherOrg = await store.reserve(
        reservation(ids, {
          organizationId: ids.orgB,
          providerEntityId: ids.providerEntityB,
          scope: `scope-${ids.orgB}`,
          controlNumber: "CCN-B",
        }),
      );
      assert(otherOrg.reserved, "another tenant is independent");
    },
  },
  {
    id: "AS-04",
    title: "complete turns the reservation into a sent record, idempotently",
    async run(make, ids) {
      const store = await make();
      await store.reserve(reservation(ids));
      const sent = await store.complete(ids.orgA, `scope-${ids.orgA}`, "idem-1", "ch-1", T1);
      assert(sent?.status === "sent", "complete marks sent");
      assert(sent.clearinghouseSubmissionId === "ch-1", "keeps the vendor id");
      assert(sent.receivedAt === T1, "keeps the receipt time");
      const again = await store.complete(ids.orgA, `scope-${ids.orgA}`, "idem-1", "ch-OTHER", T1);
      assert(again?.clearinghouseSubmissionId === "ch-1", "a sent row is never rewritten");
      const reserved = await store.reserve(reservation(ids));
      assert(!reserved.reserved && reserved.attempt.status === "sent", "reserve now sees sent");
    },
  },
  {
    id: "AS-05",
    title: "complete on an unknown reservation returns null",
    async run(make, ids) {
      const store = await make();
      const missing = await store.complete(ids.orgA, `scope-${ids.orgA}`, "nope", "ch-1", T1);
      assert(missing === null, "nothing to complete");
    },
  },
  {
    id: "AS-06",
    title: "release frees a reserved row for a fresh reservation but never touches a sent row",
    async run(make, ids) {
      const store = await make();
      await store.reserve(reservation(ids));
      await store.release(ids.orgA, `scope-${ids.orgA}`, "idem-1");
      const fresh = await store.reserve(reservation(ids, { identity: OTHER_IDENTITY }));
      assert(fresh.reserved, "a released key and control number can be reserved again");
      assert(fresh.attempt.identity === OTHER_IDENTITY, "the new reservation is the new row");
      await store.complete(ids.orgA, `scope-${ids.orgA}`, "idem-1", "ch-1", T1);
      await store.release(ids.orgA, `scope-${ids.orgA}`, "idem-1");
      const after = await store.reserve(reservation(ids));
      assert(!after.reserved && after.attempt.status === "sent", "release is a no-op on sent");
    },
  },
  {
    id: "AS-07",
    title: "retake is a compare-and-set on the reservation time",
    async run(make, ids) {
      const store = await make();
      await store.reserve(reservation(ids));
      const scope = `scope-${ids.orgA}`;
      assert(!(await store.retake(ids.orgA, scope, "idem-1", T1, T1)), "wrong expected time loses");
      assert(await store.retake(ids.orgA, scope, "idem-1", T0, T1), "matching expected time wins");
      const held = await store.reserve(reservation(ids));
      assert(held.attempt.reservedAt === T1, "the retaken time is stored");
      assert(held.attempt.firstReservedAt === T0, "the first reservation time never moves");
      assert(!(await store.retake(ids.orgA, scope, "idem-1", T0, T1)), "a stale taker loses");
      await store.complete(ids.orgA, scope, "idem-1", "ch-1", T1);
      assert(
        !(await store.retake(ids.orgA, scope, "idem-1", T1, T1)),
        "a sent row is never retaken",
      );
    },
  },
  {
    id: "AS-08",
    title: "concurrent reservations of one submission: exactly one wins",
    async run(make, ids) {
      const store = await make();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => store.reserve(reservation(ids))),
      );
      assert(results.filter((r) => r.reserved).length === 1, "exactly one reservation is written");
      assert(
        results.every((r) => r.attempt.idempotencyKey === "idem-1"),
        "every caller sees the same submission",
      );
    },
  },
  {
    id: "AS-09",
    title:
      "a control number is unique across tenants within one usage mode (the sender is shared), and free again once released",
    async run(make, ids) {
      const store = await make();
      await store.reserve(reservation(ids));
      const theirs = reservation(ids, {
        organizationId: ids.orgB,
        providerEntityId: ids.providerEntityB,
        scope: `scope-${ids.orgB}`,
        idempotencyKey: "idem-b",
      });
      let taken = false;
      try {
        await store.reserve(theirs);
      } catch (e) {
        taken = e instanceof PlatformControlNumberTaken;
      }
      assert(taken, "another tenant cannot reserve a live control number");
      const production = await store.reserve({
        ...theirs,
        usage: "production",
        scope: `scope-live-${ids.orgB}`,
      });
      assert(production.reserved, "the other usage mode has its own number space");
      await store.release(ids.orgA, `scope-${ids.orgA}`, "idem-1");
      assert((await store.reserve(theirs)).reserved, "a released number can be reused");
    },
  },
  {
    id: "AS-10",
    title: "allocated control numbers are 9 digits, increasing and never repeated, per usage mode",
    async run(make) {
      const store = await make();
      const a = await store.allocateControlNumber("test");
      const b = await store.allocateControlNumber("test");
      const c = await store.allocateControlNumber("production");
      for (const n of [a, b, c]) assert(/^[0-9]{9}$/.test(n), "a control number is 9 digits");
      assert(Number(b) > Number(a), "numbers increase");
      const many = await Promise.all(
        Array.from({ length: 20 }, () => store.allocateControlNumber("test")),
      );
      assert(new Set([a, b, ...many]).size === many.length + 2, "concurrent callers never collide");
    },
  },
  {
    id: "AS-12",
    title:
      "resolve settles a reservation as sent or voided (control number freed, key burned), only when the guard still holds, only for its own tenant",
    async run(make, ids) {
      const store = await make();
      const scope = `scope-${ids.orgA}`;
      const OPEN = {
        firstReservedBefore: "2999-01-01T00:00:00.000Z",
        reservedBefore: "2999-01-01T00:00:00.000Z",
      };
      const TOO_RECENT = {
        firstReservedBefore: "2000-01-01T00:00:00.000Z",
        reservedBefore: "2999-01-01T00:00:00.000Z",
      };
      await store.reserve(reservation(ids));
      assert(
        (await store.resolve(
          ids.orgA,
          scope,
          "idem-1",
          { kind: "voided" },
          OPERATOR,
          TOO_RECENT,
        )) === null,
        "a reservation newer than the guard is left to the sender",
      );
      const sent = await store.resolve(
        ids.orgA,
        scope,
        "idem-1",
        { kind: "sent", clearinghouseSubmissionId: "ch-op", receivedAt: T1 },
        OPERATOR,
        OPEN,
      );
      assert(
        sent?.status === "sent" && sent.clearinghouseSubmissionId === "ch-op",
        "resolved as sent",
      );
      assert(
        (await store.resolve(ids.orgA, scope, "idem-1", { kind: "voided" }, OPERATOR, OPEN)) ===
          null,
        "a sent row cannot be resolved again",
      );
      await store.reserve(reservation(ids, { idempotencyKey: "idem-2", controlNumber: "CCN-2" }));
      const voided = await store.resolve(
        ids.orgA,
        scope,
        "idem-2",
        { kind: "voided" },
        OPERATOR,
        OPEN,
      );
      assert(voided?.status === "voided", "resolved as voided");
      const sameKey = await store.reserve(
        reservation(ids, { idempotencyKey: "idem-2", controlNumber: "CCN-3" }),
      );
      assert(!sameKey.reserved && sameKey.attempt.status === "voided", "a voided key stays burned");
      assert(
        (
          await store.reserve(
            reservation(ids, { idempotencyKey: "idem-3", controlNumber: "CCN-2" }),
          )
        ).reserved,
        "a voided control number is free again",
      );
      const scopeB = `scope-${ids.orgB}`;
      await store.reserve(
        reservation(ids, {
          organizationId: ids.orgB,
          providerEntityId: ids.providerEntityB,
          scope: scopeB,
          idempotencyKey: "idem-b",
          controlNumber: "CCN-B",
        }),
      );
      assert(
        (await store.resolve(ids.orgA, scopeB, "idem-b", { kind: "voided" }, OPERATOR, OPEN)) ===
          null,
        "another tenant's attempt cannot be resolved",
      );
      assert(
        (await store.find(ids.orgB, scopeB, "idem-b"))?.status === "reserved",
        "and it is untouched",
      );
    },
  },
  {
    id: "AS-11",
    title: "find returns the live attempt for a key, and null for none or for another tenant",
    async run(make, ids) {
      const store = await make();
      const scope = `scope-${ids.orgA}`;
      assert((await store.find(ids.orgA, scope, "idem-1")) === null, "nothing yet");
      await store.reserve(reservation(ids));
      const found = await store.find(ids.orgA, scope, "idem-1");
      assert(found?.status === "reserved" && found.usage === "test", "the live row is found");
      assert((await store.find(ids.orgB, scope, "idem-1")) === null, "another tenant sees none");
    },
  },
  {
    id: "AS-13",
    title:
      "allocateInterchangeNumber remembers one 9-digit platform-unique number per (tenant, scope, key), so a redelivered job renders the same ISA13",
    async run(make, ids) {
      const store = await make();
      const scope = `scope-${ids.orgA}`;
      const firstMemo = await store.allocateInterchangeNumber(ids.orgA, scope, "idem-1", "test");
      const first = firstMemo.number;
      assert(/^[0-9]{9}$/.test(first), "an interchange number is 9 digits");
      assert(
        (await store.allocateInterchangeNumber(ids.orgA, scope, "idem-1", "test")).number === first,
        "the same key gets the same number again",
      );
      const second = (await store.allocateInterchangeNumber(ids.orgA, scope, "idem-2", "test"))
        .number;
      assert(second !== first, "another key gets another number");
      assert(
        (await store.allocateInterchangeNumber(ids.orgB, scope, "idem-1", "test")).number !== first,
        "another tenant's identical key is a different submission and gets its own number",
      );
      const concurrentMemos = await Promise.all(
        Array.from({ length: 12 }, () =>
          store.allocateInterchangeNumber(ids.orgA, scope, "idem-race", "test"),
        ),
      );
      const concurrent = concurrentMemos.map((m) => m.number);
      assert(
        new Set(concurrentMemos.map((m) => m.renderedAt.getTime())).size === 1,
        "concurrent callers on one key agree on one render time",
      );
      const again = await store.allocateInterchangeNumber(ids.orgA, scope, "idem-1", "test");
      assert(
        again.renderedAt.getTime() === firstMemo.renderedAt.getTime(),
        "the same key gets the same render time again (a redelivery renders byte-identically, issue #836)",
      );
      assert(new Set(concurrent).size === 1, "concurrent callers on one key agree on one number");
      const control = await store.allocateControlNumber("test");
      assert(
        ![first, second, ...concurrent].includes(control),
        "the control-number allocator never hands out an interchange number already in use",
      );
      let refused = false;
      try {
        await store.allocateInterchangeNumber(ids.orgA, scope, "idem-1", "production");
      } catch {
        refused = true;
      }
      assert(refused, "a key remembered under test is never answered with a number for production");
    },
  },
];
