// @chartwarden/idg — §2.4 D1 / §2.7 / W-PKT-02 packet freeze + since-cursor resolution (M14-T04). Pure.
//
// Two build-time invariants the M14-T05 service composes over the upsert:
//   • the §1.1 "since last IDG" cursor — the prior meeting's `adjourned_at` for THIS patient, falling back
//     to the admission `activated_at` when there is no prior IDG (the `first_idg` context);
//   • the W-PKT-02 freeze guard — a packet whose `frozen_at` is set (the meeting adjourned, the row is now a
//     survey-reconstruction artifact) refuses every rebuild with `PACKET_FROZEN`. The §3.4 trigger repeats
//     this at the schema layer (M14-T02); this is the application-layer first line + the unit-testable
//     decider the route handler for `POST /meetings/:id/packets/build` calls before re-running the builder.
import type { IsoInstant } from "@chartwarden/types";
import { require_ } from "../lifecycle/errors";

/** The resolved §1.1 cursor + the context discriminator stamped into `PacketSnapshot.meta`. */
export interface SinceCursor {
  readonly sinceCursorIso: IsoInstant;
  readonly sinceContext: "prior_idg" | "first_idg";
}

/**
 * Resolve the "since last IDG" cursor (§1.1 / §2.4): the prior meeting's `adjourned_at` for this patient
 * when one exists (`prior_idg`), else the admission `activated_at` (`first_idg`). The builder filters every
 * since-block strictly after this instant; the M14-T05 service supplies the prior adjournment from the
 * `IdgScheduleProvider` join (or `null` for the patient's first IDG).
 */
export function resolveSinceCursor(
  priorIdgAdjournedAt: IsoInstant | null,
  admissionActivatedAt: IsoInstant,
): SinceCursor {
  return priorIdgAdjournedAt !== null
    ? { sinceCursorIso: priorIdgAdjournedAt, sinceContext: "prior_idg" }
    : { sinceCursorIso: admissionActivatedAt, sinceContext: "first_idg" };
}

/**
 * The W-PKT-02 freeze guard: refuse any (re)build of a frozen packet (`422 PACKET_FROZEN`). Once the meeting
 * transitions `live → adjourned`, `freeze_packets` stamps `frozen_at`; the snapshot is immutable from then on
 * (survey reconstruction). Corrections are recorded as decisions in the NEXT meeting (the carry-forward
 * agenda surface), never by editing the adjourned packet. Pre-meeting rebuilds (`frozen_at IS NULL`) pass and
 * upsert in place — idempotent on `(meeting_id, patient_id)` (D5).
 */
export function assertPacketWritable(packet: { readonly frozenAt: IsoInstant | null }): void {
  require_(
    packet.frozenAt === null,
    "PACKET_FROZEN",
    "this packet is frozen (the meeting adjourned); record corrections as decisions in the next meeting",
  );
}
