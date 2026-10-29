import {
  Button,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  TextAreaField,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/13-emar — administration detail (M13 §4.1/§6.1 #11, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_MEDICATIONS_EMAR.md — "Use Detail". Read-only detail of a single
// administration within the retention-class-C audit boundary: the §2.2 lifecycle status, the §2.5 late-entry
// tier, the actor kind (clinician / caregiver-attested), the witness pair for controlled substances, the §2.9
// BCMA match result, and the caregiver-cosign posture.
//
// F-031 — correct / void / acknowledge / dispute are live, each behind a reason the record keeps:
//
//   • CORRECT mints a REPLACEMENT row and supersedes this one. It is not an edit — a medication
//     administration record is append-only, so the superseded row stays readable and this screen links to
//     its successor. That is why the control says "Correct" and never "Edit".
//   • VOID is "recorded in error": nothing replaces the row. Offered only on a committed row, and toned
//     danger, because the two acts are easy to confuse and only one of them leaves a dose on the chart.
//   • ACKNOWLEDGE / DISPUTE are the §2.9 D10 RN case-manager verdict on a caregiver-attested row, so they
//     appear only while `requiresRnReview` is set. The server's `caregiver_attested_review_required`
//     predicate refuses anyone who is not this patient's RN case manager.
//
// The SERVER enforces every scope incl. ABAC (ADR-0030 — out-of-scope rows 404, never 403). Reads
// GET /api/v1/administrations/:id via the typed client.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { stashStepUpDraft, stepUpRedirectFor, takeStepUpDraft } from "../../shell/step-up-redirect";
import {
  type AdministrationView,
  acknowledgeCaregiver,
  correctAdministration,
  disputeCaregiver,
  errorMessage,
  getAdministration,
  voidAdministration,
} from "./emar-api";
import { ADMIN_STATUS_TONE, formatLocalTs, lateEntryTone, stateLabel } from "./emar-status";

const ts = formatLocalTs;

/** The four acts this screen can commit; each needs a reason the record keeps. */
type DetailAct = "correct" | "void" | "acknowledge" | "dispute" | null;

const ACT_COPY: Record<Exclude<DetailAct, null>, { title: string; label: string; hint: string }> = {
  correct: {
    title: "Correct this administration",
    label: "Record correction",
    hint: "A replacement row is created and this one is superseded. Nothing is erased.",
  },
  void: {
    title: "Void this administration",
    label: "Void record",
    hint: "Recorded in error. Nothing replaces this row — use Correct if the dose was given.",
  },
  acknowledge: {
    title: "Acknowledge the caregiver's entry",
    label: "Acknowledge",
    hint: "Accepts the caregiver-attested dose into the record as committed.",
  },
  dispute: {
    title: "Dispute the caregiver's entry",
    label: "Record dispute",
    hint: "Flags the entry for follow-up. The row stays on the chart with your reason.",
  },
};

export function AdministrationDetail(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<AdministrationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const draftKey = `emar-void:${id ?? ""}`;
  // Returning from /step-up: reopen the void dialog with the reason the user had typed.
  const [restored] = useState(() => takeStepUpDraft<{ reason: string }>(draftKey));
  const [act, setAct] = useState<DetailAct>(restored ? "void" : null);
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const { administration, error: err } = await getAdministration(client, id);
    if (err) {
      setError("Could not load the administration.");
      setLoading(false);
      return;
    }
    setRow(administration);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const commit = useCallback(async () => {
    if (!id || !act) return;
    setBusy(true);
    setActionError(null);
    const text = reason.trim();
    const result =
      act === "correct"
        ? await correctAdministration(client, id, { reason: text })
        : act === "void"
          ? await voidAdministration(client, id, { voidReason: text })
          : act === "acknowledge"
            ? await acknowledgeCaregiver(client, id, text ? { note: text } : {})
            : await disputeCaregiver(client, id, { disputeReason: text });
    setBusy(false);
    if (result.error) {
      const stepUp =
        act === "void"
          ? stepUpRedirectFor(result.error, `${location.pathname}${location.search}`)
          : null;
      if (stepUp) {
        stashStepUpDraft(draftKey, { reason: text });
        navigate(stepUp);
        return;
      }
      setActionError(errorMessage(result.error, "The action could not be completed."));
      return;
    }
    // A correction mints a NEW row; following it is the difference between "the correction was recorded"
    // and "here is the record that now stands".
    const next = act === "correct" ? result.administration : null;
    setAct(null);
    setReason("");
    if (next && next.id !== id) {
      navigate(`/patients/${next.patientId}/administrations/${next.id}`);
      return;
    }
    void load();
  }, [act, client, draftKey, id, navigate, location, reason, load]);

  const needsReason = act === "correct" || act === "void" || act === "dispute";
  const commitReady = !busy && (!needsReason || reason.trim().length > 0);

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Administration"
          actions={
            row ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                {row.isControlledSubstance ? (
                  <StatusPill label="Controlled" tone="critical" glyph="alert" />
                ) : null}
                <StatusPill
                  label={stateLabel(row.status)}
                  tone={ADMIN_STATUS_TONE[row.status] ?? "neutral"}
                />
              </span>
            ) : undefined
          }
        >
          {row ? <span style={meta}>{stateLabel(row.mode)}</span> : null}
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : (
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "14rem 1fr",
            gap: "0.4rem 1rem",
            fontSize: "0.85rem",
          }}
        >
          <dt style={dt}>Order</dt>
          <dd style={dd} className="wx-data-md">
            {row.medicationOrderId}
          </dd>
          <dt style={dt}>Mode</dt>
          <dd style={dd}>{stateLabel(row.mode)}</dd>
          <dt style={dt}>Status</dt>
          <dd style={dd}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
              <StatusPill
                label={stateLabel(row.status)}
                tone={ADMIN_STATUS_TONE[row.status] ?? "neutral"}
              />
              {row.requiresRnReview ? (
                <StatusPill label="Awaiting RN review" tone="warning" />
              ) : null}
            </span>
          </dd>
          <dt style={dt}>Actor</dt>
          <dd style={dd}>{stateLabel(row.actorKind)}</dd>
          <dt style={dt}>Administered</dt>
          <dd style={dd} className="tabular-nums">
            {ts(row.administeredAt)}
          </dd>
          <dt style={dt}>Recorded</dt>
          <dd style={dd} className="tabular-nums">
            {ts(row.recordedAt)}
          </dd>
          <dt style={dt}>Late-entry tier</dt>
          <dd style={dd}>
            <StatusPill
              label={stateLabel(row.lateEntryTier)}
              tone={lateEntryTone(row.lateEntryTier)}
            />
          </dd>
          <dt style={dt}>Controlled</dt>
          <dd style={dd}>
            {/* §10 — controlled-substance gold `critical` tone. */}
            {row.isControlledSubstance ? (
              <StatusPill label="Controlled" tone="critical" glyph="alert" />
            ) : (
              <span style={{ color: "var(--color-muted)" }}>No</span>
            )}
          </dd>
          <dt style={dt}>Administering clinician</dt>
          <dd style={dd} className="wx-data-md">
            {row.administeringClinicianMembershipId ?? "—"}
          </dd>
          <dt style={dt}>Witness</dt>
          <dd style={dd} className="wx-data-md">
            {row.witnessMembershipId ?? "—"}
          </dd>
          <dt style={dt}>BCMA match</dt>
          <dd style={dd}>{row.barcodeMatchResult ? stateLabel(row.barcodeMatchResult) : "—"}</dd>
          <dt style={dt}>Comfort-kit drawdown</dt>
          <dd style={dd} className="wx-data-md">
            {row.isComfortKitDrawdown ? (row.comfortKitDeploymentId ?? "yes") : "—"}
          </dd>
          <dt style={dt}>IV session</dt>
          <dd style={dd} className="wx-data-md">
            {row.ivSessionId ?? "—"}
          </dd>
          <dt style={dt}>Encounter</dt>
          <dd style={dd} className="wx-data-md">
            {row.encounterId ?? "—"}
          </dd>
          <dt style={dt}>Superseded by</dt>
          <dd style={dd} className="wx-data-md">
            {row.supersededById ? (
              <button
                type="button"
                style={linkBtn}
                onClick={() =>
                  navigate(`/patients/${row.patientId}/administrations/${row.supersededById}`)
                }
              >
                {row.supersededById}
              </button>
            ) : (
              "—"
            )}
          </dd>
        </dl>
      )}

      {row ? (
        <section style={{ marginTop: "1.5rem", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {row.status === "committed" ? (
            <>
              <Button tone="secondary" onClick={() => setAct("correct")}>
                Correct
              </Button>
              <Button tone="danger" onClick={() => setAct("void")}>
                Void
              </Button>
            </>
          ) : null}
          {row.requiresRnReview ? (
            <>
              <Button tone="primary" onClick={() => setAct("acknowledge")}>
                Acknowledge
              </Button>
              <Button tone="secondary" onClick={() => setAct("dispute")}>
                Dispute
              </Button>
            </>
          ) : null}
        </section>
      ) : null}

      <Modal
        open={act !== null}
        onClose={busy ? undefined : () => setAct(null)}
        ariaLabel={act ? ACT_COPY[act].title : "Administration action"}
        width="30rem"
      >
        {act ? (
          <div
            style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}
          >
            <h2 style={modalTitle}>{ACT_COPY[act].title}</h2>
            <p style={meta}>{ACT_COPY[act].hint}</p>
            <TextAreaField
              label={act === "acknowledge" ? "Note (optional)" : "Reason"}
              required={needsReason}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {actionError ? (
              <p role="alert" style={{ ...meta, color: "var(--color-error)" }}>
                {actionError}
              </p>
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <Button tone="secondary" disabled={busy} onClick={() => setAct(null)}>
                Cancel
              </Button>
              <Button
                tone={act === "void" ? "danger" : "primary"}
                disabled={!commitReady}
                loading={busy}
                onClick={() => void commit()}
              >
                {ACT_COPY[act].label}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </DetailPageLayout>
  );
}

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
const dt = { fontWeight: 600, color: "var(--color-on-surface)" } as const;
const dd = { margin: 0 } as const;
const modalTitle: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontWeight: 500,
  fontSize: "1.25rem",
  color: "var(--color-on-surface)",
};
const linkBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  color: "var(--color-primary)",
  cursor: "pointer",
  font: "inherit",
  textDecoration: "underline",
};
