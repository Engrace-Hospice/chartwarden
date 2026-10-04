import {
  Button,
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  cardSurface,
  ghostBorder,
  t,
  useApiClient,
} from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ASSESSMENT_TONE, stateLabel } from "./assessment-status";
import type { AssessmentDetailView } from "./assessments-api";
import { loadScaleCatalog } from "./assessments-api";

/** Read-only capture detail. Item labels and display values are projected by the server registry. */
export function AssessmentDetail(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId, assessmentId } = useParams<{
    patientId: string;
    assessmentId: string;
  }>();
  const [assessment, setAssessment] = useState<AssessmentDetailView | null>(null);
  const [scaleLabel, setScaleLabel] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId || !assessmentId) {
        setError("The assessment link is incomplete.");
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      const [detailResult, catalog] = await Promise.all([
        client.GET("/api/v1/patients/{patientId}/assessments/{id}", {
          params: { path: { patientId, id: assessmentId } },
        }),
        loadScaleCatalog(client),
      ]);
      if (!active) return;
      if (detailResult.error || !detailResult.data) {
        setError("The assessment detail could not be loaded.");
        setLoading(false);
        return;
      }
      const detail = detailResult.data as AssessmentDetailView;
      setAssessment(detail);
      setScaleLabel(
        catalog.find((entry) => entry.scaleType === detail.scaleType)?.label ?? "Assessment",
      );
      setLoading(false);
    })().catch(() => {
      if (!active) return;
      setError("The assessment detail could not be loaded.");
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [assessmentId, client, patientId]);

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={scaleLabel || "Assessment detail"}
          breadcrumb="Clinical / Assessments / Capture detail"
          actions={
            <Button tone="tertiary" onClick={() => navigate(-1)}>
              Go back
            </Button>
          }
        />
      }
    >
      <main style={pageStyle}>
        {loading ? (
          <div style={stateStyle}>
            <LoadingSpinner />
          </div>
        ) : error || !assessment ? (
          <EmptyState
            title="Assessment unavailable"
            description={error ?? "No assessment was returned."}
          />
        ) : (
          <AssessmentContent assessment={assessment} />
        )}
      </main>
    </DetailPageLayout>
  );
}

function AssessmentContent({ assessment }: { assessment: AssessmentDetailView }): JSX.Element {
  return (
    <div style={contentStyle}>
      <section style={summaryCardStyle}>
        <div style={summaryHeaderStyle}>
          <div>
            <p style={eyebrowStyle}>Recorded score</p>
            <div className="tabular-nums" style={scoreStyle}>
              {assessment.redacted ? "Restricted" : (assessment.score ?? "—")}
            </div>
            {!assessment.redacted && assessment.scoreInterpretation ? (
              <p style={interpretationStyle}>{assessment.scoreInterpretation}</p>
            ) : null}
          </div>
          <StatusPill
            label={assessment.redacted ? "Redacted" : stateLabel(assessment.status)}
            tone={
              assessment.redacted ? "warning" : (ASSESSMENT_TONE[assessment.status] ?? "neutral")
            }
            glyph={assessment.redacted ? "lock" : undefined}
          />
        </div>
        <dl style={metadataGridStyle}>
          <Metadata label="Scale" value={stateLabel(assessment.scaleType)} />
          <Metadata label="Captured" value={formatDateTime(assessment.capturedAt)} />
          <Metadata label="Discipline" value={stateLabel(assessment.capturedByDiscipline)} />
          <Metadata label="Status" value={stateLabel(assessment.status)} />
        </dl>
      </section>

      <section style={responsesCardStyle}>
        <div style={sectionHeaderStyle}>
          <div>
            <p style={eyebrowStyle}>Recorded values</p>
            <h2 style={sectionTitleStyle}>Assessment responses</h2>
          </div>
        </div>

        {assessment.redacted ? (
          <output style={restrictedStyle}>
            <Glyph name="lock" size={18} />
            <div>
              <strong>Responses are restricted</strong>
              <p style={restrictedCopyStyle}>
                The server redacted the item responses for this viewer. No hidden values are
                available on this page.
              </p>
            </div>
          </output>
        ) : assessment.items.length === 0 ? (
          <EmptyState
            title="No item responses available"
            description="This capture does not contain a compatible per-item response payload."
          />
        ) : (
          <dl style={responseListStyle}>
            {assessment.items.map((item) => (
              <div key={item.key} style={responseRowStyle}>
                <dt style={responseLabelStyle}>{item.label}</dt>
                <dd style={responseValueStyle}>{item.displayValue}</dd>
              </div>
            ))}
          </dl>
        )}

        {!assessment.redacted && assessment.notes ? (
          <div style={notesStyle}>
            <h3 style={notesTitleStyle}>Notes</h3>
            <p style={notesCopyStyle}>{assessment.notes}</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Metadata({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt style={metadataLabelStyle}>{label}</dt>
      <dd style={metadataValueStyle}>{value}</dd>
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const pageStyle: CSSProperties = { padding: t.space5 };
const stateStyle: CSSProperties = { minHeight: "16rem", display: "grid", placeItems: "center" };
const contentStyle: CSSProperties = {
  display: "grid",
  gap: t.space4,
  maxWidth: "64rem",
  margin: "0 auto",
};
const summaryCardStyle: CSSProperties = { ...cardSurface, padding: t.space5 };
const summaryHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: t.space4,
};
const eyebrowStyle: CSSProperties = {
  margin: 0,
  color: t.onSurfaceVariant,
  fontSize: "0.75rem",
  fontWeight: 600,
};
const scoreStyle: CSSProperties = { marginTop: t.space1, fontSize: "2rem", fontWeight: 700 };
const interpretationStyle: CSSProperties = { margin: `${t.space1} 0 0`, color: t.onSurfaceVariant };
const metadataGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
  gap: t.space4,
  margin: `${t.space5} 0 0`,
  paddingTop: t.space4,
  borderTop: ghostBorder,
};
const metadataLabelStyle: CSSProperties = { color: t.onSurfaceVariant, fontSize: "0.75rem" };
const metadataValueStyle: CSSProperties = { margin: `${t.space1} 0 0`, fontWeight: 600 };
const responsesCardStyle: CSSProperties = { ...cardSurface, padding: t.space5 };
const sectionHeaderStyle: CSSProperties = { marginBottom: t.space3 };
const sectionTitleStyle: CSSProperties = { margin: `${t.space1} 0 0`, fontSize: "1.25rem" };
const responseListStyle: CSSProperties = { margin: 0 };
const responseRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(12rem, 1fr) minmax(12rem, 1.25fr)",
  gap: t.space4,
  padding: `${t.space3} 0`,
  borderTop: ghostBorder,
};
const responseLabelStyle: CSSProperties = { color: t.onSurfaceVariant };
const responseValueStyle: CSSProperties = { margin: 0, fontWeight: 600 };
const notesStyle: CSSProperties = {
  marginTop: t.space4,
  paddingTop: t.space4,
  borderTop: ghostBorder,
};
const notesTitleStyle: CSSProperties = { margin: 0, fontSize: "0.9rem" };
const notesCopyStyle: CSSProperties = { margin: `${t.space2} 0 0`, whiteSpace: "pre-wrap" };
const restrictedStyle: CSSProperties = {
  display: "flex",
  gap: t.space3,
  padding: t.space4,
  color: t.onSurfaceVariant,
};
const restrictedCopyStyle: CSSProperties = { margin: `${t.space1} 0 0` };
