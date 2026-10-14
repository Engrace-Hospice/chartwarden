/**
 * M36 WP 2.7b chunk C2 (ADR-0058, Proposed) - the writer side of global search: pure/unit checks that need no database.
 * The behavioural proof (RLS, FOR SHARE races, real publisher + relay) is `m36-global-search-writer.live.test.ts`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import type { IndexWriter } from "../src/modules/36-messaging/global-search/index-writer";
import {
  M36_MESSAGE_SEARCH_INDEXER_CONSUMER,
  buildM36MessageSearchIndexerConsumer,
} from "../src/modules/36-messaging/global-search/indexer-consumer";
import { GLOBAL_SEARCH_QUEUES } from "../src/modules/36-messaging/global-search/queue-names";
import {
  SearchKeyUnavailableError,
  createLegacyTestSearchKeyProvider,
  createUnavailableSearchKeyProvider,
} from "../src/modules/36-messaging/global-search/search-key-provider";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function fakeWriter() {
  return {
    indexMessage: vi.fn(async () => "indexed" as const),
    removeMessage: vi.fn(async () => 0),
  } satisfies IndexWriter;
}

const event = (
  eventType: string,
  organizationId: string,
  payload: unknown,
): DispatchableOutboxEvent => ({
  id: randomUUID(),
  organizationId,
  eventType,
  aggregateKind: "message",
  aggregateId: randomUUID(),
  payload,
  attemptCount: 0,
  createdAt: new Date(),
});

describe("unavailable search key provider (production wiring until WP 2.13)", () => {
  it("throws on every method (fail closed)", async () => {
    const provider = createUnavailableSearchKeyProvider();
    await expect(provider.activeVersion(ORG_A)).rejects.toBeInstanceOf(SearchKeyUnavailableError);
    await expect(provider.liveVersions(ORG_A)).rejects.toBeInstanceOf(SearchKeyUnavailableError);
    await expect(provider.tagKey(ORG_A, "v1")).rejects.toBeInstanceOf(SearchKeyUnavailableError);
  });

  it("the test stub derives distinct per-tenant keys under the 'legacy' label", async () => {
    const provider = createLegacyTestSearchKeyProvider(randomBytes(32));
    expect(await provider.activeVersion(ORG_A)).toBe("legacy");
    const a = await provider.tagKey(ORG_A, "legacy");
    const b = await provider.tagKey(ORG_B, "legacy");
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });
});

describe("m36.message-search-indexer consumer", () => {
  it("is bound to m36 for sent, edited and deleted", () => {
    const binding = buildM36MessageSearchIndexerConsumer(fakeWriter());
    expect(binding.consumerName).toBe(M36_MESSAGE_SEARCH_INDEXER_CONSUMER);
    expect(binding.consumerModule).toBe("m36");
    expect([...binding.eventTypes]).toEqual([
      "m36.message.sent",
      "m36.message.edited",
      "m36.message.deleted",
    ]);
  });

  it("takes the tenant from the envelope, never from the payload", async () => {
    const writer = fakeWriter();
    const messageId = randomUUID();
    await buildM36MessageSearchIndexerConsumer(writer).handle(
      event("m36.message.sent", ORG_A, { organizationId: ORG_B, messageId }),
    );
    expect(writer.indexMessage).toHaveBeenCalledWith(ORG_A, messageId);
  });

  it("routes edited to a re-index and deleted to the unconditional removal", async () => {
    const writer = fakeWriter();
    const binding = buildM36MessageSearchIndexerConsumer(writer);
    const messageId = randomUUID();
    await binding.handle(event("m36.message.edited", ORG_A, { messageId }));
    await binding.handle(event("m36.message.deleted", ORG_A, { messageId }));
    expect(writer.indexMessage).toHaveBeenCalledTimes(1);
    expect(writer.removeMessage).toHaveBeenCalledWith(ORG_A, messageId);
  });

  it("throws on a malformed payload (retry then DLQ) and does no work", async () => {
    const writer = fakeWriter();
    const binding = buildM36MessageSearchIndexerConsumer(writer);
    for (const payload of [undefined, {}, { messageId: 7 }, { messageId: "not-a-uuid" }]) {
      await expect(binding.handle(event("m36.message.sent", ORG_A, payload))).rejects.toThrow(
        /valid messageId/,
      );
    }
    expect(writer.indexMessage).not.toHaveBeenCalled();
  });

  it("rejects an event type it is not bound to", async () => {
    await expect(
      buildM36MessageSearchIndexerConsumer(fakeWriter()).handle(
        event("m36.message.annotated", ORG_A, { messageId: randomUUID() }),
      ),
    ).rejects.toThrow(/unexpected event/);
  });
});

describe("wiring (bound is not computing: the factories are reachable from index.ts)", () => {
  const indexSource = readFileSync(join(__dirname, "../src/index.ts"), "utf8");

  it("index.ts calls registerM36GlobalSearch once, with the ring key provider (fail closed while no ring is bound), and binds its consumer", () => {
    expect(indexSource.match(/registerM36GlobalSearch\(/g)).toHaveLength(1);
    expect(indexSource).toContain("createRingSearchKeyProvider(() => sharedRingDekCache())");
    expect(indexSource).toContain("keys: m36SearchKeys,");
    expect(indexSource).toContain("m36GlobalSearch.consumer");
  });

  it("the name exclusion is wired into BOTH the route mount and the writer, from M5's name enumeration (names never reach the index)", () => {
    expect(indexSource).toContain(
      "patientNameFragmentsPageForOrg(dbHandle.db, organizationId, afterId, limit)",
    );
    expect(indexSource).toContain(
      "...(m36NameExclusions ? { exclusions: m36NameExclusions } : {})",
    );
    expect(indexSource).toMatch(/exclusions:\s+m36NameExclusions \?\? createNameExclusions/);
  });

  it("production never wires the test key provider", () => {
    expect(indexSource).not.toContain("createLegacyTestSearchKeyProvider");
  });

  it("the maintenance queue is the one new name, outside MESSAGING_QUEUES", () => {
    expect(GLOBAL_SEARCH_QUEUES.maintenance).toBe("messaging.search_maintenance");
  });
});
