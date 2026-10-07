import type { AiPromptActivationPlan, AiPromptTemplateSnapshot } from "@wardenx/ai-platform";
// apps/backend/src/modules/32-ai-platform/prompts/store.ts — the `ai_prompt_template` port plus the
// artifact reader `AIPromptRegistry` resolves bodies through (M32-T05).
//
// `ai_prompt_template` is PLATFORM-SHARED (§3.3): `ai_prompt_template_read` is `USING (true)` for
// `wardenx_app`, so every READ takes the ordinary tenant handle — including the D18 prohibited-zone
// queries a consumer module runs at its own boot, which must not need a credential M12 does not hold.
// R30's activation is the only WRITE and it runs under the audited platform bypass.
//
// ── THE ARTIFACT READER IS A SEPARATE PORT, AND IT IS ALLOWED TO BE ABSENT ────────────────────────
//
// §4.10 resolves `gitArtifactPath` against a read-only mount of `packages/prompts` at `/srv/prompts`.
// Phase 1 has no such mount and no authored templates (spec T52/T53), so the default reader answers
// "unresolvable" for everything. That asymmetry is deliberate and is the whole reason the reader is a
// port rather than an `fs` call inside the registry:
//
//   · `getActivePromptsTargeting` — the D18 SAFETY query — never touches the reader. It answers from
//     the table, so a missing mount cannot make it report "no contraband found".
//   · `getActivePromptForCapability` — needs a body, so it THROWS when the reader cannot resolve one.
//     Returning `null` would mean "this capability has no active prompt", which is what the invocation
//     pipeline reads before deciding whether it may dispatch without a template.
import { type DbClient, schema } from "@wardenx/db";
import { type PlatformBypassAuditor, withPlatformContext } from "@wardenx/tenancy";
import type { AiPromptTemplateStatus } from "@wardenx/types";
import { and, asc, eq, like } from "drizzle-orm";
import { type M32EventEmitter, capabilityIdentity } from "../events";

/** An `ai_prompt_template` row, complete enough for both the summary and the detail projections. */
export interface AiPromptTemplateRowProjection extends AiPromptTemplateSnapshot {
  readonly compatibleBackendKeys: readonly string[];
  readonly inputSchemaRef: string;
  readonly outputSchemaRef: string;
  readonly outputEntityTargetPrefix: string;
  readonly outputTypePrefix: string;
  readonly createdByMembershipId: string;
  readonly createdAt: string;
}

/** `ai_prompt_template`, platform-shared. */
export interface AiPromptTemplateStore {
  /**
   * Active rows whose `output_entity_target_prefix` STARTS WITH `entityPrefix` — the D18 query.
   *
   * The prefix direction is the one thing a store implementation can get backwards and still look
   * plausible: the template's target is the haystack. `ai_prompt_template_targeting_idx` is the partial
   * index this rides.
   */
  findActiveTargeting(entityPrefix: string): Promise<readonly AiPromptTemplateRowProjection[]>;
  findActiveWithOutputType(
    outputTypePrefix: string,
  ): Promise<readonly AiPromptTemplateRowProjection[]>;
  findActiveForCapability(capabilityKey: string): Promise<AiPromptTemplateRowProjection | null>;
  findByCapabilityVersion(
    capabilityKey: string,
    version: number,
  ): Promise<AiPromptTemplateRowProjection | null>;
  listActive(): Promise<readonly AiPromptTemplateRowProjection[]>;
  /** R30: insert the new active row and deprecate the prior one, in ONE transaction. */
  applyActivation(plan: AiPromptActivationPlan): Promise<AiPromptTemplateRowProjection>;
}

/** The bytes behind `template_filesystem_ref`, and their digest. */
export interface AiPromptArtifactRead {
  readonly body: string;
  /** Lowercase-hex SHA-256 of `body`'s bytes. */
  readonly contentHash: string;
}

/** §4.10's read-only artifact mount, as a port. */
export interface AiPromptArtifactReader {
  /** `null` when the path does not resolve — never a throw, so the caller decides what absence means. */
  read(templateFilesystemRef: string): Promise<AiPromptArtifactRead | null>;
}

/**
 * The Phase-1 reader: resolves nothing.
 *
 * There is no `/srv/prompts` mount in this wave and no authored template to put behind one (spec
 * T52/T53). A reader that returned an empty body instead would let a template activate against a file
 * that does not exist, with a content hash pinning nothing — and the boot validator §4.4 step 5 exists
 * precisely to make that fatal.
 */
export function createUnresolvableAiPromptArtifactReader(): AiPromptArtifactReader {
  return { read: async () => null };
}

// ── Drizzle implementation ─────────────────────────────────────────────────────────────────────────

