// apps/backend/src/modules/05-patient/privacy/officer.ts — the Privacy Officer view of a patient's privacy
// restrictions (M5 §5.1 "Privacy flags (`/patients/:id/privacy`)", §4.2 resync route, D3, D10).
//
// M5 §5.2: "read-only summary of current snapshot + capture time + staleness indicator + 'Resync from
// consent' button (Privacy Officer only). Below: timeline of flag changes drawn from Module 4 audit events."
// M5 §4.2: `POST /api/v1/patients/:id/privacy-flags/resync` — `privacy.admin`, "force re-read from M39".
//
// What this file decides (all pure; the Drizzle service applies it):
//   · each restriction's ORIGIN — consent-derived (M39 says no §2.31 release is in force), a DocLens
//     (M22 §7.4 W4) detection that a reviewer has / has not confirmed, or unattributed;
//   · when each restriction began, from the M4 audit trail of the snapshot row;
//   · the RESYNC re-derivation (`decideResync`) — M39's Part 2 consent state decides `sud` when M39 has a
//     record; when M39 has never spoken, the DocLens detections still in force are re-applied (a restriction
//     is only ever ADDED from them, never lifted: lifting a detection is the licensed reviewer's act in the
//     intake review, M22 §7.4 step 6, not the officer's);
//   · drift between the snapshot and its sources, so the officer can see what a resync would change.
//
// Cross-module facts arrive through PORTS bound at the composition root (M5 has no `dependsOn` edge to
// M22 or M39): `Part2ConsentStateReader` is implemented by M39, `IntakeSudBatchReader` by M22, and
// `PrivacySnapshotHistoryReader` over M4's audit query. Ids, statuses, dates and counts cross — never a
// document's content or the detection evidence.
import type { PrivacyFlag } from "./index";

/** Where a restriction on the snapshot came from. */
export type PrivacyFlagOrigin =
  /** M39 Part 2 consent state put it there (no §2.31 release in force). */
  | "consent"
  /** A DocLens intake detection no licensed reviewer has resolved yet (M22 §7.4 W4 step 4). */
  | "intake_unconfirmed"
  /** A DocLens intake detection a licensed reviewer confirmed (W4 step 6). */
  | "intake_confirmed"
  /** No producer records the source (the M5-delegated hiv/mental_health/genetic/... categories). */
  | "unattributed";

export const PRIVACY_FLAG_ORIGINS: readonly PrivacyFlagOrigin[] = [
  "consent",
  "intake_unconfirmed",
  "intake_confirmed",
  "unattributed",
];

