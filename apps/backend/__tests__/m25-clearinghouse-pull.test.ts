// #717 - the bound clearinghouse's `fetchRemittances` feeding the M25 835 intake. Synthetic data; the in-memory
// transport (page size 2) is the far side. The ingest service is a double that dedups on ISA13/ST02 like the real
// `ux_remittance_envelope_dedupe` index (that index is proved live in m25-835-ingestion.live.test.ts).
import { createHash } from "node:crypto";
import { CH, DEFAULT_SCOPE } from "@chartwarden/x12-837-client";
import type { ClearinghouseContext } from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { describe, expect, it } from "vitest";
import {
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
  const store: RemittanceCursorStore = {
    get: async (k) => saved.get(keyOf(k)) ?? null,
    set: async (k, c) => {
      saved.set(keyOf(k), c);
    },
  };
  return { store, current: () => [...saved.values()][0] ?? null };
}

function ingestDouble(opts: { malformedFor?: string } = {}) {
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
          return { outcome: "malformed", reason: "synthetic refusal" };
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
  over: { payer?: string | null; cursor?: string | null; malformedFor?: string } = {},
) {
  const far = new InMemoryClearinghouse();
  const cursors = cursorStore(over.cursor ?? null);
  const ingest = ingestDouble({ malformedFor: over.malformedFor });
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
    expect(result.failures[0]).toContain("cursor refused (not reset)");
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

  it("reports an outage as a failure and keeps the cursor", async () => {
    const { far, deps, cursors } = setup({ cursor: "0" });
    await far.control.setOutage(true);

    const result = await pullRemittances(deps, ORG);

    expect(result.failures).toHaveLength(1);
    expect(cursors.current()).toBe("0");
  });
});
