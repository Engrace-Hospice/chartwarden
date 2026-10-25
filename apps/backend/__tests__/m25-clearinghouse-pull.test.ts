// #717 - the bound clearinghouse's `fetchRemittances` feeding the M25 835 intake. Synthetic data; the in-memory
// transport (page size 2) is the far side. The ingest service is a double that dedups on ISA13/ST02 like the real
// `ux_remittance_envelope_dedupe` index (that index is proved live in m25-835-ingestion.live.test.ts).
import { createHash } from "node:crypto";
import { CH, DEFAULT_SCOPE } from "@chartwarden/x12-837-client";
import type { ClearinghouseContext } from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { describe, expect, it } from "vitest";
import {
  MAX_REFUSALS_PER_REMITTANCE,
  type RemittanceCursorKey,
  type RemittanceCursorStore,
  pullRemittances,
} from "../src/modules/25-remittance/ingest/clearinghouse-pull";
import type {
  ReceiveAdviceInput,
  ReceiveAdviceResult,
} from "../src/modules/25-remittance/ingest/service";
import { buildRawEdi } from "./_edi835-fixture";

const ORG = DEFAULT_SCOPE.organizationId;
const PE = DEFAULT_SCOPE.providerEntityId;
const PAYER = "00000000-0000-4000-8000-00000000fee1";

const ctx: ClearinghouseContext = {
  ...DEFAULT_SCOPE,
  payerId: "J6",
  correlationId: "corr-1",
};

function cursorStore(initial: string | null = null) {
  const saved = new Map<string, string>();
  const keyOf = (k: RemittanceCursorKey) =>
    `${k.organizationId}|${k.providerEntityId}|${k.vendor}|${k.usage}`;
  if (initial !== null)
    saved.set(
      keyOf({ organizationId: ORG, providerEntityId: PE, vendor: "in_memory", usage: "test" }),
      initial,
    );
  const refusals = new Map<string, { count: number; quarantined: boolean }>();
  const store: RemittanceCursorStore = {
    get: async (k) => saved.get(keyOf(k)) ?? null,
    set: async (k, c) => {
      saved.set(keyOf(k), c);
    },
    isQuarantined: async (k, id, sha) =>
      refusals.get(`${keyOf(k)}|${id}|${sha}`)?.quarantined ?? false,
    clearRefusals: async (k, id, sha) => {
      const ref = `${keyOf(k)}|${id}|${sha}`;
      const cur = refusals.get(ref);
      if (cur && !cur.quarantined) refusals.set(ref, { count: 0, quarantined: false });
    },
    recordRefusal: async (k, id, sha, _code, cap) => {
      const ref = `${keyOf(k)}|${id}|${sha}`;
      const count = (refusals.get(ref)?.count ?? 0) + 1;
      const next = { count, quarantined: count >= cap };
      refusals.set(ref, next);
      return next;
    },
  };
  return { store, current: () => [...saved.values()][0] ?? null };
}

function ingestDouble(
  opts: { malformedFor?: string; cause?: "content" | "environment" | undefined } = {},
) {
  const seen = new Map<string, string>();
  const received: ReceiveAdviceInput[] = [];
  return {
    received,
    ingest: {
      async receiveAdvice(
        _actor: { organizationId: string },
        input: ReceiveAdviceInput,
      ): Promise<ReceiveAdviceResult> {
        received.push(input);
        if (opts.malformedFor && input.minioObjectKey.endsWith(opts.malformedFor)) {
          return {
            outcome: "malformed",
            reason: "synthetic refusal",
            cause: "cause" in opts ? opts.cause : "content",
          };
        }
        const isa = /^ISA(?:\*[^*]*){12}\*(\d{9})/.exec(input.rawEdi)?.[1] ?? "";
        const st = /ST\*835\*(\w+)/.exec(input.rawEdi)?.[1] ?? "";
        const dedupeKey = `${isa}/${st}/${input.providerEntityId}`;
        const prior = seen.get(dedupeKey);
        if (prior) return { outcome: "duplicate", existingAdviceId: prior };
        seen.set(dedupeKey, `adv-${seen.size + 1}`);
        return { outcome: "queued", adviceId: `adv-${seen.size}` };
      },
    },
  };
}

