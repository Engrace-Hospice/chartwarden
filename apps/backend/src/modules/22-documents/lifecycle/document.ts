// apps/backend/src/modules/22-documents/lifecycle/document.ts — M22-T03 (§2.2.1 / §2.4 / D12).
//
// The `document` aggregate lifecycle (§2.2.1): active is the steady state; new versions never transition
// the document (they flip `active_version_id` — see ./version); the only status transitions are the M4
// legal-hold place/release (active ↔ legal_hold) and the destruction-cert tombstone (active →
// destroyed_tombstone, never from legal_hold). Pure transition function over injected facts — it validates
// the event is legal from the current state (§2.2.1 graph; nothing transitions on a string match), runs
// the §2.3 / D12 guards (failures raise the precise code via DocumentStateError), and returns the new
// state + the §2.4 in-transaction side-effect list the service executes. No IO; the MinIO destroy is a
// descriptor (./effects), the real delete runs via the injected DocumentStorageProvider port.
import type { DocumentStatus, IsoInstant } from "@wardenx/types";
import { type DocumentSideEffect, type DocumentTransitionResult, result } from "./effects";
import { DocumentStateError, require_ } from "./errors";

export type DocumentState = DocumentStatus;

/** The §2.2.1 document lifecycle events (the status transitions; versioning is a separate machine). */
export type DocumentEvent =
  | {
      /** M4 `legal_hold.applied` landed — place a hold (active → legal_hold). */
      readonly type: "placeLegalHold";
      readonly legalHoldEventId: string;
      readonly at: IsoInstant;
    }
  | {
      /** M4 `legal_hold.released` landed — release the hold (legal_hold → active). */
      readonly type: "releaseLegalHold";
      readonly at: IsoInstant;
    }
  | {
      /** M4 `destruction_cert.signed` — tombstone the row after the version-aware shred (D12). */
      readonly type: "tombstone";
      readonly certificateId: string;
      /** The set of MinIO object keys (every version) the storage port must version-delete. */
      readonly objectKeys: ReadonlyArray<string>;
      readonly bucket: string;
      readonly at: IsoInstant;
    };

export type DocumentLifecycleTransition = DocumentTransitionResult<
  DocumentState,
  DocumentEvent["type"]
>;

/** The legal §2.2.1 status graph (from → events accepted). Guards are checked separately. A document in
 * `legal_hold` can ONLY release back to active — it can never tombstone (D12 legal-hold-immutability). */
export const DOCUMENT_GRAPH: Readonly<
  Record<DocumentState, ReadonlyArray<DocumentEvent["type"]>>
> = {
  active: ["placeLegalHold", "tombstone"],
  legal_hold: ["releaseLegalHold"],
  superseded: ["placeLegalHold", "tombstone"],
  destroyed_tombstone: [],
};

/**
 * Apply a `document` status-lifecycle event (§2.2.1). Throws {@link DocumentStateError} `ILLEGAL_TRANSITION`
 * if the event is not accepted from `from` (e.g. a tombstone attempt while `legal_hold` — the structural
 * D12 guard), or the specific guard code on a guard failure.
 */
export function transitionDocument(
  from: DocumentState,
  event: DocumentEvent,
): DocumentLifecycleTransition {
  if (!DOCUMENT_GRAPH[from].includes(event.type)) {
    // The legal_hold → tombstone attempt funnels here: the graph forbids it, so D12 is enforced
    // structurally. Surface the precise code so the UI/audit reads the legal-hold reason, not a generic
    // "illegal transition".
    if (event.type === "tombstone" && from === "legal_hold") {
      throw new DocumentStateError(
        "LEGAL_HOLD_BLOCKS_DESTRUCTION",
        "a document under an active legal hold cannot be destroyed (D12)",
      );
    }
    if (event.type === "tombstone" && from === "destroyed_tombstone") {
      throw new DocumentStateError(
        "ALREADY_TOMBSTONED",
        "the document is already tombstoned",
      );
    }
    throw new DocumentStateError(
      "ILLEGAL_TRANSITION",
      `document cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "placeLegalHold": {
      return result(from, event.type, "legal_hold", [
        { kind: "insert_legal_hold", legalHoldEventId: event.legalHoldEventId },
        { kind: "set_timestamp", field: "legal_hold_applied_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m22.document.legal_hold_applied" },
      ]);
    }
    case "releaseLegalHold": {
      // §2.2.1: a held document always releases back to `active` (the held state was reversible).
      return result(from, event.type, "active", [
        { kind: "release_legal_hold" },
        { kind: "set_timestamp", field: "legal_hold_released_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m22.document.legal_hold_released" },
      ]);
    }
    case "tombstone": {
      // D12: version-aware destroy of EVERY object version + delete-marker, then DEK shred, then tombstone
      // the row (preserved for FK integrity) and null the active version. A destruction-cert access-log
      // row is appended; existing access-log rows within the §164.528 floor are NOT dropped (the service
      // does no deletes here — the eraser path is append-only on the log).
      const effects: DocumentSideEffect[] = [
        { kind: "destroy_objects", bucket: event.bucket, objectKeys: event.objectKeys },
        { kind: "shred_dek" },
        { kind: "null_active_version" },
        { kind: "access_log", accessKind: "disclosure_export", at: event.at },
        { kind: "set_timestamp", field: "tombstoned_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m22.document.tombstoned" },
        { kind: "outbox", event: "m22.eraser.completed" },
      ];
      return result(from, event.type, "destroyed_tombstone", effects);
    }
  }
}

/**
 * The D12 destruction-cert fan-out decision for one document: is it skippable (active legal hold) or
 * destroyable? Returns the side-effect list for the SKIP case (emit `m22.eraser.legal_hold_skip`, no
 * tombstone) when a hold is active; otherwise null to signal "proceed to {@link transitionDocument}
 * tombstone". Pure over the injected legal-hold fact; keeps the eraser worker's per-document branch
 * testable with no DB.
 */
export function planDestructionForDocument(args: {
  readonly status: DocumentState;
  readonly legalHoldActive: boolean;
  readonly certificateId: string;
  readonly legalHoldEventId: string | null;
  readonly at: IsoInstant;
}): { readonly skipped: true; readonly effects: ReadonlyArray<DocumentSideEffect> } | null {
  if (args.status === "destroyed_tombstone") {
    throw new DocumentStateError("ALREADY_TOMBSTONED", "the document is already tombstoned");
  }
  if (args.legalHoldActive || args.status === "legal_hold") {
    return {
      skipped: true,
      effects: [
        { kind: "audit" },
        { kind: "outbox", event: "m22.eraser.legal_hold_skip" },
      ],
    };
  }
  return null;
}

/** Guard helper: assert a document is not already tombstoned before a status-mutating op (§2.2.1). */
export function assertNotTombstoned(status: DocumentState): void {
  require_(
    status !== "destroyed_tombstone",
    "ALREADY_TOMBSTONED",
    "the document is already tombstoned",
  );
}
