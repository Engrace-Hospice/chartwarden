import {
  Button,
  CodeSearchInput,
  Modal,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  isoToLocalInput,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/10-hope — the §5.2 HOPE recording modal (#91), all five RFAs.
//
// The `screens.ts` header this replaces deferred "the recording modal (§5.2, all five RFAs), the
// late-completion confirmation dialog, and the schedule-admin write surfaces". The recording modal IS
// the capture path for the one CMS-mandated quality instrument every Medicare-certified hospice must
// submit; without it the whole module was a read-only view of timepoints nobody could record.
//
// WHAT THIS CAPTURES, AND WHAT IT HONESTLY CANNOT.
//
// The CMS HOPE instrument has 17 sections. FOUR of them have item definitions anywhere in this
// codebase — Section I's primary diagnosis, Section J's J2030 / J2050 / J2051 items, and Section N's
// opioid-and-bowel-regimen triple — because those are the ones the CMS pre-submission rule set reads
// (F-057) and the ones the route boundary types. The other thirteen have NO item shapes: the spec's
// `packages/hope/src/sections/J/schema.ts` and its siblings were never written, and
// `packages/hope/src/sections/` contains exactly one file, the required-items matrix.
//
// So this modal captures the four that are defined and offers NOTHING for the thirteen that are not.
// Inventing tabs for "Section C — Cognitive Patterns" would mean minting ~200 CMS item shapes with no
// server counterpart, no validation, and no submission mapping — a form that looks like the instrument
// and produces a payload nothing can check. The F-007 rule (no enabled control wired to nothing) points
// exactly at that.
//
// The gap is not hidden: every recorded assessment now carries one blocking `REQUIRED_SECTION_MISSING`
// finding per undefined section, the assessment detail rail lists them by letter, and the banner below
// says so before the clinician commits. That is the difference this change makes — the instrument is
// still incomplete, but it is incomplete VISIBLY and measurably rather than in a header comment.
//
// The SERVER decides everything that matters. §4.4's capture gate runs against the STORED window, so the
// late-completion branch here reads the schedule's own dates only to know what to ASK for (judging, as the
// server does, at the later of the visit date and now: see `spanOf`); a client clock is not an authority and
// `M10_LATE_REASON_REQUIRED` / `M10_TIMEPOINT_EXPIRED` are the answers.
// §4.7's author floor (RN/NP/MD) is resolved from the caller's M3 role grants, never
// from the `authorDiscipline` sent here — that field is CMS attribution, which is why it is offered
// from the caller's OWN roles rather than as a free choice (the `discipline-derivation.test.ts` rule:
// M3's role keys are the platform's one authority-derivation input).
//
// AN SFV IS NOT RECORDED HERE. Completing a symptom follow-up visit records a signed RFA-04 whose J2053A-H
// answers the server requires; this modal has no such fields, so it submits timepoint DRAFTS only. The
// follow-up is completed in the triggering assessment's "Complete SFV" dialog (`hope-sfv-complete-dialog.tsx`).
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useSession } from "../../shell/session";
import {
  type AssessmentView,
  type AuthorDiscipline,
  type DischargeReason,
  type HopeData,
  type LateReasonCode,
  RECORD_UNCONFIRMED,
  type RfaKind,
  authorDisciplineLabel,
  authorDisciplinesForRoles,
  recordTimepoint,
} from "./hope-api";
import { notifyDone } from "./hope-notify-done";
import { rfaLabel } from "./hope-status";
import { useFocusOnNewError } from "./use-focus-on-new-error";

/** The §2.1 CMS J2051 symptom roster + severities, both derived from the wire contract. */
type J2051Entry = NonNullable<NonNullable<HopeData["J"]>["J2051"]>["entries"][number];
type SymptomCode = J2051Entry["symptomCode"];
type Severity = J2051Entry["severity"];

const SYMPTOMS: readonly SymptomCode[] = [
  "pain",
  "shortness_of_breath",
  "anxiety",
  "agitation",
  "nausea_vomiting",
  "constipation",
  "restlessness",
  "other",
];
const SEVERITIES: readonly Severity[] = ["none", "mild", "moderate", "severe"];
/** D4 — moderate or severe on ANY symptom creates the 2-calendar-day SFV obligation. */
const TRIGGER_SEVERITIES: ReadonlySet<string> = new Set(["moderate", "severe"]);

// The §4.7 author vocabulary lives in `hope-api.ts` (`authorDisciplinesForRoles`) — it is the WIRE
// vocabulary (RN/NP/MD), not the M3 role keys, and this modal used to conflate the two. See F-074 there.

// No "04_sfv": a timepoint DRAFT cannot be an SFV (the server never initialises one), so offering it here would be a
// control wired to a certain refusal (F-007). The SFV is completed in the assessment workspace.
const RFA_KINDS: readonly RfaKind[] = ["01_admission", "02_huv1", "03_huv2", "05_discharge"];
const DISCHARGE_REASONS: readonly DischargeReason[] = [
  "death",
  "revocation",
  "transfer_to_hospice",
  "live_discharge",
];
/** The closed D12 codelist (`LATE_COMPLETION_REASON_CODES`). */
const LATE_REASONS: readonly LateReasonCode[] = [
  "pto",
  "hospitalization",
  "family_meeting_deferral",
  "refused",
  "missed",
  "pandemic_cohort",
  "admin_override",
  "other",
];
/**
 * What a clinician may CHOOSE for a plain late completion: `admin_override` is not a reason, it is the record of an authorized,
 * justified override (the `adminOverride` flag and its 20-character justification) and is filed only on that path, so reports can
 * still tell a justified, audited override from a late capture labelled with it.
 */
const CHOOSABLE_LATE_REASONS = LATE_REASONS.filter((r) => r !== "admin_override");

/**
 * The server's own bounds on the justification that must accompany an administrative override
 * (`RecordTimepointSchema.adminOverrideJustification`, and `requireOverrideJustification` refuses an override without one).
 */
const OVERRIDE_JUSTIFICATION_MIN = 20;
const OVERRIDE_JUSTIFICATION_MAX = 1000;

/** The visit date opens at the current time, so the clinician who records an earlier visit changes it instead of filing it as now. */
const DEFAULT_DATE_HINT =
  "Set to the current time. Change it if the visit took place at another time.";

/** The entries could not be assembled into a request, so nothing was sent (unlike RECORD_UNCONFIRMED). */
const RECORD_NOT_PREPARED =
  "The timepoint could not be prepared, so nothing was sent. Check the entries and try again.";

const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The window a schedule row publishes; supplied when the capture completes a known timepoint. */
export interface RecordWindow {
  readonly id: string;
  readonly rfaKind: string;
  readonly windowOpensAt: string;
  readonly windowClosesAt: string;
  readonly lateDeadlineAt: string;
}

/** Where the capture falls against the window — used ONLY to decide what to ask for. */
type CaptureSpan = "before_open" | "in_window" | "late" | "expired" | "unscheduled";

/**
 * Mirrors the server's capture gate (`assertCaptureAllowed`, GAP-015). A visit dated before the window opens is refused on
 * its own date; everything else is judged at the LATER of the visit date and now, so a visit dated inside the window but
 * entered after it closed is late (it needs a reason), and one entered after the late deadline needs the override. Judging
 * the typed date alone would never offer either control, and the server's 400 / 409 would have no way to be answered.
 */
export function spanOf(
  targetIso: string,
  window: RecordWindow | null,
  nowMs: number = Date.now(),
): CaptureSpan {
  if (window === null) return "unscheduled";
  const at = Date.parse(targetIso);
  if (Number.isNaN(at)) return "unscheduled";
  if (at < Date.parse(window.windowOpensAt)) return "before_open";
  const judgedAt = Math.max(at, nowMs);
  if (judgedAt <= Date.parse(window.windowClosesAt)) return "in_window";
  if (judgedAt <= Date.parse(window.lateDeadlineAt)) return "late";
  return "expired";
}

/**
 * What the SERVER's refusal asks for when the modal's own picture of the window could not (opened with no schedule, or a stored
 * window that looked in time): the late-reason control for M10_LATE_REASON_REQUIRED, the override for M10_TIMEPOINT_EXPIRED. Without
 * this the refusal would repeat over a form with nothing that answers it. Judged for the date and reason typed, so it is dropped
 * when either changes.
 */
const SPAN_ASKED_BY_CODE: Readonly<
  Record<string, { readonly span: "late" | "expired"; readonly message: string }>
> = {
  M10_LATE_REASON_REQUIRED: {
    span: "late",
    message:
      "This visit is after the normal window, so a late completion reason is required. Choose one in the form (it has been added), then record again.",
  },
  M10_TIMEPOINT_EXPIRED: {
    span: "expired",
    message:
      "This visit is past the late deadline, so recording it needs an administrative override. Tick the override in the form (it has been added) and give its justification, then record again.",
  },
};

/** The explanations above, so one that describes a control that has since gone can be told from any other error. */
const ASKED_MESSAGES: ReadonlySet<string> = new Set(
  Object.values(SPAN_ASKED_BY_CODE).map((asked) => asked.message),
);

/** How strict a verdict is, to tell whether a refusal asks for more than the modal's own window did. */
const STRICTNESS: Readonly<Record<CaptureSpan, number>> = {
  before_open: -1,
  unscheduled: 0,
  in_window: 0,
  late: 1,
  expired: 2,
};

/**
 * Whether the server's refusal asks for more than the modal's own verdict offered (a client clock behind the server, a stored
 * window that has since moved, or no schedule at all): then the control it asks for is added. A visit the modal judged before the
 * window opened is a different refusal (M10_TIMEPOINT_NOT_OPEN), so nothing is added for it.
 */
const asksForMore = (asked: "late" | "expired", own: CaptureSpan): boolean =>
  own !== "before_open" && STRICTNESS[asked] > STRICTNESS[own];

/** The server's own bounds on the free-text fields that are not otherwise limited (`J2051Entry`, `HopeData.N`). */
const OTHER_SYMPTOM_LABEL_MAX = 100;
const BOWEL_CONTRAINDICATION_MAX = 500;

/**
 * A record for an admission and RFA that already has a draft is answered with THAT draft (201), and everything sent is
 * ignored. A draft the server just created carries exactly the visit date that was sent, so a different one is a draft that
 * was already there.
 */
const isExistingDraft = (view: AssessmentView, targetIso: string): boolean => {
  const returned = Date.parse(view.targetDate);
  return !Number.isNaN(returned) && returned !== Date.parse(targetIso); // no date back: no evidence either way
};

/** Shown when the server answered with a draft that was already there: what was entered was not saved. */
const EXISTING_DRAFT_NOTICE =
  "A draft for this timepoint already exists, so what you entered here was not saved. Continue the existing draft instead.";

export interface HopeRecordModalProps {
  readonly open: boolean;
  readonly admissionId: string;
  /** The schedule this capture completes, when there is one. Null for an ad-hoc / unscheduled capture. */
  readonly window?: RecordWindow | null;
  /** Pre-selects the RFA when no window pins it. */
  readonly defaultRfaKind?: RfaKind;
  readonly onClose: () => void;
  readonly onDone: (assessment: AssessmentView) => void;
  /** Opens a draft that already existed (the server answers a record with it, discarding the entry). Without it, the dialog just closes. */
  readonly onOpenExisting?: (assessment: AssessmentView) => void;
}

export function HopeRecordModal({
  open,
  admissionId,
  window: scheduleWindow = null,
  defaultRfaKind,
  onClose,
  onDone,
  onOpenExisting,
}: HopeRecordModalProps): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The draft the server answered with when one already existed: the entry was not saved, and the clinician is told.
  const [existingDraft, setExistingDraft] = useState<AssessmentView | null>(null);
  // What the server's last refusal asked for that the window known here did not (see SPAN_ASKED_BY_CODE).
  const [askedSpan, setAskedSpan] = useState<"late" | "expired" | null>(null);
  // The visit date opens at the current time: said so, beside the field, until the clinician has entered one.
  const [dateEdited, setDateEdited] = useState(false);

  const pinnedRfa = (scheduleWindow?.rfaKind as RfaKind | undefined) ?? undefined;

  const [rfaKind, setRfaKind] = useState<RfaKind>("01_admission");
  const [targetLocal, setTargetLocal] = useState(() => isoToLocalInput(new Date().toISOString()));
  const [authorDiscipline, setAuthorDiscipline] = useState<AuthorDiscipline | "">("");
  // Neither reason is pre-selected: each is attested to CMS, so the clinician chooses it.
  const [dischargeReason, setDischargeReason] = useState<DischargeReason | "">("");
  const [lateReason, setLateReason] = useState<LateReasonCode | "">("");
  const [adminOverride, setAdminOverride] = useState(false);
  const [overrideJustification, setOverrideJustification] = useState("");
  const [primaryDiagnosisIcd10, setPrimaryDiagnosisIcd10] = useState("");
  const [painScreened, setPainScreened] = useState(false);
  const [painCharacteristics, setPainCharacteristics] = useState("");
  const [dyspneaScreened, setDyspneaScreened] = useState(false);
  const [dyspneaCharacteristics, setDyspneaCharacteristics] = useState("");
  const [severities, setSeverities] = useState<Record<string, Severity>>({});
  const [otherSymptomLabel, setOtherSymptomLabel] = useState("");
  const [opioidPrescribed, setOpioidPrescribed] = useState(false);
  const [scheduledBowelRegimen, setScheduledBowelRegimen] = useState(false);
  const [bowelRegimenContraindication, setBowelRegimenContraindication] = useState("");
  // A failure takes focus: the pressed button is disabled while the request is out, which drops focus to the page.
  const alertRef = useFocusOnNewError<HTMLParagraphElement>(error);
  const existingRef = useFocusOnNewError<HTMLOutputElement>(
    existingDraft ? EXISTING_DRAFT_NOTICE : null,
  );

  // The caller's OWN roles, resolved to the CMS discipline codes they may be attributed as. NOT a check
  // that they may record — §4.7 is the server's, and this is which discipline the capture is filed under.
  const authorRoles = useMemo(() => authorDisciplinesForRoles(session?.roles ?? []), [session]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setExistingDraft(null);
    setAskedSpan(null);
    setDateEdited(false);
    setBusy(false);
    setRfaKind(pinnedRfa ?? defaultRfaKind ?? "01_admission");
    setTargetLocal(isoToLocalInput(new Date().toISOString()));
    setAuthorDiscipline(authorRoles.length === 1 ? (authorRoles[0] as AuthorDiscipline) : "");
    setDischargeReason("");
    setLateReason("");
    setAdminOverride(false);
    setOverrideJustification("");
    setPrimaryDiagnosisIcd10("");
    setPainScreened(false);
    setPainCharacteristics("");
    setDyspneaScreened(false);
    setDyspneaCharacteristics("");
    setSeverities({});
    setOtherSymptomLabel("");
    setOpioidPrescribed(false);
    setScheduledBowelRegimen(false);
    setBowelRegimenContraindication("");
  }, [open, pinnedRfa, defaultRfaKind, authorRoles]);

  if (!open) return null;

  // A cleared, part-typed or out-of-range value (a five-digit year) does not parse: it blocks the record, and must not throw.
  const targetMs = Date.parse(targetLocal);
  const targetIso = Number.isNaN(targetMs) ? "" : new Date(targetMs).toISOString();
  const windowSpan = spanOf(targetIso, scheduleWindow);
  // The server asked for a control this window could not (no schedule, or one that looked in time): offer it, for this date only.
  const span = askedSpan !== null && asksForMore(askedSpan, windowSpan) ? askedSpan : windowSpan;
  const triggering = SYMPTOMS.filter((s) => TRIGGER_SEVERITIES.has(severities[s] ?? "none"));
  const needsQ =
    rfaKind === "05_discharge" && dischargeReason !== "" && dischargeReason !== "death";
  const forbidsQ = rfaKind === "05_discharge" && dischargeReason === "death";

  // The override only exists past the late deadline: the checkbox is only offered there, so a tick left over from another
  // date is not sent, and cannot block a capture whose justification box is not on screen.
  const overriding = span === "expired" && adminOverride;
  const justification = overrideJustification.trim();
  // The server wants a typed late reason on a late capture AND on an overridden expired one (M10_LATE_REASON_REQUIRED). A late
  // capture takes the clinician's choice; the override IS its own reason (`admin_override`), so nothing is asked twice.
  const lateCode: LateReasonCode | "" =
    span === "late" ? lateReason : overriding ? "admin_override" : "";
  const blocked =
    targetIso === "" ||
    authorDiscipline === "" ||
    (span === "late" && lateReason === "") ||
    (rfaKind === "05_discharge" && dischargeReason === "") ||
    (overriding && justification.length < OVERRIDE_JUSTIFICATION_MIN);

  /** The §2.1 payload for the four sections this codebase defines items for. */
  function buildData(): HopeData {
    const entries = SYMPTOMS.filter((s) => severities[s] !== undefined).map((symptomCode) => ({
      symptomCode,
      severity: severities[symptomCode] as Severity,
      ...(symptomCode === "other" && otherSymptomLabel.trim() !== ""
        ? { otherSymptomLabel: otherSymptomLabel.trim() }
        : {}),
    }));
    const data: Record<string, unknown> = {
      J: {
        J2030: {
          screened: painScreened ? ("yes" as const) : ("no" as const),
          ...(painScreened && painCharacteristics.trim() !== ""
            ? { characteristics: painCharacteristics.trim() }
            : {}),
        },
        J2050: {
          screened: dyspneaScreened ? ("yes" as const) : ("no" as const),
          ...(dyspneaScreened && dyspneaCharacteristics.trim() !== ""
            ? { characteristics: dyspneaCharacteristics.trim() }
            : {}),
        },
        ...(entries.length > 0 ? { J2051: { entries } } : {}),
      },
      N: {
        opioidPrescribed,
        // The regimen and its contraindication are asked only for an opioid, and the contraindication only without a regimen.
        scheduledBowelRegimen: opioidPrescribed && scheduledBowelRegimen,
        ...(opioidPrescribed && !scheduledBowelRegimen && bowelRegimenContraindication.trim() !== ""
          ? { bowelRegimenContraindication: bowelRegimenContraindication.trim() }
          : {}),
      },
    };
    if (primaryDiagnosisIcd10.trim() !== "") {
      data.I = { primaryDiagnosisIcd10: primaryDiagnosisIcd10.trim().toUpperCase() };
    }
    // D9 — the record-time gate refuses a live discharge with NO Section Q key at all. The section has
    // no item definitions here, so the only truthful thing to write is the discharge participation
    // fact itself; the CMS rule then reports it as documented, which it is.
    if (needsQ) data.Q = { participation: "documented_at_discharge" };
    return data as HopeData;
  }

  async function submit(): Promise<void> {
    // Narrowing, not a re-check: `blocked` already disables the control. Returning here rather than
    // casting is what lets the call below pass a real `AuthorDiscipline` — the `as` that used to
    // stand in for this is precisely what let a role key reach the wire (F-074).
    if (authorDiscipline === "") return;
    setBusy(true);
    setError(null);
    let data: HopeData;
    try {
      data = buildData();
    } catch {
      // Nothing was sent, and `busy` must not stay set: it would hold Cancel, Escape and the scrim shut for good.
      setBusy(false);
      setError(RECORD_NOT_PREPARED);
      return;
    }
    let res: Awaited<ReturnType<typeof recordTimepoint>>;
    try {
      res = await recordTimepoint(client, admissionId, {
        rfaKind,
        targetDate: targetIso,
        authorDiscipline,
        data,
        ...(scheduleWindow ? { scheduleId: scheduleWindow.id } : {}),
        ...(rfaKind === "05_discharge" && dischargeReason !== "" ? { dischargeReason } : {}),
        ...(lateCode !== "" ? { lateCompletionReasonCode: lateCode } : {}),
        // The server refuses an override without its justification (422), and the clinician is the one who can give it.
        ...(overriding ? { adminOverride: true, adminOverrideJustification: justification } : {}),
      });
    } catch {
      // A rejected request must free the dialog: `busy` would otherwise hold Cancel, Escape and the scrim shut for good.
      setBusy(false);
      setError(RECORD_UNCONFIRMED);
      return;
    }
    setBusy(false);
    if (!res.ok) {
      const asked = res.code === null ? undefined : SPAN_ASKED_BY_CODE[res.code];
      if (asked !== undefined && asksForMore(asked.span, windowSpan)) {
        setAskedSpan(asked.span);
        setError(asked.message);
        return;
      }
      setError(res.message);
      return;
    }
    if (isExistingDraft(res.value, targetIso)) {
      setExistingDraft(res.value);
      return;
    }
    notifyDone(() => onDone(res.value), onClose);
  }

  /** What the last refusal asked for was judged for the date and reason typed: drop the control, and the explanation of it. */
  function dropAskedSpan(): void {
    setAskedSpan(null);
    setError((current) => (current !== null && ASKED_MESSAGES.has(current) ? null : current));
  }

  /** Leaves the dialog once the clinician has read that the draft already existed (the caller refreshes either way). */
  function leaveExisting(draft: AssessmentView, openIt: boolean): void {
    notifyDone(
      () => onDone(draft),
      () => {
        if (openIt) onOpenExisting?.(draft);
      },
      onClose,
    );
  }

  return (
    <Modal
      open={open}
      onClose={
        busy ? undefined : existingDraft ? () => leaveExisting(existingDraft, false) : onClose
      }
      ariaLabel="Record HOPE timepoint"
      width="36rem"
      accent={t.primary}
    >
      <div style={body}>
        <h2 style={title}>{`Record ${rfaLabel(rfaKind)}`}</h2>

        {/* The instrument gap, stated before the clinician commits rather than discovered after. */}
        <p style={banner}>
          Four HOPE sections have item definitions in this system — I (diagnosis), J (J2030 / J2050
          / J2051) and N (medications). The remaining sections will be reported as missing by the
          CMS pre-submission check until their items are built.
        </p>

        <SelectField
          label="Reason for assessment"
          value={rfaKind}
          disabled={pinnedRfa !== undefined}
          onChange={(e) => {
            setRfaKind(e.target.value as RfaKind);
            dropAskedSpan();
          }}
          options={RFA_KINDS.map((k) => ({ value: k, label: rfaLabel(k) }))}
        />
        {pinnedRfa !== undefined ? (
          <p style={meta}>
            Pinned by the scheduled window — a payload whose RFA does not match the schedule is
            refused (M10_RFA_KIND_MISMATCH).
          </p>
        ) : null}

        <TextField
          label="Visit date &amp; time"
          type="datetime-local"
          value={targetLocal}
          onChange={(e) => {
            setTargetLocal(e.target.value);
            setDateEdited(true);
            dropAskedSpan();
          }}
          hint={dateEdited ? undefined : DEFAULT_DATE_HINT}
          error={targetIso === "" ? "Enter a valid visit date and time." : undefined}
        />

        {authorRoles.length === 0 ? (
          // Not a permission verdict — the server still owns §4.7. This says the capture cannot be
          // ATTRIBUTED, because none of the caller's roles is in the author vocabulary at all.
          <p style={meta}>
            None of your roles can be recorded as a HOPE author discipline, so this capture cannot
            be attributed. Ask an administrator to review your role grants.
          </p>
        ) : (
          <SelectField
            label="Recording as"
            value={authorDiscipline}
            onChange={(e) => setAuthorDiscipline(e.target.value as AuthorDiscipline | "")}
            options={[
              ...(authorRoles.length > 1 ? [{ value: "", label: "Select a discipline…" }] : []),
              ...authorRoles.map((d) => ({ value: d, label: authorDisciplineLabel(d) })),
            ]}
          />
        )}

        {rfaKind === "05_discharge" ? (
          <>
            <SelectField
              label="Discharge reason"
              value={dischargeReason}
              onChange={(e) => setDischargeReason(e.target.value as DischargeReason | "")}
              options={[
                { value: "", label: "Select a reason" },
                ...DISCHARGE_REASONS.map((r) => ({ value: r, label: humanize(r) })),
              ]}
            />
            {forbidsQ || needsQ ? (
              <p style={meta}>
                {forbidsQ
                  ? "Section Q (Participation) is forbidden on a death discharge (D9) and will not be sent."
                  : "Section Q (Participation) is required on this discharge (D9) and will be recorded."}
              </p>
            ) : null}
          </>
        ) : null}

        {/* The §4.4 / D12 late-completion confirmation. Shown from the STORED window; the server decides. */}
        {span === "late" ? (
          <div style={lateBox}>
            <StatusPill label="Late completion" tone="warning" />
            <p style={meta}>
              The window has closed and the late deadline has not passed (judged at the later of the
              visit date and now), so this is a late completion. CMS requires a reason code, and
              each late completion counts against the HQRP compliance rate (D12).
            </p>
            <SelectField
              label="Late completion reason"
              value={lateReason}
              onChange={(e) => setLateReason(e.target.value as LateReasonCode | "")}
              options={[
                { value: "", label: "Select a reason" },
                ...CHOOSABLE_LATE_REASONS.map((r) => ({ value: r, label: humanize(r) })),
              ]}
            />
          </div>
        ) : null}
        {span === "expired" ? (
          <div style={lateBox}>
            <StatusPill label="Past the late deadline" tone="error" />
            <p style={meta}>
              The window's late deadline has passed. Recording now requires an administrative
              override, which the server records on the row; the late-completion reason is filed as
              "Admin Override".
            </p>
            <label style={checkRow}>
              <input
                type="checkbox"
                checked={adminOverride}
                onChange={(e) => setAdminOverride(e.target.checked)}
              />
              <span>Record with administrative override</span>
            </label>
            {adminOverride ? (
              <TextAreaField
                label="Justification for the override"
                hint={`At least ${OVERRIDE_JUSTIFICATION_MIN} characters. It is recorded in the audit trail when the override is used.`}
                value={overrideJustification}
                onChange={(e) => setOverrideJustification(e.target.value)}
                maxLength={OVERRIDE_JUSTIFICATION_MAX}
                rows={3}
              />
            ) : null}
          </div>
        ) : null}
        {span === "before_open" ? (
          <p style={meta}>
            This visit date is before the window opens; the server will refuse it
            (M10_TIMEPOINT_NOT_OPEN).
          </p>
        ) : null}

        <h3 style={sectionTitle}>Section I — Active diagnoses</h3>
        <CodeSearchInput
          label="Primary terminal diagnosis (ICD-10-CM)"
          system="icd10cm"
          value={primaryDiagnosisIcd10}
          onChange={(code) => setPrimaryDiagnosisIcd10(code)}
          placeholder="Search ICD-10-CM, e.g. C34.90"
        />

        <h3 style={sectionTitle}>Section J — Health conditions</h3>
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={painScreened}
            onChange={(e) => setPainScreened(e.target.checked)}
          />
          <span>J2030 — screened for pain</span>
        </label>
        {painScreened ? (
          <TextAreaField
            label="Pain characteristics"
            value={painCharacteristics}
            onChange={(e) => setPainCharacteristics(e.target.value)}
            rows={2}
          />
        ) : null}
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={dyspneaScreened}
            onChange={(e) => setDyspneaScreened(e.target.checked)}
          />
          <span>J2050 — screened for shortness of breath</span>
        </label>
        {dyspneaScreened ? (
          <TextAreaField
            label="Dyspnea characteristics"
            value={dyspneaCharacteristics}
            onChange={(e) => setDyspneaCharacteristics(e.target.value)}
            rows={2}
          />
        ) : null}

        <p style={meta}>J2051 — symptom impact at this visit</p>
        <div style={symptomGrid}>
          {SYMPTOMS.map((symptom) => (
            <SelectField
              key={symptom}
              label={humanize(symptom)}
              value={severities[symptom] ?? ""}
              onChange={(e) =>
                setSeverities((prev) => {
                  const next = { ...prev };
                  if (e.target.value === "") delete next[symptom];
                  else next[symptom] = e.target.value as Severity;
                  return next;
                })
              }
              options={[
                { value: "", label: "Not screened" },
                ...SEVERITIES.map((s) => ({ value: s, label: humanize(s) })),
              ]}
            />
          ))}
        </div>
        {severities.other !== undefined ? (
          <TextField
            label="Other symptom — label"
            maxLength={OTHER_SYMPTOM_LABEL_MAX}
            value={otherSymptomLabel}
            onChange={(e) => setOtherSymptomLabel(e.target.value)}
          />
        ) : null}
        {triggering.length > 0 ? (
          // Informational, never blocking — the clinician records what is clinically true and the SFV
          // is the consequence. The SERVER evaluates the trigger from the stored payload at sign (D4);
          // this is a preview of a decision it makes, not the decision.
          <output style={triggerBox}>
            <StatusPill label="Follow-up will be required" tone="warning" />
            <p style={meta}>
              {triggering.map(humanize).join(", ")} at moderate or severe will create a Symptom
              Follow-Up Visit obligation due within 2 calendar days once this timepoint is signed.
            </p>
          </output>
        ) : null}

        <h3 style={sectionTitle}>Section N — Medications</h3>
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={opioidPrescribed}
            onChange={(e) => setOpioidPrescribed(e.target.checked)}
          />
          <span>Opioid prescribed for pain</span>
        </label>
        {opioidPrescribed ? (
          <>
            <label style={checkRow}>
              <input
                type="checkbox"
                checked={scheduledBowelRegimen}
                onChange={(e) => setScheduledBowelRegimen(e.target.checked)}
              />
              <span>Scheduled bowel regimen in place</span>
            </label>
            {!scheduledBowelRegimen ? (
              <TextField
                label="Bowel regimen contraindication"
                maxLength={BOWEL_CONTRAINDICATION_MAX}
                value={bowelRegimenContraindication}
                onChange={(e) => setBowelRegimenContraindication(e.target.value)}
              />
            ) : null}
          </>
        ) : null}

        {error ? (
          <p ref={alertRef} tabIndex={-1} role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        {existingDraft ? (
          <output ref={existingRef} tabIndex={-1} style={errorText}>
            {EXISTING_DRAFT_NOTICE}
          </output>
        ) : null}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          {existingDraft ? (
            <>
              <Button tone="tertiary" onClick={() => leaveExisting(existingDraft, false)}>
                Close
              </Button>
              {onOpenExisting ? (
                <Button onClick={() => leaveExisting(existingDraft, true)}>
                  Open existing draft
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button tone="tertiary" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={busy || blocked}>
                {busy ? "Recording…" : "Record draft"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

const body: CSSProperties = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  maxHeight: "80vh",
  overflowY: "auto",
};
const title: CSSProperties = { margin: 0, fontSize: "1.05rem", fontWeight: 600 };
const sectionTitle: CSSProperties = {
  margin: "0.5rem 0 0",
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};
const meta: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
const banner: CSSProperties = {
  ...meta,
  padding: "0.5rem 0.625rem",
  borderRadius: "0.375rem",
  background: "var(--color-surface-variant)",
};
const lateBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.375rem",
  padding: "0.625rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--color-outline-variant)",
};
const triggerBox: CSSProperties = { ...lateBox };
const checkRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.85rem",
};
const symptomGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
  gap: "0.5rem",
};
const errorText: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
