// apps/web/src/modules/19-oncall — S19.10 TENANT ON-CALL POLICY (`/triage/policy`, §5.1, Track B /
// ADR-0030). Spec: WARDENX_UI_ONCALL_ROSTER_PROTOCOLS.md — the Escalation-Tier Editor tab.
//
// THE POLICY ROW IS PER (ORG, PROVIDER ENTITY) AND IS NOT AUTO-CREATED ON READ. The escalation ladder in
// force on a shift is PINNED onto that shift when it activates, so a default invented at read time would
// be pinned as though the tenant had chosen it. A 404 here therefore means "no policy authored yet" and
// the screen says exactly that rather than rendering an empty form that looks like a saved configuration.
//
// THE THREE JSON COLUMNS ARE EDITED AS JSON, DELIBERATELY. `escalationTiers`, `callbackSlaPerSeverity` and
// `stateOverrides` are typed as free-form records by §4.2 — no per-key TypeBox is published — so a
// structured form here would be this screen's *guess* at a shape the server does not validate, and the
// first tenant whose ladder had a key the form did not know would silently lose it on save. The editor
// shows the real object, refuses to send invalid JSON, and names the platform floor it cannot lower.
//
// THE PLATFORM FLOOR IS NOT AN EDITABLE ROW HERE. §5.1 sketches "locked rows" for the four mandatory
// triggers in this editor; those live in the PROTOCOL CATALOG (`triage_protocol_question.is_system_locked`
// with its own RLS denial), not on the policy. Rendering fake locked rows on this page would put a second,
// unenforced copy of the floor in front of the DON. The link to the catalog is the honest answer.
//
// EVERY WRITE ON THIS SCREEN NEEDS A STEP-UP, because lowering a mandatory-escalation tier is the named
// tampering threat this route's gate exists for.
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import {
  type OncallModel,
  type OncallPolicyView,
  errorMessage,
  getPolicy,
  patchPolicy,
} from "./oncall-api";
import { ONCALL_MODELS, humanize } from "./oncall-status";
import {
  Card,
  CheckboxField,
  Field,
  Notice,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  alertStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  primaryButtonStyle,
} from "./oncall-ui";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{1,14}$/;

/** Pretty-print an unknown JSON column for the editor. `null`/absent becomes `{}` rather than "null": an
 *  empty object is what an unconfigured ladder IS, and showing the word "null" invites somebody to type
 *  over it with prose. */
