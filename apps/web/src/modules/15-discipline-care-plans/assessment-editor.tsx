import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/15-discipline-care-plans — the DISCIPLINE ASSESSMENT EDITOR (§5.1 #7, Track B).
//
// Capture, sign and amend one discipline assessment (routes 12 / 13 / 14). The lifecycle it renders is
// append-only correction-of-record (M9 D9, §2.2.3): a SIGNED assessment is never edited — an amendment
// creates a NEW row that supersedes it, carrying the reason, and both stay on the record.
//
// The `data` payload is entered as JSON rather than as a generated form. That is deliberate and honest: the
// §3.4 per-kind TypeBox schemas are validated SERVER-side and are not published to the client, so a
// hand-drawn form would be a second, drifting copy of a contract this screen cannot see. The server's
// validation error is surfaced verbatim; when the per-kind schemas are published, this control is the one
// place that changes.
//
// The two confidentiality flags are captured at the point of authorship because they drive the §7.8/§7.9
// SQL filter for every subsequent reader — a flag set later cannot un-disclose what was already read.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type AssessmentView,
  type PlanDetail,
  errorMessage,
  getPlan,
  writeHeaders,
} from "./discipline-api";
import {
  ASSESSMENT_STATUS_TONE,
  assessmentKindLabel,
  dateTime,
  humanize,
  shortId,
  toneOf,
} from "./discipline-status";
import {
  Card,
  Field,
  Notice,
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
} from "./discipline-ui";

/** `discipline_assessment_kind` (enums.ts §3.2). */
const KIND_OPTIONS = [
  { value: "msw_psychosocial", label: "MSW psychosocial" },
  { value: "chaplain_spiritual", label: "Chaplain spiritual" },
  { value: "aide_environmental", label: "Aide environmental" },
  { value: "volunteer_relationship", label: "Volunteer relationship" },
];

/** The route param that means "capture a new assessment" rather than "open an existing one". */
const NEW = "new";

