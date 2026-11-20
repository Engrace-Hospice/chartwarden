// apps/web/src/modules/07-care-plan/change-proposals — the "Plan of care" step of the visit-note composer (WF09). The RN says which
// problems, goals and interventions this visit addressed (a link to the plan element), and proposes the plan changes the visit found.
// A proposal never edits the signed plan: it is a draft only its author sees, released onto the case manager's review list when the
// visit is finalized (see pending-change-proposals.tsx). The step reads the plan, this visit's links and this visit's drafts itself.
import {
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  useApiClient,
  useReloadFocus,
} from "@chartwarden/ui";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { type PanelStatusListener, useReportPanelStatus } from "../../../shell/panel-status";
import { type CarePlan, fieldErrorsOf } from "../care-plan-api";
import { isGoalEditable } from "../care-plan-status";
import {
  type ProposalResult,
  addVisitLink,
  createProposal,
  listVisitLinks,
  listVisitProposals,
  loadCarePlan,
  removeVisitLink,
  replaceProposal,
  withdrawProposal,
} from "./change-proposals-api";
import {
  type PlanElementRow,
  PlanElementTable,
  busyKeyOf,
  linkTargetOf,
  planRows,
} from "./plan-element-table";
import { proposalSummary, targetLabelOf } from "./proposal-facts";
import { type ChoiceOption, ProposalForm } from "./proposal-form";
import {
  type FormErrors,
  type FormState,
  PROBLEM_REF_PREFIX,
  PROPOSAL_REF_PREFIX,
  emptyForm,
  formErrorsFromServer,
  formFromProposal,
  toChange,
} from "./proposal-form-model";
import {
  KIND_LABEL,
  PLAN_REDACTED_COPY,
  PROPOSE_THEN_REVIEW_COPY,
  REDACTED_COPY,
  STALE_LIST_CODES,
  errorCodeOf,
} from "./proposal-labels";
import type { ChangeProposal, ProposalKind, VisitLink } from "./proposal-types";
import { VisitDraftsList, dependentDraftCount } from "./visit-drafts-list";

export interface PlanOfCareStepProps {
  readonly encounterId: string;
  readonly patientId: string;
  /** The note cannot be edited (finalized, signed, or the viewer may not author): links and proposals are shown, not changed. */
  readonly disabled?: boolean;
  /** Called after any write that succeeded (a link toggled, a proposal recorded, edited or withdrawn). */
  readonly onChanged?: () => void;
  /** Told whether the open proposal form holds unsaved input and whether a write is in flight (see `useReportPanelStatus`). */
  readonly onStatusChange?: PanelStatusListener;
}

type Phase =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready" };

/** What the open drawer is doing: recording a new proposal of `kind`, or editing one draft. */
interface Editor {
  readonly kind: ProposalKind;
  /** The proposal being edited, or null when recording a new one. */
  readonly proposal: ChangeProposal | null;
  /** The element a resolve / update / discontinue names. */
  readonly targetId: string;
  readonly targetLabel: string;
  /** The form as it was opened, as JSON: the drawer holds unsaved input once the form no longer says this. */
  readonly baseline: string;
}

const NO_KEYS: ReadonlySet<string> = new Set();
const withKey = (keys: ReadonlySet<string>, key: string): ReadonlySet<string> =>
  new Set(keys).add(key);
const withoutKey = (keys: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(keys);
  next.delete(key);
  return next;
};

const LIVE_STATUSES = new Set(["draft", "pending"]);
const RECORDED_NOTICE =
  "Change recorded as a draft. It goes to the case manager for review when this visit is finalized.";
const PLAN_CLOSED_COPY = "This care plan is closed, so changes cannot be proposed.";
const IN_REVIEW_COPY =
  "A plan version is waiting for signatures. You can still record changes; they can be accepted once that version is signed or returned to draft.";
const NO_PLAN_COPY =
  "This patient has no care plan yet, so there is nothing to link this visit to and no change to propose. A case manager starts the plan from the patient's Care Plans tab.";

/** "1 goal or intervention", "3 goals and interventions". */
const dependentsText = (count: number): string =>
  count === 1 ? "1 goal or intervention" : `${count} goals and interventions`;

