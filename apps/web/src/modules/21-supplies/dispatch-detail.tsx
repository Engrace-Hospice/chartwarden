// apps/web/src/modules/21-supplies — S21.4 COMFORT-KIT DISPATCH DETAIL (`/supplies/dispatches/:id`, §5.5,
// Track B / ADR-0030). Spec: docs/design/screens/clinical — "Use Record Detail."
//
// The dispatched kit, its per-line DEA 21 CFR §1304 outbound manifest, and the two edges §4.1 publishes:
// "mark deployed at patient" and "initiate return".
//
// THE DISPATCH STATUS IS NOT THE REQUEST STATUS, and the screen keeps them apart. The parent supply request
// goes terminal (`completed`) at deployment while the dispatch stays live for the whole return +
// reconciliation tail — reading one as the other is how a kit gets treated as closed with morphine still in
// a patient's home.
//
// §5.5's "chain-of-custody timeline" is reconstructed from the dispatch's OWN stamps. The lot-level custody
// chain — every dispense, drawdown, return and disposal against each lot — is the PERPETUAL LOG, which has
// its own permission key (`comfort_kit.perpetual_log.read`) and its own screen: a supply coordinator who may
// dispatch must not thereby acquire the ledger a diversion investigation reads.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type DispatchDetail as Dispatch,
  createReturn,
  deployAtPatient,
  errorMessage,
  getDispatch,
} from "./supplies-api";
import {
  DISPATCH_STATUS_TONE,
  dateTime,
  deploymentSiteLabel,
  humanize,
  shortDate,
  shortId,
  toneOf,
} from "./supplies-status";
import {
  Card,
  Field,
  Modal,
  Notice,
  SchedulePill,
  SummaryGrid,
  TextAreaField,
  TextField,
  Timeline,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdQty,
  th,
  thNum,
} from "./supplies-ui";

type Ceremony = "deploy" | "return" | null;

