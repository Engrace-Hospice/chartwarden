// @wardenx/inpatient — M37-T04, §2.2 D2. The pure `ipu_admission` lifecycle machine — the M37 unit-of-work,
// one-to-one with an M6 level_of_care_period for the IPU levels (GIP / IRC), or an arranged remote-IPU
// episode. IO-free and deterministic: per-event facts (M6 LCP ack, RN-coverage active, GIP criteria present,
// discharge/death events, room occupancy) are resolved upstream (the M6 outbox consumers, the RN-coverage
// ABAC predicate, the M5 privacy reader) and injected as plain data, so the machine unit-tests with no IO.
// The service/route layer (M37-T11) loads the admission under RLS, checks `If-Match`, calls the transition,
// then writes the ipu_admission_state_history row + the returned side-effects (bed-cleaning transitions on
// the source bed, child-row opens, outbox) in one tx.
//
// The §2.2 mermaid graph:
//   [*] ─open──────────────→ pending          (M6 emits level_of_care.requires_ipu_bed)
//   pending ─requestBed────→ bed_pending
//   bed_pending ─assignBed→ bed_assigned      (persists ipu_bed_assignment; source bed → reserved)
//   bed_assigned ─confirm─→ active            (M6 LCP ack; GIP criteria required; IRC opens irc_episode; bed → occupied)
//   active ─initiateTransfer→ transferring
//   transferring ─confirmTransfer→ transferred (source bed → discharged_dirty)
//   active ─discharge──────→ discharged        (source bed → discharged_dirty; IRC closes irc_episode)
//   active ─recordDeath────→ deceased          (auto-opens ipu_body_release; bed stays occupied until release)
//   {discharged,transferred,deceased} ─postCloseSettlement→ closed
import type { IpuAdmissionKind, IpuAdmissionState, IpuBedId } from "@wardenx/types";
import { IpuStateError, requireIpu } from "../errors";
import type { BedCleaningEvent } from "./ipu-bed";

/** The §4.4 `m37.ipu_admission.*` outbox event names this machine emits. */
export type IpuAdmissionOutboxEvent =
  | "m37.ipu_admission.opened"
  | "m37.ipu_admission.bed_requested"
  | "m37.ipu_admission.bed_assigned"
  | "m37.ipu_admission.activated"
  | "m37.ipu_admission.transferring"
  | "m37.ipu_admission.transferred"
  | "m37.ipu_admission.discharged"
  | "m37.ipu_admission.death_recorded"
  | "m37.ipu_admission.closed";

/** A declarative in-transaction side effect the service (M37-T11) interprets under RLS. */
export type IpuAdmissionEffect =
  | { readonly kind: "state_history"; readonly to: IpuAdmissionState }
  | { readonly kind: "persist_bed_assignment"; readonly bedId: IpuBedId }
  | { readonly kind: "source_bed_cleaning"; readonly event: BedCleaningEvent }
  /** §2.11 — a death delays the source bed's `discharged_dirty` transition until body release completes. */
  | { readonly kind: "defer_bed_dirty_until_body_release" }
  | { readonly kind: "open_irc_episode" }
  | { readonly kind: "close_irc_episode" }
  | { readonly kind: "open_body_release" }
  | { readonly kind: "outbox"; readonly event: IpuAdmissionOutboxEvent };

/** The deterministic result of an admission transition: the new state + the ordered §2.4 side-effect list. */
export interface AdmissionTransition {
  /** `null` for `open` (the row is created), otherwise the prior state. */
  readonly from: IpuAdmissionState | null;
  readonly to: IpuAdmissionState;
  readonly event: string;
  readonly effects: readonly IpuAdmissionEffect[];
}

/** A §2.2 lifecycle event. Injected facts carry the upstream guard evaluation (no IO in the machine). */
export type IpuAdmissionEvent =
  | {
      readonly type: "requestBed";
      readonly unitActive: boolean;
      readonly rnCoverageActive: boolean;
      readonly hasReadyBed: boolean;
    }
  | {
      readonly type: "assignBed";
      readonly bedId: IpuBedId;
      readonly bedReady: boolean;
      /** M5 PrivacyFlagReader: the target room is not occupied by an opposite-sex patient (or is private). */
      readonly roomOccupancyAllowed: boolean;
    }
  | {
      readonly type: "confirm";
      /** M6 LCP bed-assignment ack received in the 30s window, OR force-flagged by the coordinator after. */
      readonly lcpConfirmed: boolean;
      /** §2.2 — a GIP admission requires a gip_admission_criteria row to exist before activation. */
      readonly gipCriteriaExists: boolean;
    }
  | {
      readonly type: "initiateTransfer";
      readonly targetKind: "to_unit" | "to_home" | "to_facility";
      /** For to_unit: the destination unit has active RN coverage (ignored for to_home / to_facility). */
      readonly destinationRnCoverage: boolean;
    }
  | { readonly type: "confirmTransfer"; readonly destinationAcknowledged: boolean }
  | { readonly type: "discharge"; readonly dischargeEventExists: boolean }
  | {
      readonly type: "recordDeath";
      readonly deathEventReferencesAdmission: boolean;
      /** §2.2 — recordDeath is driven by the M6 death consumer (system actor), never a human route. */
      readonly isSystemActor: boolean;
    }
  | { readonly type: "postCloseSettlement"; readonly isSystemActor: boolean; readonly noOpenChildRows: boolean };

