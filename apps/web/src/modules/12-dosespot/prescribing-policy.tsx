import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/12-dosespot — prescribing policy admin (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (refill SLA & controlled-
// substance policy admin). Two read-only tenant-config panes for org_admin / compliance_officer: the refill-
// inbox SLA (warn/critical hours, with the platform floors the tenant config may only TIGHTEN beyond, §2.7 D9)
// and the controlled-substance policy (schedule-II / III–V refill caps per 21 CFR 1306.22 + the EPCS
// certification status gate, D18). The tighten-only PATCH write actions fill in as their write surfaces harden;
// the SERVER enforces the platform floors. Reads GET /api/v1/admin/refill-inbox-policy and
// GET /api/v1/admin/controlled-substance-policy via the typed client. Leaves only (@chartwarden/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { EPCS_TONE, stateLabel } from "./medication-status";

interface RefillPolicyView {
  slaWarnHours: number;
  slaCriticalHours: number;
  platformFloorWarnHours: number;
  platformFloorCriticalHours: number;
}

interface ControlledPolicyView {
  scheduleIiMaxRefills: number;
  scheduleIiiToVMaxRefills: number;
  epcsCertificationStatus: string;
}

export function PrescribingPolicy(): JSX.Element {
  const client = useApiClient();
  const [refill, setRefill] = useState<RefillPolicyView | null>(null);
  const [controlled, setControlled] = useState<ControlledPolicyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [r, c] = await Promise.all([
      client.GET("/api/v1/admin/refill-inbox-policy", {}),
      client.GET("/api/v1/admin/controlled-substance-policy", {}),
    ]);
    if (r.error || c.error) {
      setError("Could not load the prescribing policy.");
      setLoading(false);
      return;
    }
    setRefill(r.data as RefillPolicyView);
    setControlled(c.data as ControlledPolicyView);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Prescribing Policy"
          actions={
            <Button type="button" tone="secondary" onClick={() => void load()} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review refill queue escalation windows and controlled-substance prescribing limits for
            this tenant.
          </div>
        </PageHeader>
      }
      table={
        error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading || !refill || !controlled ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : (
          <div style={pageContentStyle}>
            <PolicySection
              icon="clock"
              title="Refill Inbox SLA"
              subtitle="Escalation windows for refill requests"
              statusLabel="Tighten-only"
              statusTone="progress"
            >
              <div style={factsGridStyle}>
                <Fact
                  label="Warn after"
                  value={`${refill.slaWarnHours}h`}
                  detail={`Platform floor ${refill.platformFloorWarnHours}h`}
                />
                <Fact
                  label="Critical after"
                  value={`${refill.slaCriticalHours}h`}
                  detail={`Platform floor ${refill.platformFloorCriticalHours}h`}
                />
              </div>
            </PolicySection>

            <PolicySection
              icon="shield"
              title="Controlled-Substance Policy"
              subtitle="Refill caps and EPCS certification gate"
              statusLabel={stateLabel(controlled.epcsCertificationStatus)}
              statusTone={EPCS_TONE[controlled.epcsCertificationStatus] ?? "neutral"}
            >
              <div style={factsGridStyle}>
                <Fact
                  label="Schedule II max refills"
                  value={String(controlled.scheduleIiMaxRefills)}
                  detail="Hard regulatory cap"
                />
                <Fact
                  label="Schedule III-V max refills"
                  value={String(controlled.scheduleIiiToVMaxRefills)}
                  detail="21 CFR 1306.22"
                />
                <div style={factStyle}>
                  <div style={factLabelStyle}>EPCS certification</div>
                  <div style={{ marginTop: "0.35rem" }}>
                    <StatusPill
                      label={stateLabel(controlled.epcsCertificationStatus)}
                      tone={EPCS_TONE[controlled.epcsCertificationStatus] ?? "neutral"}
                    />
                  </div>
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
  statusTone,
  children,
}: {
  icon: "clock" | "shield";
  title: string;
  subtitle: string;
  statusLabel: string;
  statusTone: StatusTone;
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
        <StatusPill label={statusLabel} tone={statusTone} />
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
  fontSize: "0.72rem",
  color: "var(--color-on-surface-variant)",
};

const factValueStyle = {
  marginTop: "0.25rem",
  fontSize: "1.15rem",
  fontWeight: 700,
  color: "var(--color-on-surface)",
};

const factDetailStyle = {
  marginTop: "0.2rem",
  fontSize: "0.78rem",
  color: "var(--color-on-surface-variant)",
};
