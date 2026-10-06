import { Button, InlineAlert, Modal, SelectField, TextAreaField, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/27-cost-report — GAP-082: the workspace action bar + its one confirm/entry modal
// (import, compute, validate, approve-for-submit, submit). Every action is a server call; nothing here
// decides who may act (ADR-0030). Buttons are enabled by what the SERVER returned about the report (its
// lifecycle state) and are switched off for the rest of the visit once the server has answered 403 — a
// client-side role guess would be a second, weaker authority.
//
// Two-person control (GAP-081): approve-for-submit and submit are two separate sign-offs by two people. The
// approver and the submitter are derived by the server from the session, so this UI sends no membership id.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  findStepUpDraftResourceId,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
  stepUpRedirectFor,
} from "../../shell/step-up-redirect";
import {
  type WriteResult,
  allocate,
  approveForSubmit,
  computeWorksheet,
  importTrialBalanceManual,
  importWageDataManual,
  pullTrialBalance,
  pullWageData,
  runValidation,
  submitReport,
} from "./cost-report-api";

export type CostReportAction = "import" | "compute" | "validate" | "approve" | "submit";

const LABEL: Record<CostReportAction, string> = {
  import: "Import data",
  compute: "Compute worksheets",
  validate: "Run validation",
  approve: "Approve for submit",
  submit: "Submit to CMS",
};

const SUBMIT_LABEL: Record<CostReportAction, string> = {
  import: "Import",
  compute: "Compute",
  validate: "Run validation",
  approve: "Approve",
  submit: "Submit",
};

const IMPORT_SOURCES = [
  { value: "xero", label: "Pull trial balance from Xero" },
  { value: "gusto", label: "Pull wage data from Gusto" },
  { value: "manual-tb", label: "Upload trial balance (JSON rows)" },
  { value: "manual-wage", label: "Upload wage data (JSON rows)" },
] as const;
type ImportSource = (typeof IMPORT_SOURCES)[number]["value"];

/** B and C are the derived worksheets (D8); "all" is the full step-down allocation. */
const COMPUTE_TARGETS = [
  { value: "all", label: "All derived worksheets (step-down allocation)" },
  { value: "B", label: "Worksheet B — Cost Allocation" },
  { value: "C", label: "Worksheet C — Per-Diem Cost" },
] as const;

const APPROVE_STATE = "ready_for_review";
const SUBMIT_STATE = "approved_for_submit";

export interface ActionReport {
  readonly id: string;
  readonly state: string;
  readonly latestValidationId: string | undefined;
}

function parseRows(text: string): { rows: unknown[] } | { error: string } {
  if (text.trim() === "") return { error: "Paste a JSON array of rows." };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length === 0)
      return { error: "The upload must be a non-empty JSON array of rows." };
    return { rows: parsed };
  } catch {
    return { error: "The upload is not valid JSON." };
  }
}

/** What the import modal holds that is worth keeping across a step-up round trip. */
interface ImportDraft {
  readonly source: ImportSource;
  readonly rowsText: string;
}

const IMPORT_DRAFT_ACTION = "m27-import";

interface ModalProps {
  readonly action: CostReportAction;
  readonly report: ActionReport;
  readonly onClose: () => void;
  readonly onDone: (message: string) => void;
  readonly onDenied: (action: CostReportAction, message: string) => void;
}