export function AssessmentEditor(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId, planId, assessmentId } = useParams<{
    patientId: string;
    planId: string;
    assessmentId: string;
  }>();
  const creating = assessmentId === NEW;

  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [kind, setKind] = useState("msw_psychosocial");
  const [capturedAt, setCapturedAt] = useState(new Date().toISOString().slice(0, 16));
  const [isInitial, setIsInitial] = useState(false);
  const [sudFlag, setSudFlag] = useState(false);
  const [familyViolenceFlag, setFamilyViolenceFlag] = useState(false);
  const [dataText, setDataText] = useState("{}");
  const [amendReason, setAmendReason] = useState("");
  const [amending, setAmending] = useState(false);

  const load = useCallback(async () => {
    if (!planId) return;
    setLoading(true);
    setError(null);
    const { plan: loaded, error: err } = await getPlan(client, planId);
    if (err || !loaded) {
      setError(errorMessage(err, "This plan could not be loaded."));
      setLoading(false);
      return;
    }
    setPlan(loaded);
    const found = loaded.assessments.find((a) => a.assessmentId === assessmentId) ?? null;
    if (found) {
      setKind(found.kind);
      setCapturedAt(found.capturedAt.slice(0, 16));
      setIsInitial(found.isInitial);
      setSudFlag(found.sudFlag);
      setFamilyViolenceFlag(found.familyViolenceFlag);
      setDataText(JSON.stringify(found.data ?? {}, null, 2));
    }
    setLoading(false);
  }, [client, planId, assessmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  function parsedData(): unknown | undefined {
    try {
      return JSON.parse(dataText);
    } catch {
      return undefined;
    }
  }

  async function create(): Promise<void> {
    if (!plan) return;
    const data = parsedData();
    if (data === undefined) {
      setActionError("The assessment content is not valid JSON.");
      return;
    }
    setActionError(null);
    const res = await client.POST("/api/v1/discipline-plans/{planId}/assessments", {
      params: { path: { planId: plan.planId }, header: writeHeaders() },
      body: {
        kind,
        capturedAt: new Date(capturedAt).toISOString(),
        isInitial,
        sudFlag,
        familyViolenceFlag,
        data,
      },
    } as never);
    if (res.error) {
      setActionError(errorMessage(res.error, "The assessment could not be captured."));
      return;
    }
    navigate(`/patients/${patientId}/discipline-plans/msw-plan`);
  }

  async function sign(assessment: AssessmentView): Promise<void> {
    if (!plan) return;
    setActionError(null);
    const res = await client.POST(
      "/api/v1/discipline-plans/{planId}/assessments/{assessmentId}/sign",
      {
        params: {
          path: { planId: plan.planId, assessmentId: assessment.assessmentId },
          header: writeHeaders(assessment.version),
        },
        body: {},
      } as never,
    );
    if (res.error) {
      setActionError(
        errorMessage(
          res.error,
          "The assessment was not signed. Signing requires a recently re-authenticated session.",
        ),
      );
      return;
    }
    await load();
  }

  async function amend(assessment: AssessmentView): Promise<void> {
    if (!plan) return;
    const data = parsedData();
    if (data === undefined) {
      setActionError("The amended content is not valid JSON.");
      return;
    }
    setActionError(null);
    const res = await client.POST(
      "/api/v1/discipline-plans/{planId}/assessments/{assessmentId}/amend",
      {
        params: {
          path: { planId: plan.planId, assessmentId: assessment.assessmentId },
          header: writeHeaders(assessment.version),
        },
        body: { amendmentReason: amendReason, data },
      } as never,
    );
    if (res.error) {
      setActionError(errorMessage(res.error, "The amendment could not be recorded."));
      return;
    }
    setAmending(false);
    setAmendReason("");
    await load();
  }

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!plan) return <EmptyState title="Not found" description="This plan is not available." />;

  const assessment = creating
    ? null
    : (plan.assessments.find((a) => a.assessmentId === assessmentId) ?? null);
  if (!creating && !assessment)
    return (
      <EmptyState
        title="Assessment not available"
        description="This assessment is not on the plan, or its content is withheld from you under the plan's confidentiality rules."
      />
    );

  const signed = assessment?.status === "signed" || assessment?.status === "amended";

  return (
    <div style={columnStyle}>
      <PageHeader
        title={
          <span style={pageTitleStyle}>
            {creating ? "Capture assessment" : assessmentKindLabel(assessment?.kind)}
          </span>
        }
        breadcrumb="Clinical — discipline assessment"
        actions={
          <Link to={`/patients/${patientId}/discipline-plans/msw-plan`} style={ghostButtonStyle}>
            Back to plan
          </Link>
        }
      />

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      {assessment ? (
        <Card
          title="Record"
          actions={
            <StatusPill
              label={humanize(assessment.status)}
              tone={toneOf(ASSESSMENT_STATUS_TONE, assessment.status)}
            />
          }
        >
          <SummaryGrid>
            <Field label="Captured" value={dateTime(assessment.capturedAt)} />
            <Field label="Captured by" value={shortId(assessment.capturedByMembershipId)} mono />
            <Field label="Signed" value={dateTime(assessment.signedAt)} />
            <Field label="Initial" value={assessment.isInitial ? "Yes" : "No"} />
            <Field label="Source encounter" value={shortId(assessment.sourceEncounterId)} mono />
            {assessment.amendsAssessmentId ? (
              <Field label="Amends" value={shortId(assessment.amendsAssessmentId)} mono />
            ) : null}
          </SummaryGrid>
          {assessment.amendmentReason ? (
            <Notice tone="info">Amendment reason: {assessment.amendmentReason}</Notice>
          ) : null}
          {assessment.sudFlag || assessment.familyViolenceFlag ? (
            <Notice tone="warning">
              This assessment is flagged{" "}
              {[
                assessment.sudFlag ? "substance-use disorder" : null,
                assessment.familyViolenceFlag ? "family violence" : null,
              ]
                .filter(Boolean)
                .join(" and ")}
              . Colleagues without the matching consent do not receive it at all.
            </Notice>
          ) : null}
        </Card>
      ) : null}

      <Card title={creating ? "New assessment" : signed ? "Content (signed record)" : "Content"}>
        {creating ? (
          <>
            <div
              style={{ display: "flex", gap: t.space3, flexWrap: "wrap", alignItems: "flex-end" }}
            >
              <SelectField label="Kind" value={kind} options={KIND_OPTIONS} onChange={setKind} />
              <TextField
                label="Captured at"
                type="datetime-local"
                value={capturedAt}
                onChange={setCapturedAt}
              />
            </div>
            <label
              style={{ display: "flex", gap: t.space2, fontSize: "0.82rem", color: t.onSurface }}
            >
              <input
                type="checkbox"
                checked={isInitial}
                onChange={(e) => setIsInitial(e.target.checked)}
              />
              This is the initial assessment (a signed initial closes the five-day clock)
            </label>
            <label
              style={{ display: "flex", gap: t.space2, fontSize: "0.82rem", color: t.onSurface }}
            >
              <input
                type="checkbox"
                checked={sudFlag}
                onChange={(e) => setSudFlag(e.target.checked)}
              />
              Contains substance-use-disorder content (42 CFR Part 2)
            </label>
            <label
              style={{ display: "flex", gap: t.space2, fontSize: "0.82rem", color: t.onSurface }}
            >
              <input
                type="checkbox"
                checked={familyViolenceFlag}
                onChange={(e) => setFamilyViolenceFlag(e.target.checked)}
              />
              Contains family-violence content
            </label>
          </>
        ) : null}

        <TextAreaField
          label="Assessment content (JSON)"
          value={dataText}
          onChange={setDataText}
          rows={14}
          hint="Validated against this kind's schema on the server; a validation failure is reported field by field."
        />
        <span style={mutedStyle}>
          {signed
            ? "This record is signed. Editing it means recording an amendment — the signed row stays on the record."
            : "A draft assessment can be re-captured until it is signed."}
        </span>

        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
          {creating ? (
            <button type="button" style={primaryButtonStyle} onClick={() => void create()}>
              Capture assessment
            </button>
          ) : null}
          {assessment && assessment.status === "draft" ? (
            <button type="button" style={primaryButtonStyle} onClick={() => void sign(assessment)}>
              Sign assessment
            </button>
          ) : null}
          {assessment && signed ? (
            <button type="button" style={ghostButtonStyle} onClick={() => setAmending(true)}>
              Amend
            </button>
          ) : null}
        </div>

        {amending && assessment ? (
          <>
            <TextAreaField
              label="Amendment reason"
              value={amendReason}
              onChange={setAmendReason}
              rows={3}
              hint="Required. The amendment is a new row that supersedes this one; neither is deleted."
            />
            <button
              type="button"
              disabled={amendReason.trim() === ""}
              style={{ ...primaryButtonStyle, opacity: amendReason.trim() === "" ? 0.5 : 1 }}
              onClick={() => void amend(assessment)}
            >
              Record amendment
            </button>
          </>
        ) : null}
      </Card>
    </div>
  );
}
