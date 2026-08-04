// Module 32 — `AIPromptRegistry` over the in-memory template store (M32-T05).
//
// The pure rules are pinned in `packages/ai-platform/__tests__/prompt-registry-rules.test.ts`. What
// THIS file proves is the failure behaviour that makes the D18 prohibited-zone query trustworthy: the
// targeting query never touches the artifact mount (so a missing mount cannot answer "no contraband"),
// a capability whose artifact will not resolve THROWS rather than reporting itself prompt-less, and the
// cache holds resolved details without ever holding a D18 answer.

import { describe, expect, it } from "vitest";

import {
  AiPromptArtifactError,
  activateAiPromptTemplate,
  createAiPromptRegistry,
  createInMemoryAiPromptTemplateStore,
  createUnresolvableAiPromptArtifactReader,
  verifyActiveAiPromptArtifacts,
} from "../src/modules/32-ai-platform/prompts";
import type {
  AiPromptArtifactReader,
  AiPromptTemplateRowProjection,
} from "../src/modules/32-ai-platform/prompts";

const T0 = "2026-08-15T12:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function template(
  overrides: Partial<AiPromptTemplateRowProjection> = {},
): AiPromptTemplateRowProjection {
  return {
    id: "apt-1",
    templateKey: "hearthnote_enhancement_v1",
    capabilityKey: "hearthnote_layer2",
    version: 1,
    templateFilesystemRef: "packages/prompts/templates/hearthnote_layer2/v1.md",
    templateContentHash: HASH_A,
    status: "active",
    approvedByMembershipId: "mem-reviewer",
    approvedAt: "2026-06-01T00:00:00.000Z",
    clinicalReviewerAttestation: "Reviewed.",
    compatibleBackendKeys: ["anthropic-claude"],
    inputSchemaRef: "hearthnote_layer2.input.v1",
    outputSchemaRef: "hearthnote_layer2.output.v1",
    outputEntityTargetPrefix: "encounter_narrative",
    outputTypePrefix: "narrative_text",
    createdByMembershipId: "mem-author",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function reader(
  map: Record<string, { body: string; contentHash: string }>,
): AiPromptArtifactReader {
  return { read: async (ref) => map[ref] ?? null };
}

describe("D18 prohibited-zone query", () => {
  const store = createInMemoryAiPromptTemplateStore([
    template(),
    template({
      id: "apt-2",
      templateKey: "doclens_extract_v1",
      capabilityKey: "doclens_extractor",
      outputEntityTargetPrefix: "doclens_extraction_candidate",
      outputTypePrefix: "structured_extraction",
    }),
    template({
      id: "apt-3",
      templateKey: "med_reconcile_v1",
      capabilityKey: "medication_reconciliation",
      outputEntityTargetPrefix: "medication_order",
      status: "deprecated",
    }),
  ]);

  it("answers from the table with NO artifact reader involved", async () => {
    // The reader here throws if touched — a D18 answer that depended on a filesystem mount could fail
    // open, which is the one answer this query must never invent.
    const registry = createAiPromptRegistry({
      store,
      artifacts: {
        read: async () => {
          throw new Error("the D18 query must not read the artifact mount");
        },
      },
    });
    const hits = await registry.getActivePromptsTargeting("encounter_");
    expect(hits.map((h) => h.capabilityKey)).toEqual(["hearthnote_layer2"]);
  });

  it("matches the prefix against the template's target, not the other way round", async () => {
    const registry = createAiPromptRegistry({
      store,
      artifacts: createUnresolvableAiPromptArtifactReader(),
    });
    expect(await registry.getActivePromptsTargeting("doclens_")).toHaveLength(1);
    expect(await registry.getActivePromptsTargeting("doclens_extraction_candidate")).toHaveLength(
      1,
    );
    expect(await registry.getActivePromptsTargeting("patient_")).toHaveLength(0);
  });

  it("excludes a DEPRECATED template targeting a prohibited zone — history is not a breach", async () => {
    const registry = createAiPromptRegistry({
      store,
      artifacts: createUnresolvableAiPromptArtifactReader(),
    });
    expect(await registry.getActivePromptsTargeting("medication_")).toHaveLength(0);
  });

  it("answers the output-type half of the index pair", async () => {
    const registry = createAiPromptRegistry({
      store,
      artifacts: createUnresolvableAiPromptArtifactReader(),
    });
    expect(await registry.getActivePromptsWithOutputType("narrative_")).toHaveLength(1);
    expect(await registry.getActivePromptsWithOutputType("embedding_")).toHaveLength(0);
  });

  it("enumerates only the active set", async () => {
    const registry = createAiPromptRegistry({
      store,
      artifacts: createUnresolvableAiPromptArtifactReader(),
    });
    const all = await registry.enumerateAllActive();
    expect(all.map((s) => s.templateKey).sort()).toEqual([
      "doclens_extract_v1",
      "hearthnote_enhancement_v1",
    ]);
  });
});

describe("getActivePromptForCapability", () => {
  it("returns null ONLY when the capability genuinely has no active template", async () => {
    const registry = createAiPromptRegistry({
      store: createInMemoryAiPromptTemplateStore([template({ status: "deprecated" })]),
      artifacts: createUnresolvableAiPromptArtifactReader(),
    });
    expect(await registry.getActivePromptForCapability("hearthnote_layer2")).toBeNull();
  });

  it("THROWS when the artifact will not resolve, rather than reporting the capability prompt-less", async () => {
    const registry = createAiPromptRegistry({
      store: createInMemoryAiPromptTemplateStore([template()]),
      artifacts: createUnresolvableAiPromptArtifactReader(),
    });
    await expect(registry.getActivePromptForCapability("hearthnote_layer2")).rejects.toThrow(
      AiPromptArtifactError,
    );
  });

  it("THROWS when the file has diverged from its pinned hash", async () => {
    const registry = createAiPromptRegistry({
      store: createInMemoryAiPromptTemplateStore([template()]),
      artifacts: reader({
        "packages/prompts/templates/hearthnote_layer2/v1.md": {
          body: "edited on the box",
          contentHash: HASH_B,
        },
      }),
    });
    await expect(registry.getActivePromptForCapability("hearthnote_layer2")).rejects.toThrow(
      /diverged/,
    );
  });

  it("resolves and caches the detail, and the cache expires on the §4.10 TTL", async () => {
    let reads = 0;
    let clock = 0;
    const registry = createAiPromptRegistry({
      store: createInMemoryAiPromptTemplateStore([template()]),
      artifacts: {
        read: async () => {
          reads += 1;
          return { body: "the reviewed prompt", contentHash: HASH_A };
        },
      },
      now: () => clock,
    });

    const first = await registry.getActivePromptForCapability("hearthnote_layer2");
    expect(first?.promptBody).toBe("the reviewed prompt");
    expect(first?.meta.compatibleBackendKeys).toEqual(["anthropic-claude"]);
    await registry.getActivePromptForCapability("hearthnote_layer2");
    expect(reads).toBe(1);

    clock = 5 * 60 * 1000 + 1;
    await registry.getActivePromptForCapability("hearthnote_layer2");
    expect(reads).toBe(2);
  });

  it("invalidates by capability key", async () => {
    let reads = 0;
    const registry = createAiPromptRegistry({
      store: createInMemoryAiPromptTemplateStore([template()]),
      artifacts: {
        read: async () => {
          reads += 1;
          return { body: "the reviewed prompt", contentHash: HASH_A };
        },
      },
    });
    await registry.getActivePromptForCapability("hearthnote_layer2");
    registry.invalidate("some_other_capability");
    await registry.getActivePromptForCapability("hearthnote_layer2");
    expect(reads).toBe(1);
    registry.invalidate("hearthnote_layer2");
    await registry.getActivePromptForCapability("hearthnote_layer2");
    expect(reads).toBe(2);
  });
});

describe("R30 activation service", () => {
  const command = {
    capabilityKey: "hearthnote_layer2",
    templateKey: "hearthnote_enhancement_v2",
    version: 2,
    templateFilesystemRef: "packages/prompts/templates/hearthnote_layer2/v2.md",
    templateContentHash: HASH_B,
    compatibleBackendKeys: ["anthropic-claude"],
    inputSchemaRef: "hearthnote_layer2.input.v1",
    outputSchemaRef: "hearthnote_layer2.output.v1",
    outputEntityTargetPrefix: "encounter_narrative",
    outputTypePrefix: "narrative_text",
    createdByMembershipId: "mem-author",
    approvedByMembershipId: "mem-reviewer",
    clinicalReviewerAttestation: "Reviewed against the hospice narrative safety checklist.",
  };

  it("inserts the new version active, deprecates the prior one, and evicts the cache", async () => {
    const store = createInMemoryAiPromptTemplateStore([template()]);
    const artifacts = reader({
      "packages/prompts/templates/hearthnote_layer2/v2.md": { body: "v2", contentHash: HASH_B },
    });
    const registry = createAiPromptRegistry({ store, artifacts });
    let invalidated: string | undefined | null = null;

    const row = await activateAiPromptTemplate(
      {
        store,
        artifacts,
        registry: {
          invalidate: (key) => {
            invalidated = key;
            registry.invalidate(key);
          },
        },
        now: () => T0,
      },
      command,
    );

    expect(row.status).toBe("active");
    expect(row.version).toBe(2);
    expect(store.rows.find((r) => r.id === "apt-1")?.status).toBe("deprecated");
    expect(invalidated).toBe("hearthnote_layer2");
    expect(await registry.getActivePromptForCapability("hearthnote_layer2")).toMatchObject({
      version: 2,
      promptBody: "v2",
    });
  });

  it("refuses every activation under the Phase-1 unresolvable reader", async () => {
    const store = createInMemoryAiPromptTemplateStore([template()]);
    await expect(
      activateAiPromptTemplate(
        { store, artifacts: createUnresolvableAiPromptArtifactReader(), now: () => T0 },
        command,
      ),
    ).rejects.toThrow(/could not be read/);
    // ...and the prior template is untouched, so a refused activation leaves the capability served.
    expect(store.rows.find((r) => r.id === "apt-1")?.status).toBe("active");
  });

  it("does not trust a submitted hash the file contradicts", async () => {
    const store = createInMemoryAiPromptTemplateStore([template()]);
    await expect(
      activateAiPromptTemplate(
        {
          store,
          artifacts: reader({
            "packages/prompts/templates/hearthnote_layer2/v2.md": {
              body: "something else",
              contentHash: HASH_A,
            },
          }),
          now: () => T0,
        },
        command,
      ),
    ).rejects.toThrow(/does not hash/);
  });
});

describe("§4.4 step 5 artifact validator", () => {
  it("reports every active template as unresolved under the Phase-1 reader", async () => {
    const findings = await verifyActiveAiPromptArtifacts({
      store: createInMemoryAiPromptTemplateStore([template()]),
      artifacts: createUnresolvableAiPromptArtifactReader(),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.problem).toBe("unresolved");
  });

  it("reports a hash mismatch distinctly from an unresolved path", async () => {
    const findings = await verifyActiveAiPromptArtifacts({
      store: createInMemoryAiPromptTemplateStore([template()]),
      artifacts: reader({
        "packages/prompts/templates/hearthnote_layer2/v1.md": { body: "x", contentHash: HASH_B },
      }),
    });
    expect(findings[0]?.problem).toBe("hash_mismatch");
  });

  it("returns findings rather than throwing on the first one", async () => {
    const findings = await verifyActiveAiPromptArtifacts({
      store: createInMemoryAiPromptTemplateStore([
        template(),
        template({ id: "apt-2", templateKey: "t2", capabilityKey: "c2", version: 9 }),
      ]),
      artifacts: createUnresolvableAiPromptArtifactReader(),
    });
    expect(findings).toHaveLength(2);
  });

  it("is silent when every active template resolves and matches", async () => {
    const findings = await verifyActiveAiPromptArtifacts({
      store: createInMemoryAiPromptTemplateStore([template()]),
      artifacts: reader({
        "packages/prompts/templates/hearthnote_layer2/v1.md": {
          body: "the reviewed prompt",
          contentHash: HASH_A,
        },
      }),
    });
    expect(findings).toHaveLength(0);
  });
});
