import {
  Button,
  LoadingSpinner,
  SelectField,
  StatusPill,
  TextField,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/25-remittance — the MAC REOPENING section of the denial work panel (hospice ADR/TPE/QIC PRD,
// milestone 3). A denial the routing rules send to a reopening (a 56900 ADR non-response) is worked here, not in the
// appeal chain: record the deadline if the MAC gave one (none is assumed), record the request filed outside
// WardenX with its proof under a step-up, record the MAC's decision, withdraw or close. The server owns every rule
// (legal edges, the proof the filing needs, the frozen filing) and its message is shown verbatim (ADR-0030); this
// component only collects facts and offers the moves the state allows.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import { ButtonRow, ErrorAlert, Facts, Hint, NoticeAlert } from "./action-ui";
import {
  type ReopeningDetail,
  type ReopeningFilingInput,
  type ReopeningOutcome,
  closeReopening,
  decideReopening,
  loadReopening,
  setReopeningDue,
  submitReopening,
  withdrawReopening,
} from "./remittance-api";
import { REOPENING_STATE_TONE, humanize, toneOf } from "./remittance-status";

/** Keyed on the DENIAL id so the denial worklist can reopen the right panel after a step-up round trip. */
export const REOPENING_DRAFT_ACTION = "m25-reopening";

const CHANNELS: readonly { value: ReopeningFilingInput["channel"]; label: string }[] = [
  { value: "mac_portal", label: "MAC portal" },
  { value: "fax", label: "Fax" },
  { value: "mail", label: "Mail" },
  { value: "other", label: "Other" },
];
const OUTCOMES: readonly { value: ReopeningOutcome; label: string }[] = [
  { value: "granted", label: "Granted" },
  { value: "partial", label: "Partly granted" },
  { value: "denied", label: "Denied" },
];

interface FilingDraft {
  readonly formName: string;
  readonly channel: ReopeningFilingInput["channel"];
  readonly confirmationRef: string;
  readonly filedAt: string;
}

/** Local `YYYY-MM-DDTHH:mm` for a datetime-local input. */
const toLocalInput = (d: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const isoOrNull = (local: string): string | null =>
  local && !Number.isNaN(Date.parse(local)) ? new Date(local).toISOString() : null;

export interface ReopeningPanelProps {
  readonly denialId: string;
  readonly reopeningId: string;
  /** Called after any change so the parent reloads what it shows. */
  readonly onChanged: () => void;
}

export function ReopeningPanel({
  denialId,
  reopeningId,
  onChanged,
}: ReopeningPanelProps): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const draftKey = stepUpDraftKey(session, REOPENING_DRAFT_ACTION, denialId);
  const [restored] = useState(() => peekStepUpDraft<FilingDraft>(draftKey));
  const [detail, setDetail] = useState<ReopeningDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formName, setFormName] = useState(restored?.formName ?? "");
  const [channel, setChannel] = useState<ReopeningFilingInput["channel"]>(
    restored?.channel ?? "mac_portal",
  );
  const [confirmationRef, setConfirmationRef] = useState(restored?.confirmationRef ?? "");
  const [filedAt, setFiledAt] = useState(restored?.filedAt ?? toLocalInput(new Date()));
  const [dueAt, setDueAt] = useState("");
  const [outcome, setOutcome] = useState<ReopeningOutcome>("granted");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const res = await loadReopening(client, reopeningId);
    if (!mounted.current) return;
    if (!res.ok) {
      setLoadError(res.message);
      return;
    }
    setLoadError(null);
    setDetail(res.value);
    setDueAt(res.value.dueAt ? toLocalInput(new Date(res.value.dueAt)) : "");
  }, [client, reopeningId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one command; true when it succeeded. Every refusal is shown verbatim and the case is reloaded after. */
  async function run(
    label: string,
    call: (version: number) => Promise<{ ok: true } | { ok: false; message: string }>,
  ): Promise<boolean> {
    if (!detail) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await call(detail.version);
    if (!mounted.current) return false;
    if (!res.ok) setError(res.message);
    else setNotice(`${label}: done.`);
    // Reload before re-enabling: the next command must carry the version the server holds NOW.
    await load();
    if (res.ok) onChanged();
    if (mounted.current) setBusy(false);
    return res.ok;
  }

  const filedIso = isoOrNull(filedAt);
  const filingBlocked = formName.trim() === "" || confirmationRef.trim() === "" || filedIso === null;

  async function file(): Promise<void> {
    if (!detail || filedIso === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await submitReopening(client, reopeningId, detail.version, {
      formName: formName.trim(),
      channel,
      confirmationRef: confirmationRef.trim(),
      filedAt: filedIso,
    });
    if (!mounted.current) return;
    if (!res.ok) {
      if (res.stepUp) {
        setBusy(false);
        stashStepUpDraft(draftKey, {
          formName,
          channel,
          confirmationRef,
          filedAt,
        } satisfies FilingDraft);
        navigate(
          `/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
        );
        return;
      }
      setError(res.message);
      await load();
      if (mounted.current) setBusy(false);
      return;
    }
    clearStepUpDraft(draftKey);
    setNotice("Record filing: done.");
    await load();
    onChanged();
    if (mounted.current) setBusy(false);
  }

  if (loadError) return <ErrorAlert message={loadError} />;
  if (!detail) return <LoadingSpinner />;

  const live = detail.state === "draft" || detail.state === "submitted";
  const dueIso = isoOrNull(dueAt);

  return (
    <>
      <h3 className="wx-action-title">MAC reopening</h3>
      <NoticeAlert message={notice} />
      <ErrorAlert message={error} />
      <Facts
        items={[
          [
            "State",
            <StatusPill
              key="s"
              label={humanize(detail.state)}
              tone={toneOf(REOPENING_STATE_TONE, detail.state)}
            />,
          ],
          ["MAC", detail.macName],
          ["Linked ADR", detail.adrCaseId ?? "None"],
          [
            "MAC deadline",
            detail.dueAt
              ? new Date(detail.dueAt).toLocaleString()
              : "No deadline known. Enter one if the MAC gave it.",
          ],
          ...(detail.formName
            ? ([
                ["Form filed", detail.formName],
                ["Sent by", humanize(detail.filingChannel)],
                ["Confirmation", detail.filingConfirmationRef ?? ""],
                ["Sent on", detail.filedAt ? new Date(detail.filedAt).toLocaleString() : ""],
              ] as const)
            : []),
          ...(detail.outcome ? ([["Outcome", humanize(detail.outcome)]] as const) : []),
        ]}
      />

      {live ? (
        <>
          <TextField
            label="MAC deadline (if the MAC gave one)"
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
          <ButtonRow end>
            <Button
              tone="tertiary"
              size="sm"
              disabled={
                busy || (dueAt !== "" && dueIso === null) || (dueAt === "" && !detail.dueAt)
              }
              onClick={() =>
                void run("Deadline", (v) => setReopeningDue(client, reopeningId, v, dueIso))
              }
            >
              {dueAt === "" ? "Clear deadline" : "Save deadline"}
            </Button>
          </ButtonRow>
        </>
      ) : null}

      {detail.state === "draft" ? (
        <>
          <h4 className="wx-action-title">Record filing</h4>
          <Hint>
            Record the request you filed with the MAC. WardenX does not send it for you yet.
            Recording it needs a recent step-up verification and cannot be edited afterwards.
          </Hint>
          <TextField
            label="Form or request used"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            maxLength={200}
          />
          <SelectField
            label="Sent by"
            value={channel}
            onChange={(e) => setChannel(e.target.value as ReopeningFilingInput["channel"])}
            options={CHANNELS.map((c) => ({ value: c.value, label: c.label }))}
          />
          <TextField
            label="Confirmation or tracking reference"
            value={confirmationRef}
            onChange={(e) => setConfirmationRef(e.target.value)}
            maxLength={200}
          />
          <TextField
            label="Sent on"
            type="datetime-local"
            value={filedAt}
            onChange={(e) => setFiledAt(e.target.value)}
          />
          <ButtonRow end>
            <Button disabled={busy || filingBlocked} onClick={() => void file()}>
              Record filing
            </Button>
          </ButtonRow>
        </>
      ) : null}

      {detail.state === "submitted" ? (
        <>
          <h4 className="wx-action-title">Record the MAC's decision</h4>
          <SelectField
            label="Outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as ReopeningOutcome)}
            options={OUTCOMES.map((o) => ({ value: o.value, label: o.label }))}
          />
          <ButtonRow end>
            <Button
              disabled={busy}
              onClick={() =>
                void run("Record decision", (v) => decideReopening(client, reopeningId, v, outcome))
              }
            >
              Record decision
            </Button>
          </ButtonRow>
        </>
      ) : null}

      {detail.state === "decided" ? (
        <ButtonRow end>
          <Button
            disabled={busy}
            onClick={() => void run("Close", (v) => closeReopening(client, reopeningId, v))}
          >
            Close reopening
          </Button>
        </ButtonRow>
      ) : null}

      {live ? (
        <ButtonRow>
          <Button
            tone="tertiary"
            size="sm"
            disabled={busy}
            onClick={() => void run("Withdraw", (v) => withdrawReopening(client, reopeningId, v))}
          >
            Withdraw reopening
          </Button>
        </ButtonRow>
      ) : null}
    </>
  );
}