/** M39's answer about the patient's `42_cfr_part_2_release` consent (ids/dates/status only). */
export interface Part2ConsentState {
  /** `active` — a release is in force; `inactive` — M39 holds one but none is in force (revoked /
   *  expired / superseded); `none` — M39 has no non-draft Part 2 release for this patient. */
  readonly state: "active" | "inactive" | "none";
  readonly consentRecordId: string | null;
  /** M39's raw status of that record (`active`/`revoked`/`expired`/`superseded`). */
  readonly status: string | null;
  readonly effectiveAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export const NO_PART2_CONSENT: Part2ConsentState = {
  state: "none",
  consentRecordId: null,
  status: null,
  effectiveAt: null,
  expiresAt: null,
  revokedAt: null,
};

/** M39 port: the patient's current Part 2 consent state. */
export interface Part2ConsentStateReader {
  part2ConsentState(organizationId: string, patientId: string): Promise<Part2ConsentState>;
}

/** One DocLens intake batch that carries (or carried) a SUD detection for the patient. */
export interface IntakeSudBatchFact {
  readonly batchId: string;
  readonly sudStatus: "detected" | "confirmed" | "rejected";
  /** The batch's pipeline status (`discarded`, `in_review`, `writeback_complete`, ...). */
  readonly batchStatus: string;
  /** When the packet was received (uploaded). */
  readonly receivedAt: string;
  readonly pageCount: number | null;
  /** When a reviewer confirmed/rejected the detection (null while pending). */
  readonly resolvedAt: string | null;
}

/** M22 port: the patient's intake batches that carry a SUD detection state other than not_detected. */
export interface IntakeSudBatchReader {
  sudBatchesForPatient(organizationId: string, patientId: string): Promise<IntakeSudBatchFact[]>;
}

/** One M4 audit row of the snapshot (`patient_privacy_flag_snapshot.insert|update|delete`). */
export interface PrivacySnapshotHistoryEvent {
  readonly at: string;
  readonly actorUserId: string | null;
  readonly eventType: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
}

/** M4 port: the snapshot row's write-audit trail, NEWEST first. */
export interface PrivacySnapshotHistoryReader {
  snapshotHistory(
    organizationId: string,
    patientId: string,
  ): Promise<PrivacySnapshotHistoryEvent[]>;
}

/** The ports the officer service needs (bound at the composition root). */
export interface PrivacyOfficerPorts {
  readonly consent: Part2ConsentStateReader;
  readonly intake: IntakeSudBatchReader;
  readonly history: PrivacySnapshotHistoryReader;
}

/**
 * Does this batch still hold a DocLens flag on the patient? A confirmed detection always does (even if the
 * batch was later discarded — the reviewer confirmed Part 2 content). A pending detection does unless the
 * batch was discarded (discarding withdraws an UNREVIEWED detection). A rejection never does.
 */
export function batchContributes(
  b: Pick<IntakeSudBatchFact, "sudStatus" | "batchStatus">,
): boolean {
  if (b.sudStatus === "confirmed") return true;
  return b.sudStatus === "detected" && b.batchStatus !== "discarded";
}

/** The snapshot facts the officer logic reads. */
export interface SnapshotFacts {
  readonly flags: readonly string[];
  readonly sudFlagOrigin: string | null;
  readonly sourceConsentVersion: string | null;
  readonly capturedAt: string;
  readonly invalidatedAt: string | null;
}

/** The origin of one flag on a snapshot. */
export function originOf(flag: string, snap: SnapshotFacts): PrivacyFlagOrigin {
  if (flag !== "sud") return "unattributed";
  if (snap.sudFlagOrigin === "m22_intake_unconfirmed") return "intake_unconfirmed";
  if (snap.sudFlagOrigin === "m22_intake_confirmed") return "intake_confirmed";
  return snap.sourceConsentVersion !== null ? "consent" : "unattributed";
}

const flagsIn = (row: Record<string, unknown> | null): string[] =>
  row && Array.isArray(row.flags)
    ? (row.flags as unknown[]).filter((f): f is string => typeof f === "string")
    : [];

/**
 * When did each currently-present flag last become present? Walks the audit trail oldest→newest; a flag
 * that appears is stamped, one that disappears is cleared. A flag the trail never shows appearing (the
 * trail was pruned, or the row predates the trigger) is absent from the map — the caller falls back to the
 * snapshot's capture time and says so.
 */
export function flagSinceFromHistory(
  newestFirst: readonly PrivacySnapshotHistoryEvent[],
): Map<string, string> {
  const since = new Map<string, string>();
  for (const e of [...newestFirst].reverse()) {
    const after = new Set(flagsIn(e.after));
    for (const f of after) if (!since.has(f)) since.set(f, e.at);
    for (const f of [...since.keys()]) if (!after.has(f)) since.delete(f);
  }
  return since;
}

/** The decision a resync applies to the snapshot. */
export interface ResyncDecision {
  readonly flags: PrivacyFlag[];
  readonly sudFlagOrigin: "m22_intake_unconfirmed" | "m22_intake_confirmed" | null;
  readonly sourceConsentVersion: string | null;
  /** True when the flag SET changes (the `m5.patient.privacy_flag_changed` trigger). */
  readonly flagsChanged: boolean;
}

/**
 * Re-derive the snapshot (M5 §4.2 "force re-read from M39"; D3 "recomputable from M39 history").
 *
 *   M39 has a Part 2 release in force  → `sud` lifted, consent-governed (as `m39.consent.signed` does).
 *   M39 has a release, none in force   → `sud` restricted, consent-governed (as `revoked`/`expired` do).
 *   M39 has never spoken               → the DocLens detections still in force are re-applied exactly as
 *                                         the W4 consumer would (pending → interim flag, confirmed →
 *                                         confirmed flag); nothing is lifted.
 * Every other category round-trips untouched (M39 drives only `sud`, §4.3.1). Stale is cleared.
 */
export function decideResync(
  current: SnapshotFacts | null,
  consent: Part2ConsentState,
  batches: readonly IntakeSudBatchFact[],
): ResyncDecision {
  const before = [...new Set(current?.flags ?? [])].sort() as PrivacyFlag[];
  const without = before.filter((f) => f !== "sud");
  const withSud = [...without, "sud" as PrivacyFlag].sort();
  const origin = (current?.sudFlagOrigin ?? null) as ResyncDecision["sudFlagOrigin"];
  let flags: PrivacyFlag[];
  let sudFlagOrigin: ResyncDecision["sudFlagOrigin"];
  let sourceConsentVersion = current?.sourceConsentVersion ?? null;

  if (consent.state === "active") {
    flags = without;
    sudFlagOrigin = null;
    sourceConsentVersion = consent.consentRecordId;
  } else if (consent.state === "inactive") {
    flags = withSud;
    sudFlagOrigin = null;
    sourceConsentVersion = consent.consentRecordId;
  } else {
    const live = batches.filter(batchContributes);
    const anyConfirmed = live.some((b) => b.sudStatus === "confirmed");
    const hasSud = before.includes("sud");
    flags = before;
    sudFlagOrigin = origin;
    if (hasSud) {
      if (origin === "m22_intake_unconfirmed" && anyConfirmed)
        sudFlagOrigin = "m22_intake_confirmed";
    } else if (live.length > 0 && sourceConsentVersion === null) {
      flags = withSud;
      sudFlagOrigin = anyConfirmed ? "m22_intake_confirmed" : "m22_intake_unconfirmed";
    }
  }
  const flagsChanged = flags.join(",") !== before.join(",");
  return { flags, sudFlagOrigin, sourceConsentVersion, flagsChanged };
}

/** A disagreement between the snapshot and its sources that a resync (or the intake review) resolves. */
export type PrivacyDrift =
  /** The snapshot is invalidated — readers treat the patient as having no recorded flags. */
  | "snapshot_stale"
  /** M39 has a Part 2 release in force but the snapshot still restricts `sud`. */
  | "consent_active_but_restricted"
  /** M39 has no Part 2 release in force but the snapshot does not restrict `sud`. */
  | "consent_inactive_but_unrestricted"
  /** A DocLens detection is in force but the snapshot carries no `sud` flag. */
  | "intake_detection_without_flag"
  /** A pending detection was confirmed but the snapshot still says unconfirmed. */
  | "intake_confirmed_not_promoted"
  /** The `sud` flag is attributed to DocLens but no intake batch still holds it. */
  | "intake_flag_without_detection";

export function detectDrift(
  snap: SnapshotFacts | null,
  consent: Part2ConsentState,
  batches: readonly IntakeSudBatchFact[],
): PrivacyDrift[] {
  const out: PrivacyDrift[] = [];
  if (snap?.invalidatedAt) out.push("snapshot_stale");
  const hasSud = snap?.flags.includes("sud") ?? false;
  const live = batches.filter(batchContributes);
  if (consent.state === "active" && hasSud) out.push("consent_active_but_restricted");
  if (consent.state === "inactive" && !hasSud) out.push("consent_inactive_but_unrestricted");
  if (consent.state === "none") {
    if (!hasSud && live.length > 0 && (snap?.sourceConsentVersion ?? null) === null) {
      out.push("intake_detection_without_flag");
    }
    if (
      hasSud &&
      snap?.sudFlagOrigin === "m22_intake_unconfirmed" &&
      live.some((b) => b.sudStatus === "confirmed")
    ) {
      out.push("intake_confirmed_not_promoted");
    }
  }
  if (hasSud && snap?.sudFlagOrigin?.startsWith("m22_intake_") && live.length === 0) {
    out.push("intake_flag_without_detection");
  }
  return out;
}
