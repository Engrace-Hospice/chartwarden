// M36 WP 5.7 (ADR-0089, PROPOSED), D3-D6 - the artefact builder. For one APPROVED job: claim it (approved -> building), re-check the requester is
// still eligible, resolve the scope, leave out the held messages and the Part 2 gated ones (counted, never listed: a channel whose subject patient is
// flagged, and any message that REFERENCES a flagged patient), fail closed over the message and byte caps, page the rest with a keyset on database
// TEXT timestamps (microseconds survive), open each body, build `{manifest, messages}` (attachment METADATA only), seal it under a fresh data key
// wrapped by the tenant KEK, store the ciphertext, and move building -> ready. Any failure moves building -> failed with a closed code; no plaintext is ever in an error or a log.
// Idempotent: a job already past `approved` claims nothing and the call is a no-op.
// ponytail: the JSON document is assembled in memory (at most EXPORT_MAX_MESSAGES bodies); stream-encrypt if the cap is ever raised.
import {
  EXPORT_LINK_TTL_HOURS,
  EXPORT_MAX_ARTEFACT_BYTES,
  EXPORT_MAX_MESSAGES,
  EXPORT_TOO_LARGE_CODE,
  MESSAGING_EXPORT_FORMAT,
  MESSAGING_EXPORT_MANIFEST_VERSION,
  type MessagingExportManifest,
} from "@chartwarden/types";
import { ExportCryptoError, type ExportKeyWrap, sealArtefact, sha256Hex } from "./export-crypto";
import { EXPORT_PATIENT_SUBJECT_CHANNEL_KINDS } from "./export-ports";

export const EXPORT_PAGE_SIZE = 500;
export const EXPORT_FAIL_DECRYPT = "EXPORT_DECRYPT_FAILED";
export const EXPORT_FAIL_KEY = "EXPORT_KEY_UNAVAILABLE";
export const EXPORT_FAIL_PART2 = "EXPORT_PART2_UNKNOWN";
export const EXPORT_FAIL_REQUESTER = "EXPORT_REQUESTER_INELIGIBLE";
export const EXPORT_FAIL_STORE = "EXPORT_STORE_FAILED";
export const EXPORT_FAIL_BUILD = "EXPORT_BUILD_FAILED";
/** A LOWER bound of the JSON bytes per message beyond its body (three uuids, a timestamp, the keys): the running cap never rejects what the final check would accept. */
export const EXPORT_MESSAGE_OVERHEAD_BYTES = 256;
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
  /** The channel's subject column. A PATIENT id only for EXPORT_PATIENT_SUBJECT_CHANNEL_KINDS; a location or role id for the other kinds. */
  readonly subjectId: string | null;
}

export interface ExportMessageRow {
  readonly id: string;
  readonly channelId: string;
  readonly authorUserId: string | null;
  readonly createdAt: Date;
  /** The database text of `created_at` (full microseconds): the keyset cursor is built from this, never from `createdAt`. */
  readonly createdAtText: string;
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
  /** A database timestamptz TEXT (the database clock at the start of the build). */
  readonly until: string;
  /** Part 2 flagged patients: a message referencing one of them is left out of `page` and counted in `count().part2`. */
  readonly part2PatientIds: readonly string[];
}

export interface ExportCursor {
  /** The `createdAtText` of the last row seen. */
  readonly createdAtText: string;
  readonly id: string;
}

