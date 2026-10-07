import type { ExpansionRow, ValueSetMemberRow } from "@wardenx/terminology";
// M38 loader — refresh_expansions / refresh_embeddings over in-memory ports (GAP-108).
import { describe, expect, it } from "vitest";
import { SILENT_LOGGER } from "../src/ports";
import {
  EMBEDDING_DIMENSIONS,
  type EmbedderPort,
  type EmbeddingStorePort,
  embedderUnavailable,
  runRefreshEmbeddings,
} from "../src/refresh-embeddings";
import { refreshExpansionsForSystem } from "../src/refresh-expansions";

const member = (valueSetId: string, code: string): ValueSetMemberRow => ({
  valueSetId,
  systemId: "icd10cm",
  code,
  memberEffective: "2026-10-01",
  memberEnd: null,
});

describe("refreshExpansionsForSystem", () => {
  it("writes one replacement per value set and ledgers counts", async () => {
    const written = new Map<string, readonly ExpansionRow[]>();
    const logged: number[][] = [];
    const run = await refreshExpansionsForSystem(
      "icd10cm",
      {
        loadMembersForSystem: async () => [
          member("a", "I50.21"),
          member("a", "G30.9"),
          member("b", "C50.91"),
        ],
        replaceExpansion: async (id, rows) => void written.set(id, rows),
        logExpanded: async (_s, sets, rows) => void logged.push([sets, rows]),
      },
      SILENT_LOGGER,
    );
    expect(run.valueSetIds).toEqual(["a", "b"]);
    expect([...written.keys()]).toEqual(["a", "b"]);
    expect(written.get("a")).toHaveLength(2);
    expect(logged).toEqual([[2, 3]]);
  });

  it("isolates a failing value set: the others are written, then the job throws so it retries", async () => {
    const written: string[] = [];
    await expect(
      refreshExpansionsForSystem(
        "icd10cm",
        {
          loadMembersForSystem: async () => [member("a", "X"), member("b", "Y")],
          replaceExpansion: async (id) => {
            if (id === "a") throw new Error("boom");
            written.push(id);
          },
          logExpanded: async () => undefined,
        },
        SILENT_LOGGER,
      ),
    ).rejects.toThrow(/1 value set\(s\) failed: a/);
    expect(written).toEqual(["b"]);
  });
});

function embeddingRig(total: number) {
  const have = new Set<string>();
  const concepts = Array.from({ length: total }, (_, i) => ({
    code: `C${String(i).padStart(4, "0")}`,
    display: `concept ${i}`,
  }));
  const logged: number[] = [];
  const store: EmbeddingStorePort = {
    activeVersionId: async () => "v1",
    conceptsMissingEmbeddings: async (_s, _v, after, limit) =>
      concepts
        .filter((c) => !have.has(c.code) && (after === null || c.code > after))
        .slice(0, limit),
    writeEmbeddings: async (_v, _m, rows) => {
      for (const r of rows) have.add(r.code);
      return rows.length;
    },
    logEmbedded: async (_s, _v, n) => void logged.push(n),
  };
  const embedder: EmbedderPort = {
    available: true,
    modelId: "test-embedder",
    embed: async (texts) =>
      texts.map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1)),
  };
  return { store, embedder, have, logged };
}

describe("runRefreshEmbeddings", () => {
  it("embeds only un-embedded concepts, in batches, and is idempotent on re-run", async () => {
    const r = embeddingRig(600);
    const first = await runRefreshEmbeddings(
      { store: r.store, embedder: r.embedder, log: SILENT_LOGGER },
      "icd10cm",
    );
    expect(first).toEqual({ outcome: "refreshed", embedded: 600, hasMore: false });
    expect(r.have.size).toBe(600);
    const second = await runRefreshEmbeddings(
      { store: r.store, embedder: r.embedder, log: SILENT_LOGGER },
      "icd10cm",
    );
    expect(second.embedded).toBe(0);
  });

  it("is bounded per run and reports hasMore", async () => {
    const r = embeddingRig(600);
    const out = await runRefreshEmbeddings(
      { store: r.store, embedder: r.embedder, log: SILENT_LOGGER },
      "icd10cm",
      300,
    );
    expect(out).toEqual({ outcome: "refreshed", embedded: 300, hasMore: true });
  });

  it("does not fake vectors when no embedder is bound", async () => {
    const r = embeddingRig(10);
    const out = await runRefreshEmbeddings(
      { store: r.store, embedder: embedderUnavailable, log: SILENT_LOGGER },
      "icd10cm",
    );
    expect(out).toEqual({ outcome: "embedder_unavailable", embedded: 0, hasMore: false });
    expect(r.have.size).toBe(0);
  });

  it("rejects a wrong-width vector rather than writing it", async () => {
    const r = embeddingRig(3);
    const bad: EmbedderPort = { ...r.embedder, embed: async (t) => t.map(() => [1, 2, 3]) };
    await expect(
      runRefreshEmbeddings({ store: r.store, embedder: bad, log: SILENT_LOGGER }, "icd10cm"),
    ).rejects.toThrow(/EMBEDDING_INVALID/);
    expect(r.have.size).toBe(0);
  });
});
