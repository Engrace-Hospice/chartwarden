// apps/web/src/modules/16-bereavement — the ROSTER + SCHEDULE SEED (§5.1 #6, Track B / ADR-0030).
// Spec: docs/design/screens/clinical — "Use Guided Flow."
//
// Route 5 is the ONE transition that opens the program (`initiating → active`): it seeds the bereaved
// contacts from M5's caregiver roster, adds whatever the counselor typed, and materializes the D4
// platform-floor schedule for the whole 13-month window in a single transaction.
//
// The platform floor is DESCRIBED here, not computed here. §D4 makes the cadence cumulative and the tenant
// may only TIGHTEN it (add touchpoints, never drop one, never push a floor item past its scheduled date),
// and the server is the only place that knows the tenant's configuration — so this screen states the floor
// and then reports what the server ACTUALLY materialized, rather than drawing a preview it would have had
// to invent.
import { EmptyState, LoadingSpinner, PageHeader, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type BereavementRelationshipCode,
  type ContactDraft,
  type PlanActivation,
  type PlanDetail,
  errorMessage,
  getPlan,
  seedRosterAndSchedule,
} from "./bereavement-api";
import {
  Card,
  CheckboxField,
  Field,
  Notice,
  SelectField,
  SummaryGrid,
  TextField,
  alertStyle,
  columnStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./bereavement-ui";
import { RELATIONSHIP_CODES, humanize, shortDate, shortId } from "./bereavement-status";

/** The §D4 platform floor, stated for the counselor. Cumulative: a high-risk survivor gets the low-tier
 *  touchpoints AND the extra ones, never a replacement set. */
const FLOOR = [
  { mark: "1 month", note: "every tier" },
  { mark: "3 months", note: "every tier" },
  { mark: "6 months", note: "every tier" },
  { mark: "9 months", note: "high-risk and complicated only" },
  { mark: "Anniversary (13 months)", note: "every tier" },
];

export function BereavementRosterSeed(): JSX.Element {
  const client = useApiClient();
  const { planId } = useParams<{ planId: string }>();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seedFromCaregivers, setSeedFromCaregivers] = useState(true);
  const [drafts, setDrafts] = useState<ContactDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [result, setResult] = useState<PlanActivation | null>(null);

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

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!plan || !planId)
    return <EmptyState title="Not found" description="This bereavement plan does not exist, or is not on your caseload." />;

  const addDraft = () =>
    setDrafts([...drafts, { displayName: "", relationshipCode: "friend" }]);
  const setDraft = (i: number, next: ContactDraft) =>
    setDrafts(drafts.map((d, j) => (j === i ? next : d)));
  const removeDraft = (i: number) => setDrafts(drafts.filter((_, j) => j !== i));

  const submit = async () => {
    setBusy(true);
    setActionError(null);
    const additional = drafts
      .filter((d) => d.displayName.trim().length > 0)
      .map((d) => ({
        ...d,
        email: d.email || undefined,
        phone: d.phone || undefined,
        mailingAddress: d.mailingAddress || undefined,
      }));
    const { activation, error: err } = await seedRosterAndSchedule(client, planId, plan.version, {
      seedFromCaregivers,
      additionalContacts: additional.length > 0 ? additional : undefined,
    });
    setBusy(false);
    if (err) {
      setActionError(errorMessage(err, "The roster and schedule could not be seeded."));
      return;
    }
    setResult(activation);
    void load();
  };

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Seed roster + schedule</span>}
        breadcrumb={`Bereavement — plan ${shortId(plan.planId)}`}
        actions={
          <Link to={`/bereavement/plans/${planId}`} style={ghostButtonStyle}>
            Back to plan
          </Link>
        }
      />

      {plan.status !== "initiating" ? (
        <Notice tone="warning">
          This plan is {humanize(plan.status).toLowerCase()}. Seeding opens a plan from `initiating`; the
          server refuses the transition from any other state.
        </Notice>
      ) : null}

      {result ? (
        <Notice tone="success">
          Plan opened. {result.contactsSeededCount} contacts seeded · {result.outreachScheduledCount}{" "}
          touchpoints scheduled · {result.anniversaryRemindersCount} anniversary reminders queued.{" "}
          <Link to={`/bereavement/plans/${planId}/outreach`} style={linkStyle}>
            Open the outreach planner
          </Link>
        </Notice>
      ) : null}

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      <Card title="Plan">
        <SummaryGrid>
          <Field label="Death date" value={shortDate(plan.deathDate)} />
          <Field label="Window ends" value={shortDate(plan.windowEndsAt)} />
          <Field label="Counselor" value={shortId(plan.assignedCounselorUserId)} mono />
          <Field label="Contacts already on roster" value={plan.contacts.length} />
        </SummaryGrid>
      </Card>

      <Card title="Seed from the patient's caregivers">
        <CheckboxField
          label="Seed bereaved contacts from the M5 caregiver roster"
          checked={seedFromCaregivers}
          onChange={setSeedFromCaregivers}
        />
        <span style={mutedStyle}>
          Seeded contacts land in `proposed`. Each one is confirmed individually, which is where the M39
          bereavement-outreach consent verdict is resolved — fail-CLOSED.
        </span>
      </Card>

      <Card
        title="Additional contacts"
        actions={
          <button type="button" style={ghostButtonStyle} onClick={addDraft}>
            Add a contact
          </button>
        }
      >
        {drafts.length === 0 ? (
          <span style={mutedStyle}>
            No custom contacts. Survivors the caregiver roster does not carry — a sibling in another state,
            a close friend — are added here.
          </span>
        ) : (
          drafts.map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a draft row has no id until the server assigns one
            <div key={i} style={{ display: "grid", gap: "0.5rem", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))" }}>
              <TextField
                label="Display name"
                value={d.displayName}
                onChange={(v) => setDraft(i, { ...d, displayName: v })}
              />
              <SelectField
                label="Relationship"
                value={d.relationshipCode}
                options={RELATIONSHIP_CODES.map((c) => ({ value: c, label: humanize(c) }))}
                onChange={(v) => setDraft(i, { ...d, relationshipCode: v as BereavementRelationshipCode })}
              />
              <TextField
                label="Email"
                type="email"
                value={d.email ?? ""}
                onChange={(v) => setDraft(i, { ...d, email: v })}
              />
              <TextField
                label="Phone"
                type="tel"
                value={d.phone ?? ""}
                onChange={(v) => setDraft(i, { ...d, phone: v })}
              />
              <button type="button" style={ghostButtonStyle} onClick={() => removeDraft(i)}>
                Remove
              </button>
            </div>
          ))
        )}
      </Card>

      <Card title="Platform-floor schedule (§D4)">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Mark</th>
              <th style={th}>Applies to</th>
            </tr>
          </thead>
          <tbody>
            {FLOOR.map((f) => (
              <tr key={f.mark} style={rowLine}>
                <td style={td}>{f.mark}</td>
                <td style={td}>{f.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <span style={mutedStyle}>
          The floor is cumulative: a high-risk survivor receives the shared touchpoints AND the extra ones.
          Your organization may tighten this — add touchpoints, or move one earlier — but may never drop a
          floor item or push it past its scheduled date. What is actually materialized is reported above
          once the plan opens.
        </span>
      </Card>

      <div>
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || plan.status !== "initiating"}
          onClick={submit}
        >
          {busy ? "Opening the plan…" : "Seed roster and open the plan"}
        </button>
      </div>
    </div>
  );
}
