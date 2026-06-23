// apps/backend/src/modules/22-documents/lifecycle/version.ts — M22-T03 (§2.2.2 / §2.3 / D2).
//
// The `document_version` append-only versioning machine (D2). Versions are immutable rows; there is no
// state column and no per-version `is_current` flag — `document.active_version_id` is the single source of
// "current". "Superseding" a document is an INSERT of a new version + a flip of `active_version_id` (and,
// for the D21 two-PDF external-source case, the prior document `status='superseded'`). This module is pure
// planning + the §2.3 versioning guards: version-number monotonicity, active-version FK integrity,
// sha256 immutability. No IO; the byte payload + MinIO write live behind the storage port.
import { type DocumentSideEffect, type DocumentTransitionResult, result } from "./effects";
import { DocumentStateError, require_ } from "./errors";

/** §2.3 — `document_version.version_number` strictly increases within a document (the DB CHECK mirror). A
 * version-number that is not strictly greater than the current max is refused at plan time. */
export function assertMonotonicVersion(
  currentMaxVersion: number,
  proposedVersion: number,
): void {
  require_(
    proposedVersion > currentMaxVersion,
    "VERSION_NUMBER_NOT_MONOTONIC",
    `version ${proposedVersion} must be strictly greater than the current max ${currentMaxVersion}`,
  );
}

/** §2.3 — `document.active_version_id` MUST point at a version whose `document_id = self.id` (the DB CHECK
 * mirror). A flip to a version belonging to another document is refused. */
export function assertActiveVersionBelongs(
  documentId: string,
  versionDocumentId: string,
): void {
  require_(
    documentId === versionDocumentId,
    "ACTIVE_VERSION_FOREIGN",
    "active_version_id must reference a version of this document",
  );
}

/** §2.3 — `document_version.sha256_hex` is never updated post-insert (the M4 denylist / service refusal
 * mirror). Any attempt to write a different hash to an existing version row is refused. */
export function assertSha256Immutable(
  existingSha256: string | null,
  incomingSha256: string,
): void {
  if (existingSha256 !== null && existingSha256 !== incomingSha256) {
    throw new DocumentStateError(
      "SHA256_IMMUTABLE",
      "document_version.sha256_hex is immutable post-insert",
    );
  }
}

/** The plan for adding a version to a document. `isFirstVersion` distinguishes v1 (genesis;
 * `m22.document.created`) from n≥2 (`m22.document.versioned`). `supersedePrior` (the D21 two-PDF case)
 * marks the prior document `status='superseded'` when a post-cosign version lands. */
export interface AddVersionPlan {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly isFirstVersion: boolean;
  readonly isCorrection: boolean;
  readonly supersedePrior: boolean;
}

/**
 * Plan the append of a new `document_version` row + the `active_version_id` flip (§2.2.2 / D2). Runs the
 * §2.3 monotonicity guard, then returns the new version-side state-effect list: the version is appended
 * (append-only — prior versions are preserved), the document's `active_version_id` flips to the new
 * version, and — for a correction (`replaces_version_id IS NOT NULL`) — a `correction_reason`
 * `document_tag` row is implied (the service writes the tag; here it is an audit marker). The first
 * version emits `m22.document.created`; subsequent versions emit `m22.document.versioned`.
 */
export function planAddVersion(args: {
  readonly documentId: string;
  readonly currentMaxVersion: number;
  readonly plan: AddVersionPlan;
}): DocumentTransitionResult<"active", "addVersion"> {
  const { plan } = args;
  // genesis (v1) has no prior version to be monotonic against; n≥2 must strictly increase.
  if (!plan.isFirstVersion) {
    assertMonotonicVersion(args.currentMaxVersion, plan.versionNumber);
  } else {
    require_(
      plan.versionNumber === 1,
      "VERSION_NUMBER_NOT_MONOTONIC",
      "the first version must be version 1",
    );
  }

  const effects: DocumentSideEffect[] = [
    { kind: "flip_active_version", versionId: plan.versionId },
    { kind: "audit" },
  ];
  // The D21 two-PDF external-source case: the prior pre-cosign PDF persists with status='superseded'.
  if (plan.supersedePrior) {
    effects.unshift({ kind: "set_status", status: "superseded" });
  }
  effects.push({
    kind: "outbox",
    event: plan.isFirstVersion ? "m22.document.created" : "m22.document.versioned",
  });

  // Genesis lands the document in `active`; an n≥2 version keeps it active (status changes, if any, are the
  // explicit supersede above — the version flip itself never transitions the document, §2.2.1).
  return result("active", "addVersion", "active", effects);
}