function ActionModal({ action, report, onClose, onDone, onDenied }: ModalProps): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const draftKey =
    action === "import" ? stepUpDraftKey(session, IMPORT_DRAFT_ACTION, report.id) : null;
  const [restored] = useState(() => peekStepUpDraft<ImportDraft>(draftKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<ImportSource>(restored?.source ?? "xero");
  const [rowsText, setRowsText] = useState(restored?.rowsText ?? "");
  const [target, setTarget] = useState<string>("all");
  const manual = action === "import" && (source === "manual-tb" || source === "manual-wage");

  async function perform(): Promise<{ res: WriteResult<unknown>; done: string } | string> {
    const id = report.id;
    switch (action) {
      case "import": {
        if (!manual) {
          const pull = source === "xero" ? pullTrialBalance : pullWageData;
          return {
            res: await pull(client, id),
            done: source === "xero" ? "Trial-balance pull queued." : "Wage-data pull queued.",
          };
        }
        const parsed = parseRows(rowsText);
        if ("error" in parsed) return parsed.error;
        return source === "manual-tb"
          ? {
              res: await importTrialBalanceManual(client, id, parsed.rows),
              done: "Trial balance imported.",
            }
          : {
              res: await importWageDataManual(client, id, parsed.rows),
              done: "Wage data imported.",
            };
      }
      case "compute":
        return target === "all"
          ? { res: await allocate(client, id), done: "Allocation queued." }
          : {
              res: await computeWorksheet(client, id, target),
              done: `Worksheet ${target} compute queued.`,
            };
      case "validate":
        return { res: await runValidation(client, id), done: "Validation run queued." };
      case "approve":
        return {
          res: await approveForSubmit(client, id, report.latestValidationId),
          done: "Approved for submit.",
        };
      case "submit":
        return { res: await submitReport(client, id), done: "Submitted." };
    }
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const outcome = await perform();
    setBusy(false);
    if (typeof outcome === "string") {
      setError(outcome);
      return;
    }
    const { res, done } = outcome;
    if (res.ok) {
      clearStepUpDraft(draftKey);
      onDone(done);
      return;
    }
    const stepUp = stepUpRedirectFor(res.raw, `${location.pathname}${location.search}`);
    if (stepUp) {
      stashStepUpDraft(draftKey, { source, rowsText });
      navigate(stepUp);
      return;
    }
    if (res.status === 403) onDenied(action, res.message);
    setError(res.message);
  }

  function cancel(): void {
    clearStepUpDraft(draftKey);
    onClose();
  }

  return (
    <Modal
      open
      onClose={busy ? undefined : cancel}
      ariaLabel={LABEL[action]}
      width="30rem"
      accent="primary"
    >
      <div className="wx-action-body is-modal">
        <h2 className="wx-action-title">{LABEL[action]}</h2>

        {action === "import" ? (
          <SelectField
            label="Source"
            value={source}
            onChange={(e) => setSource(e.target.value as ImportSource)}
            options={IMPORT_SOURCES.map((s) => ({ value: s.value, label: s.label }))}
          />
        ) : null}
        {manual ? (
          <TextAreaField
            label="Rows (JSON array)"
            value={rowsText}
            onChange={(e) => setRowsText(e.target.value)}
            rows={6}
          />
        ) : null}

        {action === "compute" ? (
          <SelectField
            label="Compute"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            options={COMPUTE_TARGETS.map((t) => ({ value: t.value, label: t.label }))}
          />
        ) : null}

        {action === "validate" ? (
          <p className="wx-action-hint">
            Queues a validation run against the active rule set. The report moves to Validating
            until it completes.
          </p>
        ) : null}
        {action === "approve" ? (
          <p className="wx-action-hint">
            Records you as the approver of the latest validation. A different person must submit —
            the server enforces the two-person control.
          </p>
        ) : null}
        {action === "submit" ? (
          <p className="wx-action-hint">
            Files the report with CMS as the signed-in user. The server refuses the submission if
            you approved this report; submission is irreversible.
          </p>
        ) : null}

        {error ? <InlineAlert>{error}</InlineAlert> : null}

        <div className="wx-action-row is-end">
          <Button tone="tertiary" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          <Button tone="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Working…" : SUBMIT_LABEL[action]}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export interface CostReportActionsProps {
  readonly report: ActionReport;
  /** Called after a write succeeded so the workspace reloads the server's view of the report. */
  readonly onChanged: () => void;
}

export function CostReportActions({ report, onChanged }: CostReportActionsProps): JSX.Element {
  const session = useSession();
  // Coming back from /step-up: reopen the import modal for this report if its rows were stashed.
  const [open, setOpen] = useState<CostReportAction | null>(() =>
    findStepUpDraftResourceId(session, IMPORT_DRAFT_ACTION) === report.id ? "import" : null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [denied, setDenied] = useState<Partial<Record<CostReportAction, string>>>({});

  // A different report is a different ABAC scope: forget what the server said about the last one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the report id only
  useEffect(() => {
    setDenied({});
    setNotice(null);
  }, [report.id]);

  const stateBlock: Partial<Record<CostReportAction, string>> = {
    approve:
      report.state === APPROVE_STATE ? undefined : "Available when the report is Ready for review.",
    submit:
      report.state === SUBMIT_STATE
        ? undefined
        : "Available when the report is Approved for submit.",
  };
  const actions: CostReportAction[] = ["import", "compute", "validate", "approve", "submit"];

  return (
    <div className="wx-cost-actions">
      <fieldset aria-label="Cost report actions" className="wx-action-row wx-cost-actions-row">
        {actions.map((a) => {
          const why = denied[a] ?? stateBlock[a];
          return (
            <Button
              key={a}
              tone={a === "submit" ? "primary" : "secondary"}
              disabled={why !== undefined}
              title={why}
              onClick={() => {
                setNotice(null);
                setOpen(a);
              }}
            >
              {LABEL[a]}
            </Button>
          );
        })}
      </fieldset>
      {Object.values(denied).length > 0 ? (
        <InlineAlert>{Object.values(denied)[0]}</InlineAlert>
      ) : null}
      {notice ? <InlineAlert tone="success">{notice}</InlineAlert> : null}
      {open ? (
        <ActionModal
          action={open}
          report={report}
          onClose={() => setOpen(null)}
          onDone={(message) => {
            setOpen(null);
            setNotice(message);
            onChanged();
          }}
          onDenied={(a, message) => setDenied((prev) => ({ ...prev, [a]: message }))}
        />
      ) : null}
    </div>
  );
}
