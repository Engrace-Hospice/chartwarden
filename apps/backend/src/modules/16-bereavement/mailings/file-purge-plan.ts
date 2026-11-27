// apps/backend/src/modules/16-bereavement/mailings/file-purge-plan.ts — CW-BR-10: WHICH rendered mailing batch files are due for purge. PURE: facts in, a plan out.
//
// THE FILE. A mailing batch PDF is an M22 document of aggregate type `bereavement_mailing_batch` (org-level, internal-only, seam-only) holding every
// recipient's name and mailing address. A run names it through `rendered_document_id`; a regenerate detaches it (the old PDF is then named by nobody), and so
// is the PDF of a render attempt that lost the run's compare-and-set or abandoned its claim.
//
// THE RULE (a default; compliance decides the period, ADR-0109 deferred list) — a file is DUE when, and only when, no hold protects it and:
//   mailed_retention   its run is `mailed` and the class floor has passed since staff CONFIRMED the mailing. The floor is the `bereavement` class's 13 months
//                      (396 days, `BEREAVEMENT_WINDOW_DAYS`, the program window): it never purges sooner, and it counts from the confirm, not from the render.
//   cancelled_grace    its run is `cancelled` (staff abandoned the batch): 30 days after the cancel, for a mistaken cancel or a reprint.
//   cancelled_past_floor  its run is `cancelled` and was generated a full floor ago: no reprint grace is owed on a batch that old, so it is due at once. This is
//                      also how a purge-time cancel self-heals: the executor cancels an abandoned `ready` run BEFORE it destroys the file, and if the destroy
//                      then fails (store down) the retry finds the run `cancelled` with a fresh `updated_at`; without this rule the file would wait another 30 days.
//   abandoned_ready    its run is still `ready` (rendered, never mailed, never cancelled) a full floor after it was generated: the batch is abandoned. The
//                      executor cancels the run first (a `ready` run must name a document), so the oversight list tells the truth.
//   unreferenced       no run names it: 7 days after it was rendered, long past any attempt still in flight.
// A run still `draft`, `generating` or `failed` names no file (a regenerate and a failure clear the pointer), so there is nothing to decide for it.
//
// HOLDS beat the clock: an M22 hold (hold row, status `legal_hold`, Part 2 class) on the file; an ORG-WIDE M4 hold (it names no patient, so it covers
// everything); a PATIENT-scoped M4 hold when a family of a held patient is in the file's run, or, for a file no run names (its recipients cannot be known),
// ANY patient-scoped hold in the org. Over-holding is the safe error. A messaging-only hold does not protect a mailing file and is not passed in.
import { BEREAVEMENT_WINDOW_DAYS } from "@chartwarden/bereavement";

const DAY_MS = 86_400_000;

/** The retention knobs. A deployment may lengthen `mailedDays` / `abandonedReadyDays`, never shorten them below the class floor. */
export interface MailingFileRetention {
  readonly mailedDays: number;
  readonly cancelledGraceDays: number;
  readonly abandonedReadyDays: number;
  readonly unreferencedGraceDays: number;
}

/** The floor of the `bereavement` retention class: 13 months, as 396 days (the program window). */
export const MAILING_FILE_RETENTION_FLOOR_DAYS = BEREAVEMENT_WINDOW_DAYS;

export const DEFAULT_MAILING_FILE_RETENTION: MailingFileRetention = {
  mailedDays: MAILING_FILE_RETENTION_FLOOR_DAYS,
  cancelledGraceDays: 30,
  abandonedReadyDays: MAILING_FILE_RETENTION_FLOOR_DAYS,
  unreferencedGraceDays: 7,
};

export type MailingFilePurgeBasis =
  | "mailed_retention"
  | "cancelled_grace"
  | "cancelled_past_floor"
  | "abandoned_ready"
  | "unreferenced";

/** One not-yet-destroyed batch file, as the M22 seam lists it. */
export interface PlanFile {
  readonly documentId: string;
  readonly createdAt: Date;
  /** An M22 hold (hold row, status `legal_hold`, Part 2 class). */
  readonly heldByDocumentStore: boolean;
}