/** The legal §2.2 transition graph (from → events accepted). `closed` is terminal. */
export const ADMISSION_GRAPH: Readonly<Record<IpuAdmissionState, ReadonlyArray<IpuAdmissionEvent["type"]>>> = {
  pending: ["requestBed"],
  bed_pending: ["assignBed"],
  bed_assigned: ["confirm"],
  active: ["initiateTransfer", "discharge", "recordDeath"],
  transferring: ["confirmTransfer"],
  transferred: ["postCloseSettlement"],
  discharged: ["postCloseSettlement"],
  deceased: ["postCloseSettlement"],
  closed: [],
};

/**
 * §2.2 — plan the creation of a new IPU admission (the `[*] → pending` edge). GIP/IRC admissions require the
 * unit's RN coverage active (D3); an arranged remote-IPU admission bypasses that gate (the agency does not
 * own the unit). Returns the initial state + the `opened` outbox.
 */
export function planOpenAdmission(
  kind: IpuAdmissionKind,
  facts: { readonly rnCoverageActive: boolean },
): AdmissionTransition {
  if (kind !== "arranged") {
    requireIpu(
      facts.rnCoverageActive,
      "IPU_RN_COVERAGE_UNAVAILABLE",
      "A GIP/IRC IPU admission cannot open while the unit's 24/7 RN coverage is inactive (D3).",
    );
  }
  return {
    from: null,
    to: "pending",
    event: "open",
    effects: [
      { kind: "state_history", to: "pending" },
      { kind: "outbox", event: "m37.ipu_admission.opened" },
    ],
  };
}

/**
 * Apply a §2.2 lifecycle event. Throws {@link IpuStateError} `ILLEGAL_ADMISSION_TRANSITION` when the event is
 * not accepted from `from`, or the precise guard code on a guard failure. `kind` is the admission's intrinsic
 * GIP/IRC/arranged discriminator (drives the GIP-criteria gate and the IRC episode open/close side-effects).
 */