/** Every database touch of the build (each call is its own tenant transaction). Implemented by `export-build-store.ts`. */
export interface ExportBuildStore {
  /** approved -> building; null when the job is not `approved` (already claimed, decided otherwise, or unknown): the build is a no-op. */
  claim(organizationId: string, jobId: string): Promise<ExportJobRow | null>;
  channelsFor(organizationId: string, job: ExportJobRow): Promise<readonly ExportChannel[]>;
  /** The DATABASE clock (text for SQL, Date for the manifest). */
  dbNow(organizationId: string): Promise<{ readonly text: string; readonly date: Date }>;
  /** Whether the requester is still an active, non-excluded-category user (rechecked at claim: an approval does not outlive eligibility). */
  requesterEligible(organizationId: string, userId: string): Promise<boolean>;
  /** The distinct patient ids the in-scope messages are tied to (reference, clinical link, promotion request; `part2PatientIds` is ignored). */
  referencedPatients(organizationId: string, query: ExportMessageQuery): Promise<readonly string[]>;
  /** The patient ids each of these messages is tied to right now (a message with none is absent): the per-page Part 2 re-check. */
  messageReferences(
    organizationId: string,
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>>;
  /**
   * Messages with a readable, not author-deleted body in the query; how many of them a legal hold covers (held is a subset of total); and how many
   * NOT held ones reference a `part2PatientIds` patient (part2, disjoint from held).
   */
  count(
    organizationId: string,
    query: ExportMessageQuery,
  ): Promise<{ readonly total: number; readonly held: number; readonly part2: number }>;
  /** The next page, oldest first, held and Part 2 referencing messages excluded, strictly after `after`. */
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
  /** The plaintext byte cap; defaults to EXPORT_MAX_ARTEFACT_BYTES (a test seam). */
  readonly maxArtefactBytes?: number;
}

export type ExportBuildOutcome =
  | { readonly outcome: "skipped" }
  | { readonly outcome: "ready"; readonly messageCount: number }
  /** `errorName` is the class name of what went wrong (never its message): for operations, safe to log. */
  | { readonly outcome: "failed"; readonly failureCode: string; readonly errorName: string };

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
  const isPatientSubject = (c: ExportChannel): c is ExportChannel & { subjectId: string } =>
    c.subjectId !== null &&
    (EXPORT_PATIENT_SUBJECT_CHANNEL_KINDS as readonly string[]).includes(c.kind);

  /**
   * Which patients are Part 2 flagged among (a) the subject patients of care_team / bereavement channels and (b) every patient any in-scope
   * message references. One reader call; a throw (or a reader that reports a stale snapshot) fails the build closed.
   */
  async function split(
    organizationId: string,
    channels: readonly ExportChannel[],
    window: Omit<ExportMessageQuery, "channelIds" | "part2PatientIds">,
  ) {
    const referenced = await deps.store.referencedPatients(organizationId, {
      ...window,
      channelIds: channels.map((c) => c.id),
      part2PatientIds: [],
    });
    const candidates = [
      ...new Set([...channels.filter(isPatientSubject).map((c) => c.subjectId), ...referenced]),
    ];
    let flagged: ReadonlySet<string> = new Set();
    if (candidates.length > 0) {
      try {
        flagged = await deps.part2Patients(organizationId, candidates);
      } catch {
        throw new ExportBuildFailure(EXPORT_FAIL_PART2);
      }
    }
    const gated = (c: ExportChannel) => isPatientSubject(c) && flagged.has(c.subjectId);
    return {
      allowed: channels.filter((c) => !gated(c)).map((c) => c.id),
      gated: channels.filter(gated).map((c) => c.id),
      flagged: [...flagged],
      resolved: new Set(candidates),
    };
  }

  /**
   * Per page: the patients tied to these rows right now. Any id the build has not yet resolved is asked of the flag reader here (a throw fails
   * closed); a row tied to a flagged patient is dropped. Closes the window between the up-front decision and the page read.
   */
  async function recheckPart2(
    organizationId: string,
    rows: readonly ExportMessageRow[],
    state: { resolved: Set<string>; flagged: Set<string> },
  ): Promise<ReadonlySet<string>> {
    const refs = await deps.store.messageReferences(
      organizationId,
      rows.map((r) => r.id),
    );
    const fresh = [...new Set([...refs.values()].flat())].filter((id) => !state.resolved.has(id));
    if (fresh.length > 0) {
      let nowFlagged: ReadonlySet<string>;
      try {
        nowFlagged = await deps.part2Patients(organizationId, fresh);
      } catch {
        throw new ExportBuildFailure(EXPORT_FAIL_PART2);
      }
      for (const id of fresh) state.resolved.add(id);
      for (const id of nowFlagged) state.flagged.add(id);
    }
    return new Set(
      rows
        .filter((r) => (refs.get(r.id) ?? []).some((id) => state.flagged.has(id)))
        .map((r) => r.id),
    );
  }