type TemplateSelect = typeof schema.aiPromptTemplate.$inferSelect;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function toTemplateRow(row: TemplateSelect): AiPromptTemplateRowProjection {
  return {
    id: row.id,
    templateKey: row.templateKey,
    capabilityKey: row.capabilityKey,
    version: row.version,
    templateFilesystemRef: row.templateFilesystemRef,
    templateContentHash: row.templateContentHash,
    status: row.status as AiPromptTemplateStatus,
    approvedByMembershipId: row.approvedByMembershipId,
    approvedAt: iso(row.approvedAt),
    clinicalReviewerAttestation: row.clinicalReviewerAttestation,
    compatibleBackendKeys: asStringArray(row.compatibleBackendKeys),
    inputSchemaRef: row.inputSchemaRef,
    outputSchemaRef: row.outputSchemaRef,
    outputEntityTargetPrefix: row.outputEntityTargetPrefix,
    outputTypePrefix: row.outputTypePrefix,
    createdByMembershipId: row.createdByMembershipId,
    createdAt: iso(row.createdAt) ?? "",
  };
}

/** What the platform-shared store needs to open its audited bypass for R30. */
export interface AiPromptTemplateStoreDeps {
  /** The ORDINARY tenant handle — every read (`ai_prompt_template_read` is `USING (true)`). */
  readonly db: DbClient;
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly jobId: string;
  /** GAP-161 - same-tx `m32.prompt_template.activated` emit (absent in slice/tests). */
  readonly events?: M32EventEmitter;
}