function setup(
  over: {
    payer?: string | null;
    cursor?: string | null;
    malformedFor?: string;
    cause?: "content" | "environment" | undefined;
  } = {},
) {
  const far = new InMemoryClearinghouse();
  const cursors = cursorStore(over.cursor ?? null);
  const ingest = ingestDouble(
    "cause" in over
      ? { malformedFor: over.malformedFor, cause: over.cause }
      : { malformedFor: over.malformedFor },
  );
  const deps = {
    transport: far,
    vendor: "in_memory",
    contexts: { providerEntitiesFor: async () => [PE], contextFor: async () => ctx },
    payers: { medicarePayerId: async () => (over.payer === undefined ? PAYER : over.payer) },
    cursors: cursors.store,
    ingest: ingest.ingest,
  };
  return { far, deps, cursors, ingest };
}

describe("pullRemittances", () => {
  it("pages the feed, stages every file through receiveAdvice and persists the cursor", async () => {
    const { far, deps, cursors, ingest } = setup();
    for (const n of [1, 2, 3, 4, 5]) {
      await far.control.deliverRemittance(`ERA-${n}`, buildRawEdi(String(n), "0001"));
    }

    const result = await pullRemittances(deps, ORG);

    expect(result).toMatchObject({ queued: 5, duplicates: 0, failures: [] });
    expect(ingest.received.map((r) => r.minioObjectKey)).toEqual(
      [1, 2, 3, 4, 5].map((n) => `clearinghouse/in_memory/ERA-${n}`),
    );
    expect(ingest.received[0]).toMatchObject({
      providerEntityId: PE,
      payerId: PAYER,
      payerKind: "medicare",
    });
    expect(ingest.received[0]?.fileSha256).toBe(
      createHash("sha256")
        .update(ingest.received[0]?.rawEdi ?? "", "utf8")
        .digest("hex"),
    );
    expect(cursors.current()).toBe("5");
  });

  it("resumes from the stored cursor and receives only what arrived since", async () => {
    const { far, deps, ingest } = setup();
    await far.control.deliverRemittance("ERA-1", buildRawEdi("1", "0001"));
    await pullRemittances(deps, ORG);
    await far.control.deliverRemittance("ERA-2", buildRawEdi("2", "0001"));

    const second = await pullRemittances(deps, ORG);

    expect(second).toMatchObject({ queued: 1, duplicates: 0, failures: [] });
    expect(ingest.received).toHaveLength(2);
  });

  it("dedups a redelivered file on its control numbers (S08): counted, never re-queued", async () => {
    const { far, deps } = setup();
    await far.control.deliverRemittance("ERA-1", buildRawEdi("7", "0001"));
    // The vendor re-sends the same interchange under a new file id.
    await far.control.deliverRemittance("ERA-1-again", buildRawEdi("7", "0001"));

    const result = await pullRemittances(deps, ORG);

    expect(result).toMatchObject({ queued: 1, duplicates: 1, failures: [] });
  });

  it("refuses a malformed stored cursor and leaves it untouched: never restarts from the beginning", async () => {
    const { far, deps, cursors, ingest } = setup({ cursor: "garbage" });
    await far.control.deliverRemittance("ERA-1", buildRawEdi("1", "0001"));

    const result = await pullRemittances(deps, ORG);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("request refused (cursor not reset)");
    expect(result.failures[0]).toContain(CH.INVALID_REQUEST);
    expect(ingest.received).toHaveLength(0);
    expect(cursors.current()).toBe("garbage");
  });

  it("does not move the cursor past a page holding a file receiveAdvice refused", async () => {
    const { far, deps, cursors } = setup({ malformedFor: "ERA-3" });
    for (const n of [1, 2, 3, 4]) {
      await far.control.deliverRemittance(`ERA-${n}`, buildRawEdi(String(n), "0001"));
    }

    const result = await pullRemittances(deps, ORG);

    expect(result.failures[0]).toContain("ERA-3 refused at receive");
    expect(cursors.current()).toBe("2"); // page 1 (ERA-1, ERA-2) done; ERA-3 is re-offered next tick
  });

  it("retries a refused file until the cap, then quarantines it, advances the cursor and keeps going", async () => {
    const { far, deps, cursors, ingest } = setup({ malformedFor: "ERA-3" });
    for (const n of [1, 2, 3, 4]) {
      await far.control.deliverRemittance(`ERA-${n}`, buildRawEdi(String(n), "0001"));
    }

    for (let i = 1; i < MAX_REFUSALS_PER_REMITTANCE; i++) {
      const transient = await pullRemittances(deps, ORG);
      expect(transient.failures[0]).toContain("ERA-3 refused at receive");
      expect(transient.quarantined).toEqual([]);
      expect(cursors.current()).toBe("2");
    }
    const final = await pullRemittances(deps, ORG);

    expect(final.failures).toEqual([]);
    expect(final.quarantined).toEqual([
      `org ${ORG} provider ${PE}: remittance ERA-3 REMITTANCE_QUARANTINED`,
    ]);
    expect(cursors.current()).toBe("4");
    const offered = ingest.received.length;
    const after = await pullRemittances(deps, ORG);
    expect(after).toMatchObject({ queued: 0, failures: [], quarantined: [] });
    expect(ingest.received.length).toBe(offered); // nothing re-offered
  });

  it("counts only CONSECUTIVE refusals: an accepted file zeroes its count", async () => {
    const { far, deps, ingest } = setup();
    await far.control.deliverRemittance("ERA-1", buildRawEdi("1", "0001"));
    let flaky = true;
    const flakyDeps = {
      ...deps,
      ingest: {
        receiveAdvice: async (a: { organizationId: string }, i: ReceiveAdviceInput) =>
          flaky
            ? ({ outcome: "malformed", reason: "synthetic", cause: "content" } as const)
            : ingest.ingest.receiveAdvice(a, i),
      },
    };
    for (let i = 0; i < MAX_REFUSALS_PER_REMITTANCE - 1; i++) await pullRemittances(flakyDeps, ORG);
    flaky = false;
    expect(await pullRemittances(flakyDeps, ORG)).toMatchObject({ queued: 1, failures: [] });
    flaky = true;
    await far.control.setOutage(false);

    const again = await pullRemittances(
      { ...flakyDeps, cursors: { ...deps.cursors, get: async () => null } },
      ORG,
    );

    expect(again.quarantined).toEqual([]); // count restarted from 0, so one refusal is not the cap
    expect(again.failures).toHaveLength(1);
  });

  it("skips an already-quarantined file if the vendor re-offers it", async () => {
    const { far, deps, cursors, ingest } = setup({ malformedFor: "ERA-1" });
    await far.control.deliverRemittance("ERA-1", buildRawEdi("1", "0001"));
    for (let i = 0; i < MAX_REFUSALS_PER_REMITTANCE; i++) await pullRemittances(deps, ORG);
    await cursors.store.set(
      { organizationId: ORG, providerEntityId: PE, vendor: "in_memory", usage: "test" },
      "0",
    );
    const before = ingest.received.length;

    const result = await pullRemittances(deps, ORG);

    expect(result.failures).toEqual([]);
    expect(result.quarantined).toHaveLength(1); // still reported on every tick it is offered
    expect(ingest.received.length).toBe(before);
    expect((await pullRemittances(deps, ORG)).quarantined).toHaveLength(0); // cursor moved on; nothing re-offered
  });

  it("never counts an environment refusal (payee/config, parser outage) toward the cap", async () => {
    for (const cause of ["environment", undefined] as const) {
      const { far, deps, cursors } = setup({ malformedFor: "ERA-1", cause });
      await far.control.deliverRemittance("ERA-1", buildRawEdi("1", "0001"));

      for (let i = 0; i < MAX_REFUSALS_PER_REMITTANCE + 3; i++) {
        const r = await pullRemittances(deps, ORG);
        expect(r.failures[0]).toContain("ERA-1 refused at receive");
        expect(r.quarantined).toEqual([]);
      }
      expect(cursors.current()).toBeNull(); // never advanced past it
    }
  });

  it("retries a re-offered file whose content changed (new hash) instead of treating it as quarantined", async () => {
    const { deps, cursors, ingest } = setup({ malformedFor: "ERA-1" });
    const offer = { body: buildRawEdi("1", "0001") };
    const transport = {
      fetchRemittances: async () => ({
        ok: true as const,
        data: {
          items: [{ remittanceId: "ERA-1", rawX12: offer.body }],
          nextCursor: "1",
          hasMore: false,
        },
      }),
    };
    const flaky = { ...deps, transport: transport as never };
    for (let i = 0; i < MAX_REFUSALS_PER_REMITTANCE; i++) await pullRemittances(flaky, ORG);
    await cursors.store.set(
      { organizationId: ORG, providerEntityId: PE, vendor: "in_memory", usage: "test" },
      "0",
    );
    const before = ingest.received.length;
    offer.body = buildRawEdi("1", "0002"); // the vendor corrected the file

    const result = await pullRemittances(flaky, ORG);

    expect(ingest.received.length).toBe(before + 1); // handed to receiveAdvice again
    expect(result.quarantined).toEqual([]);
    expect(result.failures[0]).toContain("ERA-1 refused at receive"); // first refusal of the new content
  });

  it("reports a transport without an 835 feed as unsupported, not failed", async () => {
    const { deps } = setup();
    const notWired = {
      ...deps,
      transport: {
        fetchRemittances: async () => ({
          ok: false as const,
          degraded: { code: CH.NOT_WIRED, reason: "not implemented", retryable: false },
        }),
      } as never,
    };

    const result = await pullRemittances(notWired, ORG);

    expect(result).toMatchObject({ queued: 0, unsupported: 1, failures: [] });
  });

  it("fails closed when the Medicare payer cannot be resolved", async () => {
    const { far, deps, ingest } = setup({ payer: null });
    await far.control.deliverRemittance("ERA-1", buildRawEdi("1", "0001"));

    const result = await pullRemittances(deps, ORG);

    expect(result.failures[0]).toContain("Medicare payer is not resolvable");
    expect(ingest.received).toHaveLength(0);
  });

  it("does not write the cursor when an empty poll leaves it where it was", async () => {
    const { far, deps } = setup();
    await far.control.deliverRemittance("ERA-1", buildRawEdi("1", "0001"));
    await pullRemittances(deps, ORG);
    let writes = 0;
    const counting = {
      ...deps,
      cursors: {
        ...deps.cursors,
        get: deps.cursors.get,
        set: async (...args: Parameters<typeof deps.cursors.set>) => {
          writes += 1;
          return deps.cursors.set(...args);
        },
      },
    };

    await pullRemittances(counting, ORG);

    expect(writes).toBe(0);
  });

  it("keeps a failing provider-entity listing from throwing out of the org (other orgs still run)", async () => {
    const { deps } = setup();
    const broken = {
      ...deps,
      contexts: {
        ...deps.contexts,
        providerEntitiesFor: async () => {
          throw new Error("db down");
        },
      },
    };

    const result = await pullRemittances(broken, ORG);

    expect(result.failures).toEqual([`org ${ORG}: provider entities could not be listed`]);
  });

  it("reports an outage as a failure and keeps the cursor", async () => {
    const { far, deps, cursors } = setup({ cursor: "0" });
    await far.control.setOutage(true);

    const result = await pullRemittances(deps, ORG);

    expect(result.failures).toHaveLength(1);
    expect(cursors.current()).toBe("0");
  });
});