  // Bounded by EXPORT_MAX_MESSAGES and a running byte total (stops before the whole document is held); a hold released between the count and a page
  // may add rows, which the manifest then counts as listed.
  async function collect(
    organizationId: string,
    query: ExportMessageQuery,
    part2: { resolved: Set<string>; flagged: Set<string> },
  ) {
    const out: unknown[] = [];
    const maxBytes = deps.maxArtefactBytes ?? EXPORT_MAX_ARTEFACT_BYTES;
    let bytes = 0;
    let dropped = 0;
    let after: ExportCursor | null = null;
    while (query.channelIds.length > 0) {
      const rows = await deps.store.page(organizationId, query, after, EXPORT_PAGE_SIZE);
      if (rows.length === 0) break;
      const newlyFlagged = await recheckPart2(organizationId, rows, part2);
      const attachments = await deps.store.attachments(
        organizationId,
        rows.map((r) => r.id),
      );
      for (const row of rows) {
        if (newlyFlagged.has(row.id)) {
          dropped += 1;
          continue;
        }
        const body = await deps.openBody(organizationId, row.bodyCipher);
        bytes += Buffer.byteLength(body, "utf8") + EXPORT_MESSAGE_OVERHEAD_BYTES;
        out.push({
          id: row.id,
          channelId: row.channelId,
          senderId: row.authorUserId,
          sentAt: row.createdAt.toISOString(),
          kind: row.bodyKind,
          status: row.status,
          body,
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
        if (out.length > EXPORT_MAX_MESSAGES || bytes > maxBytes)
          throw new ExportBuildFailure(EXPORT_TOO_LARGE_CODE);
      }
      const last = rows[rows.length - 1];
      if (!last || rows.length < EXPORT_PAGE_SIZE) break;
      after = { createdAtText: last.createdAtText, id: last.id };
    }
    return { messages: out, dropped };
  }

  async function build(job: ExportJobRow): Promise<ExportBuildOutcome> {
    const { organizationId } = job;
    if (!(await deps.store.requesterEligible(organizationId, job.requestedBy))) {
      throw new ExportBuildFailure(EXPORT_FAIL_REQUESTER);
    }
    const startedAt = await deps.store.dbNow(organizationId);
    const { from, to } = windowOf(job);
    const window = { from, to, until: startedAt.text };
    const channels = await deps.store.channelsFor(organizationId, job);
    const { allowed, gated, flagged, resolved } = await split(organizationId, channels, window);
    const allowedQuery = { ...window, channelIds: allowed, part2PatientIds: flagged };
    const allowedCount = await deps.store.count(organizationId, allowedQuery);
    const gatedCount =
      gated.length > 0
        ? await deps.store.count(organizationId, {
            ...window,
            channelIds: gated,
            part2PatientIds: [],
          })
        : { total: 0, held: 0, part2: 0 };
    const included = allowedCount.total - allowedCount.held - allowedCount.part2;
    if (included > EXPORT_MAX_MESSAGES) throw new ExportBuildFailure(EXPORT_TOO_LARGE_CODE);

    const collected = await collect(organizationId, allowedQuery, {
      resolved: new Set(resolved),
      flagged: new Set(flagged),
    });
    const { messages } = collected;
    const part2Excluded = gatedCount.total + allowedCount.part2 + collected.dropped;
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
      generatedAt: startedAt.date.toISOString(),
      // The authoritative instant is the row's expires_at (DB clock, stamped at ready); this is the same 24 h from generation.
      expiresAt: new Date(
        startedAt.date.getTime() + EXPORT_LINK_TTL_HOURS * 3_600_000,
      ).toISOString(),
      messageCount: messages.length,
      heldExcluded: allowedCount.held,
      part2Excluded,
    };
    const plaintext = Buffer.from(JSON.stringify({ manifest, messages }), "utf8");
    if (plaintext.length > (deps.maxArtefactBytes ?? EXPORT_MAX_ARTEFACT_BYTES))
      throw new ExportBuildFailure(EXPORT_TOO_LARGE_CODE);
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
        part2Excluded,
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
        return {
          outcome: "failed",
          failureCode,
          errorName: error instanceof Error ? error.name : "unknown",
        };
      }
    },
  };
}

export type ExportBuilder = ReturnType<typeof createExportBuilder>;
