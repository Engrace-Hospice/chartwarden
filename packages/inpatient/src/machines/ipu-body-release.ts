// @wardenx/inpatient — M37-T09, §2.11 D12. The post-mortem body-release coordination machine. An
// `ipu_body_release` row auto-opens on `m6.discharge.death` for an IPU patient (§2.2 recordDeath); this
// machine drives pending → funeral_home_identified → released → closed, wiring M40's FuneralHomeReader and
// M22's body_release_authorization render + magic-link session. Critically, the source bed does NOT go
// `discharged_dirty` until release COMPLETES (the body stays in the room until the funeral home arrives) —
// so `releaseBody` carries the deferred bed-cleaning transition (§2.12). Pure & IO-free.
import type { IpuBodyReleaseState } from "@wardenx/types";
import { IpuStateError, requireIpu } from "../errors";
import type { BedCleaningEvent } from "./ipu-bed";

/** The §4.4 `m37.body_release.*` outbox events this machine emits. */
export type BodyReleaseOutboxEvent =
  | "m37.body_release.pending"
  | "m37.body_release.funeral_home_identified"
  | "m37.body_release.document_requested"
  | "m37.body_release.completed";

/** A declarative side effect the service (M37-T11) interprets. */
export type BodyReleaseEffect =
  | { readonly kind: "state"; readonly to: IpuBodyReleaseState }
  /** §2.12 — resume the source bed's cleaning cycle (discharged_dirty) now that release completed. */
  | {
      readonly kind: "source_bed_cleaning";
      readonly event: Extract<BedCleaningEvent, "dischargeDirty">;
    }
  | { readonly kind: "outbox"; readonly event: BodyReleaseOutboxEvent };

/** The deterministic result of a body-release transition. */
export interface BodyReleaseTransition {
  readonly from: IpuBodyReleaseState | null;
  readonly to: IpuBodyReleaseState;
  readonly event: string;
  readonly effects: readonly BodyReleaseEffect[];
}

/** A §2.11 body-release event; per-event facts (M40 resolution, M22 doc) are injected. */
export type BodyReleaseEvent =
  | {
      readonly type: "identifyFuneralHome";
      /** The M40 FuneralHomeReader resolved the selected funeral home for this org. */
      readonly funeralHomeResolved: boolean;
    }
  | {
      readonly type: "releaseBody";
      /** The signed M22 body_release_authorization document is attached (release_document_id set). */
      readonly hasReleaseDocument: boolean;
      /** GAP-106 — a document WAS named but M22 did not prove it is this release's authorization. */
      readonly documentRejected?: boolean;
    }
  | { readonly type: "postClose"; readonly isSystemActor: boolean };

/** The legal §2.11 transition graph. `closed` is terminal. */
export const BODY_RELEASE_GRAPH: Readonly<
  Record<IpuBodyReleaseState, ReadonlyArray<BodyReleaseEvent["type"]>>
> = {
  pending: ["identifyFuneralHome"],
  funeral_home_identified: ["releaseBody"],
  released: ["postClose"],
  closed: [],
};

/**
 * §2.11 — plan the auto-open of a body-release record (the `[*] → pending` edge fired by the
 * `m6.discharge.death` consumer for an IPU-facility death). Emits `m37.body_release.pending`.
 */
export function planOpenBodyRelease(): BodyReleaseTransition {
  return {
    from: null,
    to: "pending",
    event: "open",
    effects: [
      { kind: "state", to: "pending" },
      { kind: "outbox", event: "m37.body_release.pending" },
    ],
  };
}

/**
 * Apply a §2.11 body-release event. Throws {@link IpuStateError} `ILLEGAL_BODY_RELEASE_TRANSITION` when the
 * event is not accepted from `from`, or the precise guard code. `identifyFuneralHome` emits the M22
 * magic-link trigger + the body-release-form render request; `releaseBody` (fired by the
 * `m22.document.rendered` back-ref consumer) completes release AND resumes the source bed's cleaning cycle.
 */
export function transitionBodyRelease(
  from: IpuBodyReleaseState,
  event: BodyReleaseEvent,
): BodyReleaseTransition {
  if (!BODY_RELEASE_GRAPH[from].includes(event.type)) {
    throw new IpuStateError(
      "ILLEGAL_BODY_RELEASE_TRANSITION",
      `ipu_body_release cannot ${event.type} from '${from}' (§2.11 graph; 'closed' is terminal).`,
    );
  }

  switch (event.type) {
    case "identifyFuneralHome": {
      requireIpu(
        event.funeralHomeResolved,
        "BODY_RELEASE_FUNERAL_HOME_UNRESOLVED",
        "identifyFuneralHome requires a resolved M40 FuneralHome.",
      );
      return {
        from,
        to: "funeral_home_identified",
        event: event.type,
        effects: [
          { kind: "state", to: "funeral_home_identified" },
          // M22 issues the funeral-home magic-link session (architecture §7.8) …
          { kind: "outbox", event: "m37.body_release.funeral_home_identified" },
          // … and renders the body_release_authorization document.
          { kind: "outbox", event: "m37.body_release.document_requested" },
        ],
      };
    }

    case "releaseBody": {
      requireIpu(
        event.documentRejected !== true,
        "BODY_RELEASE_DOCUMENT_INVALID",
        "releaseBody names a document that is not an active M22 body_release_authorization filed against this release and patient.",
      );
      requireIpu(
        event.hasReleaseDocument,
        "BODY_RELEASE_DOCUMENT_REQUIRED",
        "releaseBody requires an active M22 body_release_authorization document filed against this release. " +
          "M22 exposes no signed-state fact, so 'signed' is approximated by active-with-an-active-version " +
          "and is NOT proof of a captured signature.",
      );
      return {
        from,
        to: "released",
        event: event.type,
        effects: [
          { kind: "state", to: "released" },
          // §2.12 — NOW the bed resumes its cleaning cycle (deferred at recordDeath).
          { kind: "source_bed_cleaning", event: "dischargeDirty" },
          { kind: "outbox", event: "m37.body_release.completed" },
        ],
      };
    }

    case "postClose": {
      requireIpu(
        event.isSystemActor,
        "ILLEGAL_BODY_RELEASE_TRANSITION",
        "postClose is driven by the T+24h sweep (system actor).",
      );
      return {
        from,
        to: "closed",
        event: event.type,
        effects: [{ kind: "state", to: "closed" }],
      };
    }
  }
}

/** Whether a body-release record is terminal (`closed`). */
export function isBodyReleaseClosed(state: IpuBodyReleaseState): boolean {
  return state === "closed";
}