/** Escape LIKE's wildcards so a prefix containing `%` or `_` matches literally.
 *  `output_entity_target_prefix` values are snake_case — `medication_` contains an underscore, which
 *  LIKE reads as "any character". Unescaped, `medication_` would also match `medicationX`. */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/([%_\\])/g, "\\$1")}%`;
}

export function createDrizzleAiPromptTemplateStore(
  deps: AiPromptTemplateStoreDeps,
): AiPromptTemplateStore {
  return {
    findActiveTargeting: async (entityPrefix) => {
      const rows = await deps.db
        .select()
        .from(schema.aiPromptTemplate)
        .where(
          and(
            eq(schema.aiPromptTemplate.status, "active"),
            like(schema.aiPromptTemplate.outputEntityTargetPrefix, likePrefix(entityPrefix)),
          ),
        )
        .orderBy(asc(schema.aiPromptTemplate.capabilityKey));
      return rows.map(toTemplateRow);
    },

    findActiveWithOutputType: async (outputTypePrefix) => {
      const rows = await deps.db
        .select()
        .from(schema.aiPromptTemplate)
        .where(
          and(
            eq(schema.aiPromptTemplate.status, "active"),
            like(schema.aiPromptTemplate.outputTypePrefix, likePrefix(outputTypePrefix)),
          ),
        )
        .orderBy(asc(schema.aiPromptTemplate.capabilityKey));
      return rows.map(toTemplateRow);
    },

    findActiveForCapability: async (capabilityKey) => {
      const [row] = await deps.db
        .select()
        .from(schema.aiPromptTemplate)
        .where(
          and(
            eq(schema.aiPromptTemplate.capabilityKey, capabilityKey),
            eq(schema.aiPromptTemplate.status, "active"),
          ),
        )
        .limit(1);
      return row ? toTemplateRow(row) : null;
    },

    findByCapabilityVersion: async (capabilityKey, version) => {
      const [row] = await deps.db
        .select()
        .from(schema.aiPromptTemplate)
        .where(
          and(
            eq(schema.aiPromptTemplate.capabilityKey, capabilityKey),
            eq(schema.aiPromptTemplate.version, version),
          ),
        )
        .limit(1);
      return row ? toTemplateRow(row) : null;
    },

    listActive: async () => {
      const rows = await deps.db
        .select()
        .from(schema.aiPromptTemplate)
        .where(eq(schema.aiPromptTemplate.status, "active"))
        .orderBy(asc(schema.aiPromptTemplate.capabilityKey));
      return rows.map(toTemplateRow);
    },

    applyActivation: (plan) =>
      withPlatformContext<DbClient, AiPromptTemplateRowProjection>(
        deps.platformDb,
        {
          jobId: deps.jobId,
          reason: `activate prompt template ${plan.insert.capabilityKey} v${plan.insert.version} (R30/W6.8)`,
          // `crossTenant: false` — a prompt template is platform-shared and touches no tenant's rows.
          crossTenant: false,
        },
        deps.auditBypass,
        async (tx) => {
          // The DEPRECATE runs FIRST. `ai_prompt_template_active_idx` is not unique, so both orders
          // commit — but between the two statements the capability would momentarily have TWO active
          // templates, and `findActiveForCapability` takes the first of them. Deprecating first leaves
          // a window with NONE, which the registry reports honestly as "no active prompt" rather than
          // silently picking one of two.
          if (plan.deprecate !== null) {
            await tx
              .update(schema.aiPromptTemplate)
              .set({
                status: "deprecated",
                supersededAt: new Date(plan.deprecate.supersededAt),
                deprecatedAt: new Date(plan.deprecate.deprecatedAt),
              })
              .where(eq(schema.aiPromptTemplate.id, plan.deprecate.id));
          }
          const [row] = await tx
            .insert(schema.aiPromptTemplate)
            .values({
              templateKey: plan.insert.templateKey,
              capabilityKey: plan.insert.capabilityKey,
              version: plan.insert.version,
              templateFilesystemRef: plan.insert.templateFilesystemRef,
              templateContentHash: plan.insert.templateContentHash.trim().toLowerCase(),
              compatibleBackendKeys: [...plan.insert.compatibleBackendKeys],
              inputSchemaRef: plan.insert.inputSchemaRef,
              outputSchemaRef: plan.insert.outputSchemaRef,
              outputEntityTargetPrefix: plan.insert.outputEntityTargetPrefix,
              outputTypePrefix: plan.insert.outputTypePrefix,
              status: "active",
              createdByMembershipId: plan.insert.createdByMembershipId,
              approvedByMembershipId: plan.insert.approvedByMembershipId,
              clinicalReviewerAttestation: plan.insert.clinicalReviewerAttestation,
              approvedAt: new Date(plan.insert.approvedAt),
            })
            .returning();
          if (!row) throw new Error("ai_prompt_template insert returned no row");
          await deps.events?.emitInTx(tx, {
            name: "m32.prompt_template.activated",
            organizationId: null,
            aggregate: { kind: "ai_prompt_template", id: row.id },
            payload: {
              ...(await capabilityIdentity(tx, { key: plan.insert.capabilityKey })),
              promptTemplateId: row.id,
              version: plan.insert.version,
              supersededTemplateId: plan.deprecate?.id ?? null,
              activatedByMembershipId: plan.insert.approvedByMembershipId,
              contentHash: row.templateContentHash,
            },
          });
          return toTemplateRow(row);
        },
      ),
  };
}

// ── in-memory implementation (slice tests) ─────────────────────────────────────────────────────────

let inMemorySequence = 0;

/** In-memory `ai_prompt_template`, holding D3's one-way walk and the prefix direction. */
export function createInMemoryAiPromptTemplateStore(
  seed: readonly AiPromptTemplateRowProjection[] = [],
): AiPromptTemplateStore & { rows: AiPromptTemplateRowProjection[] } {
  const rows: AiPromptTemplateRowProjection[] = [...seed];
  const active = () => rows.filter((r) => r.status === "active");
  return {
    rows,
    findActiveTargeting: async (entityPrefix) =>
      active().filter((r) => r.outputEntityTargetPrefix.startsWith(entityPrefix)),
    findActiveWithOutputType: async (outputTypePrefix) =>
      active().filter((r) => r.outputTypePrefix.startsWith(outputTypePrefix)),
    findActiveForCapability: async (capabilityKey) =>
      active().find((r) => r.capabilityKey === capabilityKey) ?? null,
    findByCapabilityVersion: async (capabilityKey, version) =>
      rows.find((r) => r.capabilityKey === capabilityKey && r.version === version) ?? null,
    listActive: async () => active(),
    applyActivation: async (plan) => {
      if (plan.deprecate !== null) {
        const i = rows.findIndex((r) => r.id === plan.deprecate!.id);
        if (i !== -1) rows[i] = { ...rows[i]!, status: "deprecated" };
      }
      inMemorySequence += 1;
      const row: AiPromptTemplateRowProjection = {
        id: `apt-${String(inMemorySequence).padStart(6, "0")}`,
        templateKey: plan.insert.templateKey,
        capabilityKey: plan.insert.capabilityKey,
        version: plan.insert.version,
        templateFilesystemRef: plan.insert.templateFilesystemRef,
        templateContentHash: plan.insert.templateContentHash.trim().toLowerCase(),
        status: "active",
        approvedByMembershipId: plan.insert.approvedByMembershipId,
        approvedAt: plan.insert.approvedAt,
        clinicalReviewerAttestation: plan.insert.clinicalReviewerAttestation,
        compatibleBackendKeys: [...plan.insert.compatibleBackendKeys],
        inputSchemaRef: plan.insert.inputSchemaRef,
        outputSchemaRef: plan.insert.outputSchemaRef,
        outputEntityTargetPrefix: plan.insert.outputEntityTargetPrefix,
        outputTypePrefix: plan.insert.outputTypePrefix,
        createdByMembershipId: plan.insert.createdByMembershipId,
        createdAt: plan.insert.approvedAt,
      };
      rows.push(row);
      return row;
    },
  };
}

/**
 * F-236 — the filesystem artifact reader §4.10 describes: resolves `templateFilesystemRef` (a repo-relative
 * path such as `packages/prompts/doclens/extract.v1.md`) under one root (the repository checkout in dev /
 * the image, the read-only `/srv/prompts` mount in production) and returns the body with its SHA-256.
 * The registry compares that hash to the row's pin and refuses on a mismatch; this reader never decides.
 * A path escaping the root, or a missing file, is `null` (unresolvable), never a throw.
 */
export function createFilesystemAiPromptArtifactReader(root: string): AiPromptArtifactReader {
  return {
    async read(templateFilesystemRef) {
      const { createHash } = await import("node:crypto");
      const { readFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const base = path.resolve(root);
      const target = path.resolve(base, templateFilesystemRef);
      if (target !== base && !target.startsWith(`${base}${path.sep}`)) return null;
      try {
        const body = await readFile(target, "utf8");
        return { body, contentHash: createHash("sha256").update(body, "utf8").digest("hex") };
      } catch {
        return null;
      }
    },
  };
}