export function transitionAdmission(
  from: IpuAdmissionState,
  kind: IpuAdmissionKind,
  event: IpuAdmissionEvent,
): AdmissionTransition {
  if (!ADMISSION_GRAPH[from].includes(event.type)) {
    throw new IpuStateError(
      "ILLEGAL_ADMISSION_TRANSITION",
      `ipu_admission cannot ${event.type} from '${from}' (§2.2 graph; 'closed' is terminal).`,
    );
  }

  switch (event.type) {
    case "requestBed": {
      requireIpu(event.unitActive, "IPU_UNIT_INACTIVE", "The IPU unit is not active.");
      requireIpu(
        event.rnCoverageActive,
        "IPU_RN_COVERAGE_UNAVAILABLE",
        "The unit's 24/7 RN coverage is inactive; bed request is blocked (D3).",
      );
      requireIpu(event.hasReadyBed, "IPU_NO_READY_BED", "The unit has no bed in 'ready' state.");
      return {
        from,
        to: "bed_pending",
        event: event.type,
        effects: [
          { kind: "state_history", to: "bed_pending" },
          { kind: "outbox", event: "m37.ipu_admission.bed_requested" },
        ],
      };
    }

    case "assignBed": {
      requireIpu(event.bedReady, "IPU_BED_NOT_READY", "The target bed is not in 'ready' state.");
      requireIpu(
        event.roomOccupancyAllowed,
        "IPU_ROOM_OCCUPANCY_CONFLICT",
        "The room is occupied by an opposite-sex patient without a private room / privacy-flag permit (M5).",
      );
      return {
        from,
        to: "bed_assigned",
        event: event.type,
        effects: [
          { kind: "state_history", to: "bed_assigned" },
          { kind: "persist_bed_assignment", bedId: event.bedId },
          { kind: "source_bed_cleaning", event: "reserve" },
          { kind: "outbox", event: "m37.ipu_admission.bed_assigned" },
        ],
      };
    }

    case "confirm": {
      requireIpu(
        event.lcpConfirmed,
        "ADMISSION_LCP_NOT_CONFIRMED",
        "The M6 LCP bed-assignment ack has not arrived (and was not force-flagged past the 30s window).",
      );
      if (kind === "gip") {
        requireIpu(
          event.gipCriteriaExists,
          "GIP_CRITERIA_REQUIRED",
          "A GIP admission cannot activate without a gip_admission_criteria row (the criteria are the activation step).",
        );
      }
      const effects: IpuAdmissionEffect[] = [
        { kind: "state_history", to: "active" },
        { kind: "source_bed_cleaning", event: "occupy" },
      ];
      if (kind === "irc") effects.push({ kind: "open_irc_episode" });
      effects.push({ kind: "outbox", event: "m37.ipu_admission.activated" });
      return { from, to: "active", event: event.type, effects };
    }

    case "initiateTransfer": {
      if (event.targetKind === "to_unit") {
        requireIpu(
          event.destinationRnCoverage,
          "ADMISSION_DESTINATION_RN_COVERAGE",
          "The destination unit lacks active RN coverage; the transfer cannot be initiated.",
        );
      }
      return {
        from,
        to: "transferring",
        event: event.type,
        effects: [
          { kind: "state_history", to: "transferring" },
          { kind: "outbox", event: "m37.ipu_admission.transferring" },
        ],
      };
    }

    case "confirmTransfer": {
      requireIpu(
        event.destinationAcknowledged,
        "ADMISSION_TRANSFER_NOT_ACKNOWLEDGED",
        "The destination has not acknowledged the transfer.",
      );
      return {
        from,
        to: "transferred",
        event: event.type,
        effects: [
          { kind: "state_history", to: "transferred" },
          { kind: "source_bed_cleaning", event: "dischargeDirty" },
          { kind: "outbox", event: "m37.ipu_admission.transferred" },
        ],
      };
    }

    case "discharge": {
      requireIpu(
        event.dischargeEventExists,
        "ADMISSION_DISCHARGE_EVENT_MISSING",
        "A discharge requires the M6 discharge_event to exist.",
      );
      const effects: IpuAdmissionEffect[] = [
        { kind: "state_history", to: "discharged" },
        { kind: "source_bed_cleaning", event: "dischargeDirty" },
      ];
      if (kind === "irc") effects.push({ kind: "close_irc_episode" });
      effects.push({ kind: "outbox", event: "m37.ipu_admission.discharged" });
      return { from, to: "discharged", event: event.type, effects };
    }

    case "recordDeath": {
      requireIpu(
        event.isSystemActor,
        "ADMISSION_SYSTEM_ACTOR_REQUIRED",
        "recordDeath is driven by the M6 death consumer (system actor), not a human route.",
      );
      requireIpu(
        event.deathEventReferencesAdmission,
        "ADMISSION_DEATH_EVENT_MISMATCH",
        "The M6 death_event does not reference this admission.",
      );
      // §2.11 — the bed does NOT go dirty yet; the body stays in the room until release completes.
      return {
        from,
        to: "deceased",
        event: event.type,
        effects: [
          { kind: "state_history", to: "deceased" },
          { kind: "open_body_release" },
          { kind: "defer_bed_dirty_until_body_release" },
          { kind: "outbox", event: "m37.ipu_admission.death_recorded" },
        ],
      };
    }

    case "postCloseSettlement": {
      requireIpu(
        event.isSystemActor,
        "ADMISSION_SYSTEM_ACTOR_REQUIRED",
        "postCloseSettlement is driven by the T+7 reconciliation cron (system actor).",
      );
      requireIpu(
        event.noOpenChildRows,
        "ADMISSION_OPEN_CHILD_ROWS",
        "The admission has an open child row (unfinalized GIP criteria / open irc_episode / incomplete body release).",
      );
      return {
        from,
        to: "closed",
        event: event.type,
        effects: [
          { kind: "state_history", to: "closed" },
          { kind: "outbox", event: "m37.ipu_admission.closed" },
        ],
      };
    }
  }
}

/** Whether an admission state is terminal (`closed`). */
export function isAdmissionClosed(state: IpuAdmissionState): boolean {
  return state === "closed";
}

/** §2.2 — the states in which an admission occupies a live bed (for census + tenant-offboarding gates). */
export function admissionHoldsBed(state: IpuAdmissionState): boolean {
  return state === "bed_assigned" || state === "active" || state === "transferring" || state === "deceased";
}
