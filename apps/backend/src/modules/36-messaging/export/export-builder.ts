// M36 WP 5.7 (ADR-0089, PROPOSED), D3-D6 - the artefact builder. For one APPROVED job: claim it (approved -> building), resolve the scope, leave out
// the held and the Part 2 gated messages (counted, never listed), fail closed over the message cap, page the rest with a keyset (bounded reads),
// open each body, build `{manifest, messages}` (attachment METADATA only), seal it under a fresh data key wrapped by the tenant KEK, store the
// ciphertext, and move building -> ready. Any failure moves building -> failed with a closed code; no plaintext is ever in an error or a log.
// Idempotent: a job already past `approved` claims nothing and the call is a no-op.
// ponytail: the JSON document is assembled in memory (at most EXPORT_MAX_MESSAGES bodies); stream-encrypt if the cap is ever raised.
import {
  EXPORT_LINK_TTL_HOURS,
  EXPORT_MAX_MESSAGES,
  EXPORT_TOO_LARGE_CODE,
  MESSAGING_EXPORT_FORMAT,
  MESSAGING_EXPORT_MANIFEST_VERSION,
  type MessagingExportManifest,
} from "@chartwarden/types";
import { ExportCryptoError, type ExportKeyWrap, sealArtefact, sha256Hex } from "./export-crypto";

export const EXPORT_PAGE_SIZE = 500;
export const EXPORT_FAIL_DECRYPT = "EXPORT_DECRYPT_FAILED";
export const EXPORT_FAIL_KEY = "EXPORT_KEY_UNAVAILABLE";
export const EXPORT_FAIL_PART2 = "EXPORT_PART2_UNKNOWN";
export const EXPORT_FAIL_STORE = "EXPORT_STORE_FAILED";
export const EXPORT_FAIL_BUILD = "EXPORT_BUILD_FAILED";
export const EXPORT_OBJECT_PREFIX = "messaging-export";

export interface ExportJobRow {
  readonly id: string;
  readonly organizationId: string;
  readonly requestedBy: string;
  readonly decidedBy: string;
  readonly scopeKind: "channel" | "patient";
  readonly channelId: string | null;
  readonly patientId: string | null;
  /** YYYY-MM-DD, both or neither. */
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
}

export interface ExportChannel {
  readonly id: string;
  readonly kind: string;
  /** The patient of a care_team channel; null otherwise. */
  readonly subjectId: string | null;
}

export interface ExportMessageRow {
  readonly id: string;
  readonly channelId: string;
  readonly authorUserId: string | null;
  readonly createdAt: Date;
  readonly bodyKind: string;
  readonly status: string;
  readonly bodyCipher: Buffer;
}

export interface ExportAttachmentMeta {
  readonly id: string;
  readonly messageId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly scanState: string;
}

/** The slice of messages one query covers: these channels, this window, created no later than `until` (a stable snapshot edge). */
export interface ExportMessageQuery {
  readonly channelIds: readonly string[];
  readonly from: Date | null;
  /** Exclusive. */
  readonly to: Date | null;
  readonly until: Date;
}

export interface ExportCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/** Every database touch of the build (each call is its own tenant transaction). Implemented by `export-build-store.ts`. */
export interface ExportBuildStore {
  /** approved -> building; null when the job is not `approved` (already claimed, decided otherwise, or unknown): the build is a no-op. */
  claim(organizationId: string, jobId: string): Promise<ExportJobRow | null>;
  channelsFor(organizationId: string, job: ExportJobRow): Promise<readonly ExportChannel[]>;
  /** Messages with a readable body in the query, and how many of them a legal hold covers (held is a subset of total). */
  count(
    organizationId: string,
    query: ExportMessageQuery,
  ): Promise<{ readonly total: number; readonly held: number }>;
  /** The next page, oldest first, held messages excluded, strictly after `after`. */
  page(
    organizationId: string,
    query: ExportMessageQuery,
    after: ExportCursor | null,
    limit: number,
  ): Promise<readonly ExportMessageRow[]>;
  attachments(
    organizationId: string,
    messageIds: readonly string[],
  ): Promise<readonly ExportAttachmentMeta[]>;
  /** building -> ready (the guard stamps ready_at / expires_at) and publishes `m36.export.ready` in the same transaction. */
  complete(
    organizationId: string,
    jobId: string,
    result: {
      readonly artefactKey: string;
      readonly artefactSha256: string;
      readonly artefactBytes: number;
      readonly wrappedDek: string;
      readonly messageCount: number;
      readonly heldExcluded: number;
      readonly part2Excluded: number;
    },
  ): Promise<void>;
  /** building -> failed with a closed code. */
  fail(organizationId: string, jobId: string, failureCode: string): Promise<void>;
}