function asJsonText(value: unknown): string {
  if (value === null || value === undefined) return "{}";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

/** Parse an edited JSON column. Returns `undefined` when the text is not a JSON OBJECT — an array or a
 *  scalar would be accepted by `JSON.parse` and refused by the server's `Record` schema, and a 422 the
 *  editor could have prevented reads as a broken save. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function OnCallPolicyScreen(): JSX.Element {
  const client = useApiClient();
  const [providerEntityId, setProviderEntityId] = useState("");
  const [policy, setPolicy] = useState<OncallPolicyView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // edit buffers
  const [model, setModel] = useState("direct");
  const [tiersText, setTiersText] = useState("{}");
  const [slaText, setSlaText] = useState("{}");
  const [overridesText, setOverridesText] = useState("{}");
  const [emergencyContact, setEmergencyContact] = useState("");
  const [aiSuggestion, setAiSuggestion] = useState(false);
  const [aiRisk, setAiRisk] = useState(false);

  const load = useCallback(async () => {
    if (!UUID_RE.test(providerEntityId)) return;
    setLoading(true);
    setError(null);
    setSaved(false);
    const res = await getPolicy(client, providerEntityId);
    setLoading(false);
    if (res.error || !res.policy) {
      setPolicy(null);
      setError(
        errorMessage(
          res.error,
          "No on-call policy is authored for this provider entity yet. The row is not created on read, deliberately: the escalation ladder is pinned onto every shift that opens, and a default invented here would be pinned as though you had chosen it.",
        ),
      );
      return;
    }
    setPolicy(res.policy);
    setModel(res.policy.model);
    setTiersText(asJsonText(res.policy.escalationTiers));
    setSlaText(asJsonText(res.policy.callbackSlaPerSeverity));
    setOverridesText(asJsonText(res.policy.stateOverrides));
    setEmergencyContact(res.policy.emergencyContactE164 ?? "");
    setAiSuggestion(res.policy.aiProtocolSuggestionEnabled);
    setAiRisk(res.policy.aiHospitalizationRiskEnabled);
  }, [client, providerEntityId]);

  useEffect(() => {
    void load();
  }, [load]);

  const tiers = parseJsonObject(tiersText);
  const sla = parseJsonObject(slaText);
  const overrides = parseJsonObject(overridesText);
  const contactValid = emergencyContact === "" || E164_RE.test(emergencyContact);
  const canSave =
    policy !== null &&
    tiers !== undefined &&
    sla !== undefined &&
    overrides !== undefined &&
    contactValid &&
    !busy;

  async function save(): Promise<void> {
    if (!policy || !tiers || !sla || !overrides) return;
    setBusy(true);
    setActionError(null);
    setSaved(false);
    const res = await patchPolicy(client, policy.providerEntityId, policy.version, {
      // `model` is always one of ONCALL_MODELS — the SelectField below offers no other value.
      model: model as OncallModel,
      escalationTiers: tiers,
      callbackSlaPerSeverity: sla,
      stateOverrides: overrides,
      emergencyContactE164: emergencyContact === "" ? null : emergencyContact,
      aiProtocolSuggestionEnabled: aiSuggestion,
      aiHospitalizationRiskEnabled: aiRisk,
    });
    setBusy(false);
    if (res.error || !res.policy) {
      setActionError(errorMessage(res.error, "The policy could not be saved."));
      return;
    }
    setPolicy(res.policy);
    setSaved(true);
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="On-call policy"
          breadcrumb="On-call triage / Configuration"
          actions={
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <Link to="/triage/protocols" style={linkButtonStyle}>
                Protocol catalog
              </Link>
              <Link to="/triage/vendors" style={linkButtonStyle}>
                External vendors
              </Link>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Configure the provider-specific escalation ladder, fallback contact, and advisory AI
            toggles.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          <Card title="Provider entity">
            <TextField
              label="Provider entity id"
              value={providerEntityId}
              onChange={setProviderEntityId}
              mono
              hint="The policy row is per (organization, provider entity). Coverage obligations are per CCN, so the ladder is too."
            />
          </Card>
          {policy ? (
            <Notice tone="warning">
              Saving this policy needs a recent step-up. The platform-floor mandatory escalations
              live on system-locked protocol questions; you may raise a tier, but you cannot lower
              one below the floor.
            </Notice>
          ) : null}
          {actionError ? (
            <div role="alert" style={errorBannerStyle}>
              {actionError}
            </div>
          ) : null}
          {saved ? (
            <Notice tone="success" live>
              Policy saved. The new ladder is pinned onto shifts that activate from now on — shifts
              already active keep the snapshot they opened with.
            </Notice>
          ) : null}
        </div>
      }
      table={
        <div style={contentShellStyle}>
          {loading ? (
            <div style={loadingShellStyle}>
              <LoadingSpinner />
            </div>
          ) : null}

          {!loading && error ? (
            <div style={emptyShellStyle}>
              <EmptyState title="No policy" description={error} />
            </div>
          ) : null}

          {policy ? (
            <>
              <Card title="Current policy">
                <SummaryGrid>
                  <Field label="Provider entity" value={policy.providerEntityId} mono />
                  <Field
                    label="Deployment model"
                    value={
                      <StatusPill
                        label={humanize(policy.model)}
                        tone={policy.model === "direct" ? "success" : "progress"}
                      />
                    }
                  />
                  <Field
                    label="Bound vendor"
                    value={policy.externalTriageVendorId ?? "none"}
                    mono={Boolean(policy.externalTriageVendorId)}
                  />
                  <Field label="Version (If-Match)" value={String(policy.version)} mono />
                </SummaryGrid>
              </Card>

              <Card title="Deployment model">
                <SelectField
                  label="Model"
                  value={model}
                  options={ONCALL_MODELS.map((m) => ({ value: m, label: humanize(m) }))}
                  onChange={setModel}
                />
                <span style={mutedStyle}>
                  Only the direct model ships live. Selecting hybrid or centralized on a deployment
                  where the feature flag is off is refused rather than accepted-and-ignored.
                </span>
              </Card>

              <Card title="Escalation ladder">
                <TextAreaField
                  label="Escalation tiers (JSON object)"
                  value={tiersText}
                  onChange={setTiersText}
                  rows={8}
                  hint="Edited as JSON because no per-key schema is published for this column."
                />
                {tiers === undefined ? (
                  <p style={alertStyle}>
                    That is not a JSON object. Fix it before saving — the server expects an object,
                    and an array or a bare value would be refused.
                  </p>
                ) : null}
                <TextAreaField
                  label="Callback SLA per severity (JSON object)"
                  value={slaText}
                  onChange={setSlaText}
                  rows={6}
                  hint="What the callback-SLA detector chases when a call is parked without an explicit target."
                />
                {sla === undefined ? <p style={alertStyle}>That is not a JSON object.</p> : null}
                <TextAreaField
                  label="State overrides (JSON object)"
                  value={overridesText}
                  onChange={setOverridesText}
                  rows={6}
                  hint="State-specific routing (mandatory-reporter rules and the like)."
                />
                {overrides === undefined ? (
                  <p style={alertStyle}>That is not a JSON object.</p>
                ) : null}
              </Card>

              <Card title="Degraded-mode contact">
                <TextField
                  label="Agency after-hours number (E.164)"
                  value={emergencyContact}
                  onChange={setEmergencyContact}
                  type="tel"
                  mono
                  placeholder="+15125550123"
                  hint="Your OWN published number. When alert delivery is degraded, this is what the status surface shows a caller."
                />
                {!contactValid ? (
                  <p style={alertStyle}>
                    A contact number must be E.164 (a leading + and 2–15 digits).
                  </p>
                ) : null}
              </Card>

              <Card title="AI capabilities (advisory only)">
                <CheckboxField
                  label="Show the AI protocol suggestion on intake"
                  checked={aiSuggestion}
                  onChange={setAiSuggestion}
                />
                <CheckboxField
                  label="Show the hospitalization-risk advisory on the panel"
                  checked={aiRisk}
                  onChange={setAiRisk}
                />
                <span style={mutedStyle}>
                  Both are advisory: the clinician always selects the protocol, and the risk band
                  alters no disposition option.
                </span>
              </Card>

              <div>
                <button
                  type="button"
                  disabled={!canSave}
                  style={canSave ? primaryButtonCompactStyle : disabledButtonCompactStyle}
                  onClick={() => void save()}
                >
                  {busy ? "Saving…" : "Save the policy"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      }
      fullPageScroll
    />
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const contentShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "0 1.5rem 1.5rem",
};

const loadingShellStyle: CSSProperties = {
  padding: "2.5rem 1.5rem",
  textAlign: "center",
};

const emptyShellStyle: CSSProperties = {
  padding: "1rem 0",
};

const errorBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  color: "var(--color-error-pill-fg)",
  fontSize: "0.85rem",
};

const linkButtonStyle: CSSProperties = {
  ...ghostButtonStyle,
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
};

const primaryButtonCompactStyle: CSSProperties = {
  ...primaryButtonStyle,
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
};

const disabledButtonCompactStyle: CSSProperties = {
  ...disabledButtonStyle,
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
};
