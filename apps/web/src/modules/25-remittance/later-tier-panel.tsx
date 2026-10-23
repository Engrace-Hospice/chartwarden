import {
  Button,
  LoadingSpinner,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the LATER-TIER section of the appeal panel (milestone 7a-1): ALJ, Council and
// federal court. A flat section beside the QIC panel. Everything here is typed by the user from a notice or filing:
// the detail record, the recorded deadlines (each with its source note), and for federal court only the counsel's
// filing date and docket reference (record-only: no packet, no submit). The disposition kind is a label; a remand or
// dismissal reads "needs manual review" and nothing is created from it. The amount in controversy is stored only.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import {
  BlockedReason,
  ButtonRow,
  ErrorAlert,
  Facts,
  Hint,
  NoticeAlert,
  PhiNotice,
  RetryAlert,
  WarningAlert,
} from "./action-ui";
import {
  DISPOSITION_KINDS,
  type LaterTierDetailInput,
  type LaterTierView,
  isConflict,
  loadLaterTier,
  saveLaterTierDetail,
} from "./audit-api";
import { NOT_COMPUTED, RecordedDeadlines } from "./recorded-deadlines";
import { humanize } from "./remittance-status";

export const UNCONFIRMED_WINDOW = "Window not SME-confirmed";
const NOTHING_SPAWNS = "Needs manual review. Nothing is created from a remand or dismissal.";

export interface LaterTierPanelProps {
  readonly appealId: string;
  readonly appealState: string;
  readonly onChanged: () => void;
}

type Form = Record<keyof LaterTierDetailInput, string>;
const EMPTY: Form = {
  authorityReference: "",
  amountInControversyCents: "",
  hearingOn: "",
  hearingFormatNote: "",
  dispositionKind: "",
  dispositionNote: "",
  filedByCounselOn: "",
  docketReference: "",
};

const formFrom = (view: LaterTierView): Form => ({
  authorityReference: view.detail?.authorityReference ?? "",
  amountInControversyCents:
    view.detail?.amountInControversyCents == null
      ? ""
      : String(view.detail.amountInControversyCents),
  hearingOn: view.detail?.hearingOn ?? "",
  hearingFormatNote: view.detail?.hearingFormatNote ?? "",
  dispositionKind: view.detail?.dispositionKind ?? "",
  dispositionNote: view.detail?.dispositionNote ?? "",
  filedByCounselOn: view.detail?.filedByCounselOn ?? "",
  docketReference: view.detail?.docketReference ?? "",
});

const text = (v: string): string | null => (v.trim() === "" ? null : v.trim());

/** Only the fields the tier accepts are sent: federal court takes counsel/docket only, ALJ/Council the rest. */
function bodyFor(tier: string, f: Form): LaterTierDetailInput {
  if (tier === "federal_court") {
    return { filedByCounselOn: text(f.filedByCounselOn), docketReference: text(f.docketReference) };
  }
  return {
    authorityReference: text(f.authorityReference),
    amountInControversyCents:
      f.amountInControversyCents.trim() === "" ? null : Number(f.amountInControversyCents),
    hearingOn: text(f.hearingOn),
    hearingFormatNote: text(f.hearingFormatNote),
    dispositionKind: (text(f.dispositionKind) as LaterTierDetailInput["dispositionKind"]) ?? null,
    dispositionNote: text(f.dispositionNote),
  };
}

/** Keyed by appeal: switching to another appeal resets the form, the view and every message. */
export function LaterTierPanel(props: LaterTierPanelProps): JSX.Element {
  return <LaterTierPanelBody key={props.appealId} {...props} />;
}