function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toInstant(local: string): string {
  const ms = Date.parse(local);
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

export function ComfortKitDispatchDetail(): JSX.Element {
  const client = useApiClient();
  const { dispatchId } = useParams<{ dispatchId: string }>();
  const [dispatch, setDispatch] = useState<Dispatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [when, setWhen] = useState(nowLocalInput);
  const [returnReason, setReturnReason] = useState("");

  const load = useCallback(async () => {
    if (!dispatchId) return;
    setLoading(true);
    setError(null);
    const { dispatch: d, error: err } = await getDispatch(client, dispatchId);
    if (err) {
      setError(errorMessage(err, "This comfort-kit dispatch could not be loaded."));
      setLoading(false);
      return;
    }
    setDispatch(d);
    setLoading(false);
  }, [client, dispatchId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!dispatch || !dispatchId)
    return (
      <EmptyState
        title="Not found"
        description="This comfort-kit dispatch does not exist, or is outside your organization."
      />
    );

  const canDeploy = dispatch.dispatchStatus === "dispatched";
  const canReturn = ["deployed_at_patient", "partially_returned"].includes(dispatch.dispatchStatus);
  const controlled = dispatch.contents.filter((c) => c.isControlledSubstance);

  const close = () => {
    setCeremony(null);
    setActionError(null);
  };

  const timeline = [
    {
      label: "Dispatched from " + humanize(dispatch.dispatchSource),
      at: dateTime(dispatch.dispatchedAt),
      by: shortId(dispatch.dispatchedByMembershipId),
    },
    dispatch.deployedAtPatientAt
      ? {
          label: "Deployed at patient",
          at: dateTime(dispatch.deployedAtPatientAt),
          by: shortId(dispatch.deployedByMembershipId),
        }
      : null,
  ].filter((e): e is { label: string; at: string; by: string } => e !== null);

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Comfort kit {dispatch.kitSerialNumber}</span>}
        breadcrumb="Supplies — comfort-kit dispatch"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to={`/supplies/requests/${dispatch.supplyRequestId}`} style={ghostButtonStyle}>
              Supply request
            </Link>
            <Link to={`/supplies/dispatches/${dispatchId}/perpetual-log`} style={ghostButtonStyle}>
              DEA perpetual log
            </Link>
          </div>
        }
      />

      {dispatch.dispatchStatus === "reconciled_with_discrepancy" ? (
        <Notice tone="error" assertive>
          This kit closed with an unexplained controlled-substance shortfall. The M30 survey
          investigation and the M36 high-severity alert were raised automatically; only closing that
          investigation marks the discrepancy explained — nothing on this screen can.
        </Notice>
      ) : null}

      {dispatch.m13DeploymentId === null && dispatch.deployedAtPatientAt !== null ? (
        <Notice tone="warning">
          The eMAR (M13) deployment acknowledgment has not arrived yet. A return cannot be opened
          until it does: `comfort_kit_return.m13_deployment_id` is NOT NULL because M13 closes its
          drawdowns against it, and a return with nothing to close is a count nobody can reconcile.
        </Notice>
      ) : null}

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      <Card
        title="Dispatch"
        actions={
          <StatusPill
            label={humanize(dispatch.dispatchStatus)}
            tone={toneOf(DISPATCH_STATUS_TONE, dispatch.dispatchStatus)}
          />
        }
      >
        <SummaryGrid>
          <Field label="Patient" value={shortId(dispatch.patientId)} mono />
          <Field label="Admission" value={shortId(dispatch.admissionId)} mono />
          <Field label="Deployment site" value={deploymentSiteLabel(dispatch.deploymentSite)} />
          {dispatch.ipuRoomId ? (
            <Field label="IPU room" value={shortId(dispatch.ipuRoomId)} mono />
          ) : null}
          <Field label="Location" value={shortId(dispatch.locationId)} mono />
          <Field label="Dispatch source" value={humanize(dispatch.dispatchSource)} />
          <Field label="Pharmacy dispatch mode" value={humanize(dispatch.pharmacyDispatchMode)} />
          <Field label="Pharmacy partner" value={shortId(dispatch.pharmacyPartnerId)} mono />
          <Field label="Dispatched" value={dateTime(dispatch.dispatchedAt)} />
          <Field label="Deployed at patient" value={dateTime(dispatch.deployedAtPatientAt)} />
          <Field label="M13 deployment" value={shortId(dispatch.m13DeploymentId)} mono />
          <Field label="Bill of lading (M22)" value={shortId(dispatch.bolDocumentId)} mono />
          <Field
            label="Handling policy digest"
            value={shortId(dispatch.controlledSubstanceHandlingPolicyDigest)}
            mono
          />
          <Field label="Version stamp" value={dateTime(dispatch.updatedAt)} />
        </SummaryGrid>
        {dispatch.specialHandlingNotes ? (
          <div>
            <span style={mutedStyle}>
              Special handling notes (D13 — audit-denylisted free text)
            </span>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: t.onSurface }}>
              {dispatch.specialHandlingNotes}
            </p>
          </div>
        ) : null}
      </Card>

      <Card
        title="Contents"
        actions={
          controlled.length > 0 ? (
            <StatusPill label={`${controlled.length} controlled line(s)`} tone="warning" />
          ) : (
            <StatusPill label="No controlled substances" tone="neutral" />
          )
        }
      >
        <span style={mutedStyle}>
          What physically left the hub. These quantities are the DEA outbound record — every return
          count is subtracted from them, and they are never edited: a correction is a new
          reconciliation row.
        </span>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Medication</th>
              <th style={th}>Schedule</th>
              <th style={thNum}>Dispatched</th>
              <th style={th}>Lot</th>
              <th style={th}>Expires</th>
              <th style={th}>Prescription</th>
            </tr>
          </thead>
          <tbody>
            {dispatch.contents.map((c) => (
              <tr key={c.dispatchedContentId} style={rowLine}>
                <td style={td}>
                  {c.drugName}
                  <div style={mutedStyle}>
                    {c.strength} · {c.dosageForm} · {c.routeOfAdministration}
                  </div>
                </td>
                <td style={td}>
                  <SchedulePill
                    schedule={c.controlledSubstanceSchedule}
                    isControlled={c.isControlledSubstance}
                  />
                </td>
                <td style={tdQty}>
                  {c.dispatchedQuantity} {c.dispatchedUnit}
                </td>
                <td style={{ ...td, fontFamily: t.fontMono }}>{c.lotNumber ?? "—"}</td>
                <td style={td}>{shortDate(c.expirationDate)}</td>
                <td style={{ ...td, fontFamily: t.fontMono }}>
                  {/* Null on an IPU stock kit, which has no per-patient prescription behind it. */}
                  {c.medicationOrderId ? shortId(c.medicationOrderId) : "stock kit"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Chain of custody">
        <span style={mutedStyle}>
          The dispatch's own custody stamps. The per-lot ledger is the DEA perpetual log, behind its
          own permission.
        </span>
        <Timeline entries={timeline} />
      </Card>

      <Card title="Actions">
        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
          <button
            type="button"
            disabled={!canDeploy}
            title={canDeploy ? undefined : "Only a kit still marked dispatched can be deployed."}
            aria-disabled={!canDeploy}
            style={canDeploy ? ghostButtonStyle : disabledButtonStyle}
            onClick={canDeploy ? () => setCeremony("deploy") : undefined}
          >
            Mark deployed at patient
          </button>
          <button
            type="button"
            disabled={!canReturn}
            title={
              canReturn
                ? undefined
                : "A return opens once the kit is at the patient, and only while something is still out."
            }
            aria-disabled={!canReturn}
            style={canReturn ? ghostButtonStyle : disabledButtonStyle}
            onClick={canReturn ? () => setCeremony("return") : undefined}
          >
            Initiate return
          </button>
        </div>
        <span style={mutedStyle}>
          Reconciliation is not an action here. The physical count, its witness and the disposal
          record live on the return record, which is a different authority from dispatching.
        </span>
      </Card>

      {ceremony === "deploy" ? (
        <Modal
          title="Mark deployed at patient"
          onClose={close}
          footer={
            <button
              type="button"
              disabled={busy}
              style={busy ? disabledButtonStyle : primaryButtonStyle}
              onClick={async () => {
                setBusy(true);
                setActionError(null);
                const { error: err } = await deployAtPatient(
                  client,
                  dispatchId,
                  dispatch.updatedAt,
                  {
                    deployedAt: toInstant(when),
                  },
                );
                setBusy(false);
                if (err) {
                  setActionError(errorMessage(err, "The deployment could not be recorded."));
                  return;
                }
                close();
                void load();
              }}
            >
              Mark deployed
            </button>
          }
        >
          <Notice tone="info">
            This is the event the eMAR builds its bedside deployment from — the emitted payload
            carries the whole manifest, so M13 never has to read back into this module.
          </Notice>
          <TextField label="Deployed at" value={when} onChange={setWhen} type="datetime-local" />
        </Modal>
      ) : null}

      {ceremony === "return" ? (
        <Modal
          title="Open the return obligation"
          onClose={close}
          footer={
            <button
              type="button"
              disabled={busy || returnReason.trim() === ""}
              style={busy || returnReason.trim() === "" ? disabledButtonStyle : primaryButtonStyle}
              onClick={async () => {
                setBusy(true);
                setActionError(null);
                const { error: err } = await createReturn(client, {
                  dispatchId,
                  returnReason: returnReason.trim(),
                });
                setBusy(false);
                if (err) {
                  setActionError(errorMessage(err, "The return could not be opened."));
                  return;
                }
                close();
                void load();
              }}
            >
              Open return
            </button>
          }
        >
          <Notice tone="info">
            The return row is created when the OBLIGATION arises, long before anything is physically
            returned. The due date is the 30-day compliance boundary; reconciliation is its terminal
            state.
          </Notice>
          <TextAreaField
            label="Return reason"
            value={returnReason}
            onChange={setReturnReason}
            rows={3}
          />
        </Modal>
      ) : null}
    </div>
  );
}
