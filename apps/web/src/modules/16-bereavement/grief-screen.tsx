// apps/web/src/modules/16-bereavement — the COMPLICATED GRIEF SCREEN (§5.1 #13, Track B / ADR-0030),
// carrying the §5.1 #14 external-referral composer. Spec: docs/design/screens/clinical — "Use Guided Flow."
//
// The PG-13-adapted instrument, its auto-scoring, and the two DIFFERENT things a positive screen can lead
// to. Those two are deliberately separate ceremonies, because "we gave them a number" and "we handed their
// care over" are different clinical facts and collapsing them would misreport §7.7 on the survey record:
//
//   • REFER (route 32) — logs an M40 external-resource referral and the program CONTINUES.
//   • ESCALATE (route 18) — flags complicated grief, ENDS the M16 program for this survivor, and routes
//     them to the named external resource. The M40 resource is REQUIRED on this path: "referred to
//     external services" with nowhere named is a dead end for someone in crisis.
//
// THE INSTRUMENT IS SCORED LOCALLY AND SENT AS A NUMBER, NOT AS ITEM RESPONSES. The route accepts
// `pg13Score` / `ipgrScore`, and M16 publishes no per-item store — so the items live in this form as the
// arithmetic the counselor would otherwise do on paper, and only the total crosses the wire. The threshold
// prompt below is an ADVISORY: the tier promotion to `complicated` is the server's, driven by route 18.
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type ContactRow,
  type PlanDetail,
  errorMessage,
  flagComplicatedGrief,
  getPlan,
  referExternal,
} from "./bereavement-api";
import { CONTACT_STATUS_TONE, humanize, shortId, toneOf } from "./bereavement-status";
import {
  Card,
  Field,
  Modal,
  Notice,
  RiskTierPill,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  alertStyle,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./bereavement-ui";

/**
 * The PG-13 item set, adapted for bereavement screening. Thirteen items, each 0–4 (never … always), so the
 * total runs 0–52 — the exact range the route's `pg13Score` accepts.
 */
const PG13_ITEMS = [
  "Yearning or longing for the person who died",
  "Intense emotional pain about the death",
  "Preoccupation with thoughts of the person who died",
  "Preoccupation with the circumstances of the death",
  "Trouble accepting the death",
  "Disbelief about the death",
  "Feeling that part of oneself has died",
  "Bitterness or anger related to the death",
  "Difficulty trusting others since the death",
  "Feeling emotionally numb since the death",
  "Feeling that life is meaningless without the person",
  "Feeling alone or detached from others",
  "Avoiding reminders of the loss",
];

/** The screening threshold the instrument's literature places on the adapted total. Advisory only. */
const PG13_THRESHOLD = 30;

const RESPONSES = [
  { value: "0", label: "0 — never" },
  { value: "1", label: "1 — rarely" },
  { value: "2", label: "2 — sometimes" },
  { value: "3", label: "3 — often" },
  { value: "4", label: "4 — always" },
];

export function BereavementGriefScreen(): JSX.Element {
  const client = useApiClient();
  const { planId, contactId } = useParams<{ planId: string; contactId: string }>();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [responses, setResponses] = useState<number[]>(() => PG13_ITEMS.map(() => 0));
  const [ipgr, setIpgr] = useState("");
  const [ceremony, setCeremony] = useState<"refer" | "escalate" | null>(null);

  const load = useCallback(async () => {
    if (!planId) return;
    setLoading(true);
    setError(null);
    const { plan: p, error: err } = await getPlan(client, planId);
    if (err) {
      setError(errorMessage(err, "This bereavement plan could not be loaded."));
      setLoading(false);
      return;
    }
    setPlan(p);
    setLoading(false);
  }, [client, planId]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = useMemo(() => responses.reduce((a, b) => a + b, 0), [responses]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  const contact = plan?.contacts.find((c) => c.contactId === contactId);
  if (!plan || !contact || !contactId || !planId)
    return (
      <EmptyState
        title="Not found"
        description="This bereaved contact is not on this plan's roster, or the plan is not on your caseload."
      />
    );

  const met = total >= PG13_THRESHOLD;

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Complicated grief screen</span>}
        breadcrumb={`Bereavement — ${contact.displayName}`}
        actions={
          <Link to={`/bereavement/plans/${planId}/contacts/${contactId}`} style={ghostButtonStyle}>
            Back to contact
          </Link>
        }
      />

      <Card
        title="Survivor"
        actions={
          <StatusPill
            label={humanize(contact.status)}
            tone={toneOf(CONTACT_STATUS_TONE, contact.status)}
          />
        }
      >
        <SummaryGrid>
          <Field label="Relationship" value={humanize(contact.relationshipCode)} />
          <Field label="Current tier" value={<RiskTierPill tier={contact.currentRiskTier} />} />
          <Field label="Version" value={contact.version} />
        </SummaryGrid>
      </Card>

      <Card
        title="PG-13 (bereavement-adapted)"
        actions={
          <StatusPill
            label={`Total ${total} / 52`}
            tone={met ? "error" : total >= PG13_THRESHOLD - 6 ? "warning" : "success"}
          />
        }
      >
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Item</th>
              <th style={th}>Response</th>
            </tr>
          </thead>
          <tbody>
            {PG13_ITEMS.map((item, i) => (
              <tr key={item} style={rowLine}>
                <td style={td}>{item}</td>
                <td style={td}>
                  <SelectField
                    label={item}
                    value={String(responses[i])}
                    options={RESPONSES}
                    onChange={(v) =>
                      setResponses(responses.map((r, j) => (j === i ? Number(v) : r)))
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <span style={mutedStyle}>
          Scored on this screen and sent as a total: the route records `pg13Score`, and Module 16
          keeps no per-item store, so nothing here pretends the individual responses are retained.
        </span>
      </Card>

      <Card title="IPGR (optional)">
        <TextField
          label="IPGR total (0–200)"
          type="number"
          value={ipgr}
          onChange={setIpgr}
          describedBy="ipgr-hint"
        />
        <span id="ipgr-hint" style={mutedStyle}>
          Recorded alongside the PG-13 total when a second instrument was administered.
        </span>
      </Card>

      {met ? (
        <Notice tone="error" live>
          The screening threshold ({PG13_THRESHOLD}) is met. Escalate to complicated grief and hand
          this survivor to a named external resource, or — if the program should continue — log a
          referral without ending it. This banner is advisory: the tier promotion is applied by the
          server when the escalation is recorded.
        </Notice>
      ) : null}

      <Card title="Outcome">
        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
          <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("refer")}>
            Log an external referral (program continues)
          </button>
          <button type="button" style={primaryButtonStyle} onClick={() => setCeremony("escalate")}>
            Escalate — complicated grief
          </button>
        </div>
        <span style={mutedStyle}>
          Escalating ends the bereavement program for this survivor and routes them to the named
          external resource; a referral leaves the program running. They are separate records
          because they are separate clinical facts.
        </span>
      </Card>

      {ceremony === "refer" ? (
        <ReferralModal
          contact={contact}
          onClose={() => setCeremony(null)}
          onDone={() => {
            setCeremony(null);
            void load();
          }}
        />
      ) : null}
      {ceremony === "escalate" ? (
        <EscalateModal
          contact={contact}
          pg13Score={total}
          ipgrScore={ipgr ? Number(ipgr) : undefined}
          onClose={() => setCeremony(null)}
          onDone={() => {
            setCeremony(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

/** §5.1 #14 — the external-referral composer (route 32). The program CONTINUES. */
function ReferralModal({
  contact,
  onClose,
  onDone,
}: { contact: ContactRow; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [externalResourceId, setExternalResourceId] = useState("");
  const [contactAt, setContactAt] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await referExternal(client, contact.contactId, {
      externalResourceId,
      contactAt: contactAt ? new Date(contactAt).toISOString() : undefined,
      notes: notes || undefined,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The referral could not be recorded."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Log an external grief-resource referral"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || externalResourceId.trim().length === 0}
          onClick={submit}
        >
          {busy ? "Recording…" : "Log referral"}
        </button>
      }
    >
      <Notice tone="info">
        The resource is chosen from the platform's external grief-resource catalog (Module 40). Its
        identifier is entered here because Module 16 publishes no catalog-browse route of its own —
        the server validates it against the catalog and refuses an unknown id.
      </Notice>
      <TextField
        label="External grief-resource id (M40)"
        value={externalResourceId}
        onChange={setExternalResourceId}
      />
      <TextField
        label="Referred at (optional)"
        type="datetime-local"
        value={contactAt}
        onChange={setContactAt}
      />
      <TextAreaField label="Note" value={notes} onChange={setNotes} />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

/** Route 18 — §7.7 escalation. ENDS the program for this survivor; the M40 resource is required. */
function EscalateModal({
  contact,
  pg13Score,
  ipgrScore,
  onClose,
  onDone,
}: {
  contact: ContactRow;
  pg13Score: number;
  ipgrScore?: number;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [externalResourceId, setExternalResourceId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await flagComplicatedGrief(client, contact.contactId, contact.version, {
      externalResourceId,
      pg13Score,
      ipgrScore,
      note: note || undefined,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The escalation could not be recorded."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Escalate — complicated grief"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || externalResourceId.trim().length === 0}
          onClick={submit}
        >
          {busy ? "Escalating…" : "Escalate"}
        </button>
      }
    >
      <Notice tone="warning">
        This ends the bereavement program for {contact.displayName} and promotes their risk tier to
        complicated. A named external resource is required — "referred to external services" with
        nowhere named is a dead end for someone in crisis.
      </Notice>
      <TextField
        label="External grief-resource id (M40)"
        value={externalResourceId}
        onChange={setExternalResourceId}
      />
      <SummaryGrid>
        <Field label="PG-13 total" value={pg13Score} />
        <Field label="IPGR total" value={ipgrScore ?? "—"} />
      </SummaryGrid>
      <TextAreaField label="Clinical note" value={note} onChange={setNote} />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}
