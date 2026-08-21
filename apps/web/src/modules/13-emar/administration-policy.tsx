import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/13-emar — administration policy admin (M13 §4.1/§6.1 #12, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (administration-policy admin).
// Read-only tenant configuration for org_admin / compliance_officer: the grace window, the PRN minimum-interval
// default, and the eMAR-PDF-on-commit toggle. The tighten-only PUT write action (step-up enforced server-side)
// fills in as its write surface hardens; the SERVER owns the platform floors and the §2.5 grace-window policy
// (ADR-0030). Reads GET /api/v1/admin/administration-policy via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

interface AdministrationPolicyView {
  graceWindowMinutes: number;
  prnMinimumIntervalMinutes: number;
  emarPdfOnCommit: boolean;
}

export function AdministrationPolicy(): JSX.Element {
  const client = useApiClient();
  const [policy, setPolicy] = useState<AdministrationPolicyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/admin/administration-policy", {});
    if (err) {
      setError("Could not load the administration policy.");
      setLoading(false);
      return;
    }
    setPolicy(data as AdministrationPolicyView);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Administration Policy"
          breadcrumb="Admin / Medications"
          actions={
            <Button type="button" tone="secondary" onClick={() => void load()} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review administration timing, PRN interval defaults, and eMAR PDF generation behavior.
          </div>
        </PageHeader>
      }
      table={
        error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading || !policy ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : (
          <div style={pageContentStyle}>
            <PolicySection
              icon="clock"
              title="Scheduling & Late Entry"
              subtitle="Tenant defaults for medication administration timing"
              statusLabel="Tighten-only"
            >
              <div style={factsGridStyle}>
                <Fact
                  label="Grace window"
                  value={`${policy.graceWindowMinutes} min`}
                  detail="Late-entry tolerance"
                />
                <Fact
                  label="PRN minimum interval"
                  value={`${policy.prnMinimumIntervalMinutes} min`}
                  detail="Default repeat-dose floor"
                />
              </div>
            </PolicySection>

            <PolicySection
              icon="file-text"
              title="eMAR Commit Output"
              subtitle="Document generation behavior when a medication record is committed"
              statusLabel={policy.emarPdfOnCommit ? "Enabled" : "Disabled"}
            >
              <div style={factsGridStyle}>
                <div style={factStyle}>
                  <div style={factLabelStyle}>eMAR PDF on commit</div>
                  <div style={{ marginTop: "0.35rem" }}>
                    <StatusPill
                      label={policy.emarPdfOnCommit ? "Enabled" : "Disabled"}
                      tone={policy.emarPdfOnCommit ? "success" : "neutral"}
                    />
                  </div>
                  <div style={factDetailStyle}>Server-owned commit artifact policy</div>
                </div>
              </div>
            </PolicySection>
          </div>
        )
      }
      fullPageScroll
    />
  );
}

function PolicySection({
  icon,
  title,
  subtitle,
  statusLabel,
  children,
}: {
  icon: "clock" | "file-text";
  title: string;
  subtitle: string;
  statusLabel: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.875rem", minWidth: 0 }}>
          <div style={sectionIconStyle}>
            <Glyph name={icon} size={18} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h2 style={sectionTitleStyle}>{title}</h2>
            <div style={sectionSubtitleStyle}>{subtitle}</div>
          </div>
        </div>
        <StatusPill label={statusLabel} tone="progress" />
      </div>
      <div style={{ marginTop: "1rem" }}>{children}</div>
    </section>
  );
}

function Fact({
  label,
  value,
  detail,
}: { label: string; value: string; detail: string }): JSX.Element {
  return (
    <div style={factStyle}>
      <div style={factLabelStyle}>{label}</div>
      <div className="tabular-nums" style={factValueStyle}>
        {value}
      </div>
      <div style={factDetailStyle}>{detail}</div>
    </div>
  );
}

const pageContentStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))",
  gap: "1rem",
  padding: "0 1.5rem 1.5rem",
  maxWidth: "70rem",
};

const sectionStyle = {
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
};

const sectionHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
};

const sectionIconStyle = {
  width: "2.75rem",
  height: "2.75rem",
  borderRadius: "9999px",
  background: "var(--color-primary-tint)",
  color: "var(--color-primary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const sectionTitleStyle = {
  margin: 0,
  fontSize: "1rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const sectionSubtitleStyle = {
  marginTop: "0.2rem",
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
};

const factsGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
  gap: "0.75rem",
};

const factStyle = {
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
};

const factLabelStyle = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};

const factValueStyle = {
  marginTop: "0.35rem",
  fontSize: "1.25rem",
  fontWeight: 700,
  color: "var(--color-on-surface)",
};

const factDetailStyle = {
  marginTop: "0.25rem",
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