export interface ExportBuilderDeps {
  readonly store: ExportBuildStore;
  readonly keys: Pick<ExportKeyWrap, "mint">;
  /** Open one `body_cipher` (the M36 body cipher). A key outage should throw `BodyKeyUnavailableError`. */
  readonly openBody: (organizationId: string, cipher: Buffer) => Promise<string>;
  /** Of these patients, the ones carrying the Part 2 (`sud`) privacy flag. THROWS when unreadable: the build then fails closed. */
  readonly part2Patients: (
    organizationId: string,
    patientIds: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  readonly putObject: (args: {
    readonly organizationId: string;
    readonly objectKey: string;
    readonly bytes: Uint8Array;
  }) => Promise<void>;
  /** Best-effort cleanup of an object stored by a build that then failed (the row never became ready). */
  readonly deleteObject?: (args: {
    readonly organizationId: string;
    readonly objectKey: string;
  }) => Promise<void>;
  readonly now?: () => Date;
}

export type ExportBuildOutcome =
  | { readonly outcome: "skipped" }
  | { readonly outcome: "ready"; readonly messageCount: number }
  | { readonly outcome: "failed"; readonly failureCode: string };

class ExportBuildFailure extends Error {
  constructor(readonly failureCode: string) {
    super(failureCode);
    this.name = "ExportBuildFailure";
  }
}

const DAY_MS = 86_400_000;
const utcStart = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

function windowOf(job: ExportJobRow): { from: Date | null; to: Date | null } {
  if (!job.dateFrom || !job.dateTo) return { from: null, to: null };
  return { from: utcStart(job.dateFrom), to: new Date(utcStart(job.dateTo).getTime() + DAY_MS) };
}

/** Closed failure code for an unexpected throw; the thrown value itself is never read for content. */
function failureCodeOf(error: unknown): string {
  if (error instanceof ExportBuildFailure) return error.failureCode;
  const name = error instanceof Error ? error.name : "";
  if (name === "BodyKeyUnavailableError" || name === "TenantKeyDestroyed") return EXPORT_FAIL_KEY;
  if (error instanceof ExportCryptoError) return EXPORT_FAIL_DECRYPT;
  return EXPORT_FAIL_BUILD;
}

export function createExportBuilder(deps: ExportBuilderDeps) {
  const now = deps.now ?? (() => new Date());

  async function split(organizationId: string, channels: readonly ExportChannel[]) {
    const subjects = [
      ...new Set(
        channels.flatMap((c) => (c.kind === "care_team" && c.subjectId ? [c.subjectId] : [])),
      ),
    ];
    let flagged: ReadonlySet<string> = new Set();
    if (subjects.length > 0) {
      try {
        flagged = await deps.part2Patients(organizationId, subjects);
      } catch {
        throw new ExportBuildFailure(EXPORT_FAIL_PART2);
      }
    }
    const gated = (c: ExportChannel) =>
      c.kind === "care_team" && c.subjectId !== null && flagged.has(c.subjectId);
    return {
      allowed: channels.filter((c) => !gated(c)).map((c) => c.id),
      gated: channels.filter(gated).map((c) => c.id),
    };
  }

  async function collect(
    organizationId: string,
    query: ExportMessageQuery,
    expected: number,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let after: ExportCursor | null = null;
    while (query.channelIds.length > 0) {
      const rows = await deps.store.page(organizationId, query, after, EXPORT_PAGE_SIZE);
      if (rows.length === 0) break;
      const attachments = await deps.store.attachments(
        organizationId,
        rows.map((r) => r.id),
      );
      for (const row of rows) {
        out.push({
          id: row.id,
          channelId: row.channelId,
          senderId: row.authorUserId,
          sentAt: row.createdAt.toISOString(),
          kind: row.bodyKind,
          status: row.status,
          body: await deps.openBody(organizationId, row.bodyCipher),
          attachments: attachments
            .filter((a) => a.messageId === row.id)
            .map((a) => ({
              id: a.id,
              name: a.name,
              mimeType: a.mimeType,
              byteSize: a.byteSize,
              scanState: a.scanState,
            })),
        });
        // A page that outgrows the count (cannot, given `until`) must not run away.
        if (out.length > Math.max(expected, 0) || out.length > EXPORT_MAX_MESSAGES) {
          throw new ExportBuildFailure(EXPORT_TOO_LARGE_CODE);
        }
      }
      const last = rows[rows.length - 1];
      if (!last || rows.length < EXPORT_PAGE_SIZE) break;
      after = { createdAt: last.createdAt, id: last.id };
    }
    return out;
  }

  async function build(job: ExportJobRow): Promise<ExportBuildOutcome> {
    const { organizationId } = job;
    const startedAt = now();
    const { from, to } = windowOf(job);
    const channels = await deps.store.channelsFor(organizationId, job);
    const { allowed, gated } = await split(organizationId, channels);
    const window = { from, to, until: startedAt };
    const allowedCount = await deps.store.count(organizationId, { ...window, channelIds: allowed });
    const gatedCount =
      gated.length > 0
        ? await deps.store.count(organizationId, { ...window, channelIds: gated })
        : { total: 0, held: 0 };
    const included = allowedCount.total - allowedCount.held;
    if (included > EXPORT_MAX_MESSAGES) throw new ExportBuildFailure(EXPORT_TOO_LARGE_CODE);

    const messages = await collect(organizationId, { ...window, channelIds: allowed }, included);
    const manifest: MessagingExportManifest = {
      manifestVersion: MESSAGING_EXPORT_MANIFEST_VERSION,
      format: MESSAGING_EXPORT_FORMAT,
      jobId: job.id,
      organizationId,
      scope: {
        scopeKind: job.scopeKind,
        channelId: job.channelId,
        patientId: job.patientId,
        dateFrom: job.dateFrom,
        dateTo: job.dateTo,
      },
      requestedBy: job.requestedBy,
      approvedBy: job.decidedBy,
      generatedAt: startedAt.toISOString(),
      // The authoritative instant is the row's expires_at (DB clock, stamped at ready); this is the same 24 h from generation.
      expiresAt: new Date(startedAt.getTime() + EXPORT_LINK_TTL_HOURS * 3_600_000).toISOString(),
      messageCount: messages.length,
      heldExcluded: allowedCount.held,
      part2Excluded: gatedCount.total,
    };
    const plaintext = Buffer.from(JSON.stringify({ manifest, messages }), "utf8");
    const artefactSha256 = sha256Hex(plaintext);

    const { dek, wrapped } = await deps.keys.mint(organizationId);
    let sealed: Buffer;
    try {
      sealed = sealArtefact(plaintext, dek, { organizationId, jobId: job.id });
    } finally {
      dek.fill(0);
    }
    const artefactKey = `${EXPORT_OBJECT_PREFIX}/${job.id}.enc`;
    try {
      await deps.putObject({ organizationId, objectKey: artefactKey, bytes: sealed });
    } catch {
      throw new ExportBuildFailure(EXPORT_FAIL_STORE);
    }
    try {
      await deps.store.complete(organizationId, job.id, {
        artefactKey,
        artefactSha256,
        artefactBytes: sealed.length,
        wrappedDek: wrapped,
        messageCount: messages.length,
        heldExcluded: allowedCount.held,
        part2Excluded: gatedCount.total,
      });
    } catch (error) {
      await deps.deleteObject?.({ organizationId, objectKey: artefactKey }).catch(() => undefined);
      throw error;
    }
    return { outcome: "ready", messageCount: messages.length };
  }

  return {
    async buildJob(organizationId: string, jobId: string): Promise<ExportBuildOutcome> {
      const job = await deps.store.claim(organizationId, jobId);
      if (!job) return { outcome: "skipped" };
      try {
        return await build(job);
      } catch (error) {
        const failureCode = failureCodeOf(error);
        await deps.store.fail(organizationId, jobId, failureCode);
        return { outcome: "failed", failureCode };
      }
    },
  };
}

export type ExportBuilder = ReturnType<typeof createExportBuilder>;