function PlanOfCareStepView({
  encounterId,
  patientId,
  disabled = false,
  onChanged,
  onStatusChange,
}: PlanOfCareStepProps): JSX.Element {
  const client = useApiClient();
  const formId = useId();
  const headingId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [plan, setPlan] = useState<CarePlan | null>(null);
  const [links, setLinks] = useState<readonly VisitLink[]>([]);
  const [drafts, setDrafts] = useState<readonly ChangeProposal[]>([]);
  const [draftsRedacted, setDraftsRedacted] = useState(false);
  // Every write in flight, by key: two overlapping toggles each clear only their own.
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(NO_KEYS);
  const [pendingWithdraw, setPendingWithdraw] = useState<ChangeProposal | null>(null);
  // The latest read of each list wins: an answer that lands after a newer read was started is dropped.
  const linksRead = useRef(0);
  const draftsRead = useRef(0);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Which editor is open: a save that lands after another editor was opened (or this one closed) must not touch the newer form.
  const editorSeq = useRef(0);
  const rows = useMemo(() => (plan ? planRows(plan) : []), [plan]);
  // A form with typed input, or one being saved, is not replaced by opening another proposal: the author finishes or cancels it first.
  const formDirty = editor !== null && JSON.stringify(form) !== editor.baseline;
  const editorLocked = editor !== null && (saving || formDirty);
  // A reload (Try again) replaces the button that had focus: hand it to the region instead of <body>.
  const focusRef = useReloadFocus<HTMLElement>(phase.kind === "loading");

  useReportPanelStatus(onStatusChange, {
    dirty: formDirty,
    saving: saving || busyKeys.size > 0,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-runs the first read on "Try again".
  useEffect(() => {
    let active = true;
    void Promise.all([
      loadCarePlan(client, patientId),
      listVisitLinks(client, encounterId),
      listVisitProposals(client, patientId, encounterId),
    ]).then(([planRes, linksRes, draftsRes]) => {
      if (!active) return;
      const failed = [planRes, linksRes, draftsRes].find((r) => !r.ok);
      if (failed && !failed.ok) {
        setPhase({ kind: "error", message: failed.message });
        return;
      }
      if (!planRes.ok || !linksRes.ok || !draftsRes.ok) return;
      setPlan(planRes.value);
      setLinks(linksRes.value);
      setDrafts(draftsRes.value.proposals.filter((p) => p.status !== "withdrawn"));
      setDraftsRedacted(draftsRes.value.redacted);
      setPhase({ kind: "ready" });
    });
    return () => {
      active = false;
    };
  }, [client, patientId, encounterId, reloadKey]);

  const reloadDrafts = useCallback(async (): Promise<void> => {
    const read = ++draftsRead.current;
    const res = await listVisitProposals(client, patientId, encounterId);
    if (read !== draftsRead.current) return;
    if (!res.ok) {
      setWriteError(res.message);
      return;
    }
    setDrafts(res.value.proposals.filter((p) => p.status !== "withdrawn"));
    setDraftsRedacted(res.value.redacted);
  }, [client, patientId, encounterId]);

  const reloadLinks = useCallback(async (): Promise<void> => {
    const read = ++linksRead.current;
    const res = await listVisitLinks(client, encounterId);
    if (read !== linksRead.current) return;
    if (res.ok) setLinks(res.value);
    else setWriteError(res.message);
  }, [client, encounterId]);

  /** A refused write: say why, and re-read whatever the refusal says moved (a draft that is no longer a draft, a link already gone). */
  const refused = useCallback(
    async (res: Extract<ProposalResult<unknown>, { ok: false }>): Promise<void> => {
      setNotice(null);
      setWriteError(res.message);
      const code = errorCodeOf(res.body);
      if (
        res.status === 404 ||
        (code !== null && (STALE_LIST_CODES.has(code) || code === "PROPOSAL_NOT_DRAFT"))
      ) {
        await Promise.all([reloadDrafts(), reloadLinks()]);
      }
    },
    [reloadDrafts, reloadLinks],
  );

  // Stable handlers: the plan table is memoised, so a keystroke in a proposal form does not re-render it.
  const toggleLink = useCallback(
    (row: PlanElementRow, linked: VisitLink | undefined): void => {
      void (async () => {
        const key = busyKeyOf(row);
        setBusyKeys((keys) => withKey(keys, key));
        setWriteError(null);
        const res = linked
          ? await removeVisitLink(client, encounterId, linked.id)
          : await addVisitLink(client, encounterId, linkTargetOf(row));
        setBusyKeys((keys) => withoutKey(keys, key));
        if (!res.ok) {
          await refused(res);
          return;
        }
        setNotice(null);
        await reloadLinks();
        onChanged?.();
      })();
    },
    [client, encounterId, onChanged, refused, reloadLinks],
  );

  const openEditor = useCallback((next: Omit<Editor, "baseline">, state: FormState): void => {
    editorSeq.current += 1;
    setEditor({ ...next, baseline: JSON.stringify(state) });
    setForm(state);
    setFormErrors({});
    setFormError(null);
    setWriteError(null);
    setNotice(null);
  }, []);
  const closeEditor = (): void => {
    if (saving) return;
    editorSeq.current += 1;
    setEditor(null);
  };

  const propose = useCallback(
    (kind: ProposalKind, row?: PlanElementRow): void => {
      const forProblem =
        row?.type === "problem" && (kind === "goal_add" || kind === "intervention_add");
      openEditor(
        { kind, proposal: null, targetId: row?.id ?? "", targetLabel: row?.label ?? "" },
        emptyForm(forProblem && row ? { problemRef: `${PROBLEM_REF_PREFIX}${row.id}` } : {}),
      );
    },
    [openEditor],
  );
  const addProblem = useCallback((): void => propose("problem_add"), [propose]);

  const edit = useCallback(
    (proposal: ChangeProposal): void => {
      openEditor(
        {
          kind: proposal.kind,
          proposal,
          targetId: proposal.target?.id ?? "",
          targetLabel: targetLabelOf(proposal),
        },
        formFromProposal(proposal),
      );
    },
    [openEditor],
  );

  async function save(): Promise<void> {
    if (!editor || !plan || disabled) return;
    const built = toChange(editor.kind, form, editor.targetId);
    if (!built.ok) {
      setFormErrors(built.errors);
      setFormError(null);
      return;
    }
    const seq = editorSeq.current;
    setSaving(true);
    setFormErrors({});
    setFormError(null);
    const res = editor.proposal
      ? await replaceProposal(client, plan.id, editor.proposal.id, built.change)
      : await createProposal(client, plan.id, { sourceEncounterId: encounterId, ...built.change });
    setSaving(false);
    // Another editor was opened (or this one closed) while the save was out: its answer is about the old form, not the one on screen.
    const stillOpen = seq === editorSeq.current;
    if (!res.ok) {
      if (!stillOpen) {
        setWriteError(res.message);
      } else {
        const fields = formErrorsFromServer(fieldErrorsOf(res.body));
        setFormErrors(fields);
        setFormError(Object.keys(fields).length > 0 ? null : res.message);
      }
      if (errorCodeOf(res.body) === "PROPOSAL_NOT_DRAFT") await reloadDrafts();
      return;
    }
    if (stillOpen) setEditor(null);
    setWriteError(null);
    setNotice(editor.proposal ? "Draft updated." : RECORDED_NOTICE);
    await reloadDrafts();
    onChanged?.();
  }

  /** Withdrawing a draft also withdraws the goals and interventions hanging off it, so that one asks first. */
  function askWithdraw(proposal: ChangeProposal): void {
    if (dependentDraftCount(drafts, proposal) > 0) setPendingWithdraw(proposal);
    else void withdraw(proposal);
  }

  async function withdraw(proposal: ChangeProposal): Promise<void> {
    if (!plan) return;
    setBusyKeys((keys) => withKey(keys, proposal.id));
    setWriteError(null);
    const res = await withdrawProposal(client, plan.id, proposal.id);
    setBusyKeys((keys) => withoutKey(keys, proposal.id));
    if (!res.ok) {
      await refused(res);
      return;
    }
    setNotice("Draft withdrawn.");
    await reloadDrafts();
    onChanged?.();
  }

  // The step is its own region of the note: an h2 beside the composer's other sections, the plan tables' h3s under it.
  const region = (children: ReactNode): JSX.Element => (
    <section ref={focusRef} tabIndex={-1} className="wx-form-stack" aria-labelledby={headingId}>
      <h2 id={headingId} className="wx-section-title">
        Plan of care
      </h2>
      {children}
    </section>
  );

  if (phase.kind === "loading") return region(<LoadingSpinner label="Loading the plan of care" />);
  if (phase.kind === "error") {
    return region(
      <div className="wx-action-row is-middle">
        <InlineAlert tone="error">{phase.message}</InlineAlert>
        <Button
          tone="secondary"
          size="sm"
          onClick={() => {
            setPhase({ kind: "loading" });
            setReloadKey((key) => key + 1);
          }}
        >
          Try again
        </Button>
      </div>,
    );
  }
  if (!plan) {
    return region(<EmptyState title="No care plan yet" description={NO_PLAN_COPY} />);
  }

  const closed = plan.status === "discharged";
  const canPropose = !disabled && !closed;
  const inReview = plan.versions.some((v) => v.status === "in_review");
  const proposalProblems: ChoiceOption[] = drafts
    .filter((p) => p.kind === "problem_add" && LIVE_STATUSES.has(p.status))
    .map((p) => ({
      value: `${PROPOSAL_REF_PREFIX}${p.id}`,
      label: `New problem (proposed): ${p.change.description ?? ""}`,
    }));
  const problemOptions: ChoiceOption[] = [
    ...rows
      .filter((row) => row.type === "problem")
      .map((row) => ({ value: `${PROBLEM_REF_PREFIX}${row.id}`, label: row.label })),
    ...proposalProblems,
  ];
  const chosenProblemId = form.problemRef.startsWith(PROBLEM_REF_PREFIX)
    ? form.problemRef.slice(PROBLEM_REF_PREFIX.length)
    : null;
  const goalOptions: ChoiceOption[] = plan.goals
    .filter((g) => g.problemId === chosenProblemId && isGoalEditable(g.status))
    .map((g) => ({ value: g.id, label: g.revisedText ?? g.originalText }));

  return region(
    <div className={`wx-list-drawer is-embedded${editor ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <p className="wx-action-hint">{PROPOSE_THEN_REVIEW_COPY}</p>
        {plan.redacted ? <InlineAlert tone="info">{PLAN_REDACTED_COPY}</InlineAlert> : null}
        {draftsRedacted ? <InlineAlert tone="info">{REDACTED_COPY}</InlineAlert> : null}
        {closed ? <InlineAlert tone="warning">{PLAN_CLOSED_COPY}</InlineAlert> : null}
        {inReview && canPropose ? <InlineAlert tone="info">{IN_REVIEW_COPY}</InlineAlert> : null}
        {writeError ? <InlineAlert tone="error">{writeError}</InlineAlert> : null}
        {notice ? <InlineAlert tone="success">{notice}</InlineAlert> : null}

        <div className="wx-drawer-title-row">
          <h3 className="wx-section-title">Plan items</h3>
          {canPropose ? (
            <Button tone="secondary" size="sm" disabled={editorLocked} onClick={addProblem}>
              Add problem
            </Button>
          ) : null}
        </div>
        {editorLocked ? (
          <p className="wx-action-hint">
            Save or cancel the open proposal before starting another.
          </p>
        ) : null}
        {rows.length === 0 ? (
          <EmptyState
            title="No active plan items"
            description="The plan has no active problems, goals or interventions to link this visit to."
          />
        ) : (
          <PlanElementTable
            rows={rows}
            links={links}
            drafts={drafts}
            canLink={!disabled}
            canPropose={canPropose}
            actionsDisabled={editorLocked}
            busyKeys={busyKeys}
            onToggleLink={toggleLink}
            onPropose={propose}
          />
        )}

        <h3 className="wx-section-title">Changes proposed in this visit</h3>
        {drafts.length === 0 ? (
          <p className="wx-action-hint">No changes proposed in this visit yet.</p>
        ) : (
          <VisitDraftsList
            proposals={drafts}
            canEdit={canPropose}
            editDisabled={editorLocked}
            busyIds={busyKeys}
            onEdit={edit}
            onWithdraw={askWithdraw}
          />
        )}
      </div>

      {editor ? (
        <Drawer
          key={editor.proposal?.id ?? `new-${editor.kind}-${editor.targetId}`}
          title={KIND_LABEL[editor.kind]}
          label={`${editor.proposal ? "Edit" : "Propose"}: ${KIND_LABEL[editor.kind]}`}
          onClose={closeEditor}
          closeDisabled={saving}
          footer={
            <>
              <Button tone="secondary" disabled={saving} onClick={closeEditor}>
                Cancel
              </Button>
              <Button type="submit" form={formId} loading={saving} disabled={disabled}>
                {editor.proposal ? "Save changes" : "Record proposal"}
              </Button>
            </>
          }
        >
          <ProposalForm
            formId={formId}
            kind={editor.kind}
            value={form}
            onChange={setForm}
            errors={formErrors}
            onSubmit={() => void save()}
            problemOptions={problemOptions}
            goalOptions={goalOptions}
            targetLabel={editor.targetLabel}
            disabled={saving || disabled}
          />
          {formError ? <InlineAlert tone="error">{formError}</InlineAlert> : null}
          <p className="wx-action-hint">{PROPOSE_THEN_REVIEW_COPY}</p>
        </Drawer>
      ) : null}
      <ConfirmDialog
        open={pendingWithdraw !== null}
        title="Withdraw this proposal?"
        description={
          pendingWithdraw
            ? `Withdrawing "${proposalSummary(pendingWithdraw) || targetLabelOf(pendingWithdraw)}" also withdraws ${dependentsText(dependentDraftCount(drafts, pendingWithdraw))} proposed under it in this visit.`
            : ""
        }
        confirmLabel="Withdraw"
        tone="danger"
        onConfirm={() => {
          const proposal = pendingWithdraw;
          setPendingWithdraw(null);
          if (proposal) void withdraw(proposal);
        }}
        onCancel={() => setPendingWithdraw(null)}
      />
    </div>,
  );
}

export const PlanOfCareStep = memo(PlanOfCareStepView);
