// @wardenx/x12-837-client — the SubmissionAttemptStore CONTRACT cases. Framework-free like ./conformance.ts: a case
// fails by throwing, so the same list runs against the in-memory store (attempt-store.test.ts) and against the
// durable Postgres store (the backend's live suite, as the NOBYPASSRLS app role). A store is "durable" only when
// every case passes against it.
import type { SubmissionAttempt, SubmissionAttemptStore } from "./attempt-store";

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
      const otherScope = await store.reserve(reservation(ids, { scope: "scope-live" }));
      assert(otherScope.reserved, "another scope (usage) is independent");
      const otherOrg = await store.reserve(
        reservation(ids, {
          organizationId: ids.orgB,
          providerEntityId: ids.providerEntityB,
          scope: `scope-${ids.orgB}`,
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
];