function LaterTierPanelBody({
  appealId,
  appealState,
  onChanged,
}: LaterTierPanelProps): JSX.Element {
  const client = useApiClient();
  const blockedId = useId();
  const [view, setView] = useState<LaterTierView | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // `reseed` re-fills the form from the server: only on the first load and after this panel's own successful save.
  // A reload for any other reason (a deadline changed, a version conflict) must keep what is being typed.
  // A failed reload keeps the last good view; the error shows inline, with Retry only when there is no view yet.
  const load = useCallback(
    async (reseed: boolean) => {
      const res = await loadLaterTier(client, appealId);
      if (!mounted.current) return;
      if (!res.ok) {
        setLoadError(res.message);
        return;
      }
      if (!Array.isArray(res.value.deadlines)) {
        setLoadError("Later-tier record unavailable: unexpected response.");
        return;
      }
      setLoadError(null);
      setView(res.value);
      if (reseed) setForm(formFrom(res.value));
    },
    [client, appealId],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  if (!view) {
    return loadError ? (
      <RetryAlert message={loadError} onRetry={() => void load(true)} />
    ) : (
      <LoadingSpinner />
    );
  }

  const federal = view.tier === "federal_court";
  const editable = !["closed", "withdrawn"].includes(appealState);
  const set = (key: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const amount = form.amountInControversyCents.trim();
  const amountBad = amount !== "" && !/^\d+$/.test(amount);

  async function save(): Promise<void> {
    if (!view) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await saveLaterTierDetail(
      client,
      appealId,
      view.detail?.version ?? 0,
      bodyFor(view.tier, form),
    );
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      // The detail moved under us: fetch the new version, but keep the typed values for the retry.
      if (isConflict(res)) await load(false);
      return;
    }
    setNotice("Saved.");
    await load(true);
    onChanged();
  }

  return (
    <section aria-label="Later tier">
      <h3 className="wx-action-title">
        {federal ? "Federal court (record only)" : `${humanize(view.tier)} record`}
      </h3>
      {view.windowUnconfirmed ? <StatusPill label={UNCONFIRMED_WINDOW} tone="warning" /> : null}
      <Facts
        items={[
          ["Tier", humanize(view.tier)],
          ["Filed by escalation", view.filedByEscalation ? "Yes" : "No"],
          ...(federal
            ? ([
                ["Packet and submission", "None here: filed by counsel outside ChartWarden."],
              ] as const)
            : []),
        ]}
      />
      {loadError ? <ErrorAlert message={loadError} /> : null}
      {view.needsManualReview ? <WarningAlert>{NOTHING_SPAWNS}</WarningAlert> : null}
      {federal ? (
        <>
          <TextField
            label="Filed by counsel on"
            type="date"
            value={form.filedByCounselOn}
            onChange={set("filedByCounselOn")}
            disabled={!editable}
          />
          <TextField
            label="Docket reference"
            value={form.docketReference}
            onChange={set("docketReference")}
            maxLength={200}
            disabled={!editable}
          />
        </>
      ) : (
        <>
          <TextField
            label="Authority reference (from the notice)"
            value={form.authorityReference}
            onChange={set("authorityReference")}
            maxLength={200}
            disabled={!editable}
          />
          <TextField
            label="Amount in controversy (cents)"
            value={form.amountInControversyCents}
            onChange={set("amountInControversyCents")}
            inputMode="numeric"
            disabled={!editable}
            error={amountBad ? "Whole cents only." : undefined}
          />
          <Hint>Stored only. It is never compared to anything.</Hint>
          <TextField
            label="Hearing date"
            type="date"
            value={form.hearingOn}
            onChange={set("hearingOn")}
            disabled={!editable}
          />
          <TextField
            label="Hearing format note"
            value={form.hearingFormatNote}
            onChange={set("hearingFormatNote")}
            maxLength={500}
            disabled={!editable}
          />
          <SelectField
            label="Disposition (a label only)"
            value={form.dispositionKind}
            onChange={set("dispositionKind")}
            disabled={!editable}
            options={[
              { value: "", label: "Not recorded" },
              ...DISPOSITION_KINDS.map((k) => ({ value: k, label: humanize(k) })),
            ]}
          />
          <TextAreaField
            label="Disposition note"
            value={form.dispositionNote}
            onChange={set("dispositionNote")}
            rows={3}
            maxLength={2000}
            disabled={!editable}
          />
        </>
      )}
      <PhiNotice />
      <Hint>{NOT_COMPUTED}</Hint>
      <ErrorAlert message={error} />
      <NoticeAlert message={notice} />
      {editable ? (
        <>
          {amountBad ? (
            <BlockedReason id={blockedId}>
              Amount in controversy must be whole cents (digits only).
            </BlockedReason>
          ) : null}
          <ButtonRow end>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={busy || amountBad}
              aria-describedby={amountBad ? blockedId : undefined}
            >
              {busy ? "Working…" : view.detail ? "Save details" : "Record details"}
            </Button>
          </ButtonRow>
        </>
      ) : null}
      <RecordedDeadlines
        subject={{ kind: "appeal", id: appealId }}
        deadlines={view.deadlines}
        allowNoticeDocument
        editable={editable}
        onChanged={() => {
          void load(false);
          onChanged();
        }}
      />
    </section>
  );
}
