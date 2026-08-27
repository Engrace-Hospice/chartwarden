import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  TextField,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/13-emar — administration policy admin (M13 §4.1/§6.1 #12, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (administration-policy admin).
// Tenant configuration for org_admin / compliance_officer: the grace window, the PRN minimum-interval
// default, and the eMAR-PDF-on-commit toggle. F-031 — the tighten-only PUT is live. Nothing here decides
// what "tighten" means: the SERVER holds the platform floors, so a loosened value is REFUSED there and the
// refusal is shown, rather than the form greying out a range it would have to guess at. Step-up is likewise
// the server's (§4.1 route 28). Reads GET /api/v1/admin/administration-policy via the typed client.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { type AdministrationPolicyView, errorMessage, getPolicy, putPolicy } from "./emar-api";

export function AdministrationPolicy(): JSX.Element {
  const client = useApiClient();
  const [policy, setPolicy] = useState<AdministrationPolicyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [grace, setGrace] = useState("");
  const [prn, setPrn] = useState("");
  const [pdf, setPdf] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { policy: next, error: err } = await getPolicy(client);
    if (err) {
      setError("Could not load the administration policy.");
      setLoading(false);
      return;
    }
    setPolicy(next);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = useCallback(() => {
    if (!policy) return;
    setGrace(String(policy.graceWindowMinutes));
    setPrn(String(policy.prnMinimumIntervalMinutes));
    setPdf(policy.emarPdfOnCommit);
    setActionError(null);
    setEditing(true);
  }, [policy]);

  const save = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    const { error: err } = await putPolicy(client, {
      graceWindowMinutes: Number(grace),
      prnMinimumIntervalMinutes: Number(prn),
      emarPdfOnCommit: pdf,
    });
    setBusy(false);
    if (err) {
      setActionError(errorMessage(err, "The policy could not be updated."));
      return;
    }
    setEditing(false);
    void load();
  }, [client, grace, prn, pdf, load]);

  const savable =
    !busy &&
    Number.isInteger(Number(grace)) &&
    Number(grace) >= 0 &&
    Number.isInteger(Number(prn)) &&
    Number(prn) >= 0;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Administration Policy"
          breadcrumb="Admin / Medications"
          actions={
            <span style={{ display: "inline-flex", gap: "0.5rem" }}>
              <Button type="button" tone="secondary" onClick={() => void load()} disabled={loading}>
                {loading ? "Refreshing..." : "Refresh"}
              </Button>
              <Button type="button" tone="primary" onClick={openEditor} disabled={!policy}>
                Edit policy
              </Button>
            </span>
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

            <PolicyEditor
              open={editing}
              grace={grace}
              prn={prn}
              pdf={pdf}
              busy={busy}
              savable={savable}
              error={actionError}
              onGrace={setGrace}
              onPrn={setPrn}
              onPdf={setPdf}
              onSave={() => void save()}
              onCancel={() => setEditing(false)}
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

/** The tighten-only editor. Every bound is the SERVER's — this form validates only that the numbers ARE
 *  numbers, so a rejected value comes back as the platform floor that refused it, not as a guess. */
function PolicyEditor({
  open,
  grace,
  prn,
  pdf,
  busy,
  savable,
  error,
  onGrace,
  onPrn,
  onPdf,
  onSave,
  onCancel,
}: {
  open: boolean;
  grace: string;
  prn: string;
  pdf: boolean;
  busy: boolean;
  savable: boolean;
  error: string | null;
  onGrace: (v: string) => void;
  onPrn: (v: string) => void;
  onPdf: (v: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onCancel}
      ariaLabel="Edit administration policy"
      width="30rem"
    >
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        <h2 style={editorTitleStyle}>Edit administration policy</h2>
        <p style={editorMetaStyle}>
          Tighten-only. The server holds the platform floors and refuses a value that loosens one.
        </p>
        <TextField
          label="Grace window (minutes)"
          inputMode="numeric"
          value={grace}
          onChange={(e) => onGrace(e.target.value)}
        />
        <TextField
          label="PRN minimum interval (minutes)"
          inputMode="numeric"
          value={prn}
          onChange={(e) => onPrn(e.target.value)}
        />
        <label style={checkRowStyle}>
          <input type="checkbox" checked={pdf} onChange={(e) => onPdf(e.target.checked)} />
          <span>Render an eMAR PDF when an administration commits</span>
        </label>
        {error ? (
          <p role="alert" style={{ ...editorMetaStyle, color: "var(--color-error)" }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <Button tone="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button tone="primary" disabled={!savable} loading={busy} onClick={onSave}>
            Save policy
          </Button>
        </div>
      </div>
    </Modal>
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

const editorTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontWeight: 500,
  fontSize: "1.25rem",
  color: "var(--color-on-surface)",
};

const editorMetaStyle: CSSProperties = {
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
  margin: 0,
};

const checkRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.82rem",
  color: "var(--color-on-surface)",
};