/** The run that names a file. */
export interface PlanRun {
  readonly runId: string;
  readonly status: string;
  readonly version: number;
  readonly mailedAt: Date | null;
  readonly generatedAt: Date | null;
  readonly updatedAt: Date;
  /** A family of a patient named by an active patient-scoped M4 hold is in this run. */
  readonly touchesHeldPatient: boolean;
}

export interface PlannedPurge {
  readonly documentId: string;
  readonly basis: MailingFilePurgeBasis;
  readonly runId: string | null;
  /** The run's version at plan time (the compare-and-set of the `ready` -> `cancelled` step); null when no run names the file. */
  readonly runVersion: number | null;
  /** True when the run is `ready` and must be cancelled before its file goes. */
  readonly cancelRunFirst: boolean;
}

export interface PurgePlan {
  /** Due files, oldest first (the order of `files`). */
  readonly due: readonly PlannedPurge[];
  /** Files a hold protects. */
  readonly held: number;
  /** Files no rule makes due yet. */
  readonly retained: number;
}

export interface PlanHolds {
  /** An active M4 hold names no patient: everything is held. */
  readonly orgWide: boolean;
  /** At least one active M4 hold names patients. */
  readonly patientScoped: boolean;
}

/** `retention` with each period clamped to its floor: the class floor for the two long ones, one day for the two graces. */
export function clampRetention(retention: MailingFileRetention): MailingFileRetention {
  const atLeast = (value: number, floor: number): number =>
    Number.isFinite(value) ? Math.max(floor, Math.floor(value)) : floor;
  return {
    mailedDays: atLeast(retention.mailedDays, MAILING_FILE_RETENTION_FLOOR_DAYS),
    abandonedReadyDays: atLeast(retention.abandonedReadyDays, MAILING_FILE_RETENTION_FLOOR_DAYS),
    cancelledGraceDays: atLeast(retention.cancelledGraceDays, 1),
    unreferencedGraceDays: atLeast(retention.unreferencedGraceDays, 1),
  };
}

const elapsed = (since: Date | null, days: number, now: Date): boolean =>
  since !== null && now.getTime() >= since.getTime() + days * DAY_MS;

/** The basis that makes a file due, or null while no rule does. */
function dueBasis(
  file: PlanFile,
  run: PlanRun | undefined,
  retention: MailingFileRetention,
  now: Date,
): MailingFilePurgeBasis | null {
  if (run === undefined) {
    return elapsed(file.createdAt, retention.unreferencedGraceDays, now) ? "unreferenced" : null;
  }
  if (run.status === "mailed") {
    return elapsed(run.mailedAt, retention.mailedDays, now) ? "mailed_retention" : null;
  }
  if (run.status === "cancelled") {
    if (elapsed(run.updatedAt, retention.cancelledGraceDays, now)) return "cancelled_grace";
    return elapsed(run.generatedAt, retention.abandonedReadyDays, now)
      ? "cancelled_past_floor"
      : null;
  }
  if (run.status === "ready") {
    return elapsed(run.generatedAt ?? run.updatedAt, retention.abandonedReadyDays, now)
      ? "abandoned_ready"
      : null;
  }
  return null;
}

/** The plan for one org. Pure: the caller supplies the files, the runs that name them, the holds and the clock. */
export function planMailingFilePurge(input: {
  readonly files: readonly PlanFile[];
  /** The run naming each file, by document id (absent = unreferenced). */
  readonly runsByDocument: ReadonlyMap<string, PlanRun>;
  readonly holds: PlanHolds;
  readonly retention: MailingFileRetention;
  readonly now: Date;
}): PurgePlan {
  const retention = clampRetention(input.retention);
  const due: PlannedPurge[] = [];
  let held = 0;
  let retained = 0;
  for (const file of input.files) {
    const run = input.runsByDocument.get(file.documentId);
    const protectedByHold =
      file.heldByDocumentStore ||
      input.holds.orgWide ||
      (input.holds.patientScoped && (run === undefined || run.touchesHeldPatient));
    if (protectedByHold) {
      held += 1;
      continue;
    }
    const basis = dueBasis(file, run, retention, input.now);
    if (basis === null) {
      retained += 1;
      continue;
    }
    due.push({
      documentId: file.documentId,
      basis,
      runId: run?.runId ?? null,
      runVersion: run?.version ?? null,
      cancelRunFirst: basis === "abandoned_ready",
    });
  }
  return { due, held, retained };
}
