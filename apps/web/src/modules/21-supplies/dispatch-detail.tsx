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
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  Panel,
  StatusPill,
  nowLocalInput,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { FormDrawer } from "../../shell/form-drawer";
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
  Field,
  Notice,
  SchedulePill,
  SummaryGrid,
  TextAreaField,
  TextField,
  Timeline,
  ghostButtonStyle,
  pageTitleStyle,
  tdQty,
  thNum,
} from "./supplies-ui";
import { useWrite } from "./use-write";

type Ceremony = "deploy" | "return" | null;

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
  const { busy, run: runWrite } = useWrite();
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

  /** Open a step. The deployment time is a custody timestamp, so it starts at the moment the drawer is opened,
   *  never at page load or at a time edited in an earlier open. */
  const openCeremony = (next: Exclude<Ceremony, null>) => {
    setWhen(nowLocalInput());
    setActionError(null);
    setCeremony(next);
  };

  /** Run a write, then reload. A refusal (or a rejected request) stays in the drawer, beside Save. */
  const run = async (fn: () => Promise<{ error: unknown }>, failure: string) => {
    setActionError(null);
    const failed = await runWrite(fn, failure);
    if (failed) {
      setActionError(failed);
      return;
    }
    close();
    void load();
  };

  const timeline = [
    {
      label: `Dispatched from ${humanize(dispatch.dispatchSource)}`,
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
    <div
      className={`wx-list-drawer${ceremony === "deploy" || ceremony === "return" ? " has-drawer" : ""}`}
    >
      <div className="wx-list-drawer-main wx-kit-column">
        <PageHeader
          title={<span style={pageTitleStyle}>Comfort kit {dispatch.kitSerialNumber}</span>}
          actions={
            <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
              <Link to={`/supplies/requests/${dispatch.supplyRequestId}`} style={ghostButtonStyle}>
                Supply request
              </Link>
              <Link
                to={`/supplies/dispatches/${dispatchId}/perpetual-log`}
                style={ghostButtonStyle}
              >
                DEA perpetual log
              </Link>
            </div>
          }
        />

        {dispatch.dispatchStatus === "reconciled_with_discrepancy" ? (
          <Notice tone="error" assertive>
            This kit closed with an unexplained controlled-substance shortfall. The M30 survey
            investigation and the M36 high-severity alert were raised automatically; only closing
            that investigation marks the discrepancy explained — nothing on this screen can.
          </Notice>
        ) : null}

        {dispatch.m13DeploymentId === null && dispatch.deployedAtPatientAt !== null ? (
          <Notice tone="warning">
            The eMAR (M13) deployment acknowledgment has not arrived yet. A return cannot be opened
            until it does: `comfort_kit_return.m13_deployment_id` is NOT NULL because M13 closes its
            drawdowns against it, and a return with nothing to close is a count nobody can
            reconcile.
          </Notice>
        ) : null}

        <Panel
          stack
          headingLevel={3}
          title="Dispatch"
          action={
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
              <span className="wx-text-muted">
                Special handling notes (D13 — audit-denylisted free text)
              </span>
              <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: t.onSurface }}>
                {dispatch.specialHandlingNotes}
              </p>
            </div>
          ) : null}
        </Panel>

        <Panel
          stack
          headingLevel={3}
          title="Contents"
          action={
            controlled.length > 0 ? (
              <StatusPill label={`${controlled.length} controlled line(s)`} tone="warning" />
            ) : (
              <StatusPill label="No controlled substances" tone="neutral" />
            )
          }
        >
          <span className="wx-text-muted">
            What physically left the hub. These quantities are the DEA outbound record — every
            return count is subtracted from them, and they are never edited: a correction is a new
            reconciliation row.
          </span>
          <table>
            <thead>
              <tr>
                <th>Medication</th>
                <th>Schedule</th>
                <th style={thNum}>Dispatched</th>
                <th>Lot</th>
                <th>Expires</th>
                <th>Prescription</th>
              </tr>
            </thead>
            <tbody>
              {dispatch.contents.map((c) => (
                <tr key={c.dispatchedContentId}>
                  <td>
                    {c.drugName}
                    <div className="wx-text-muted">
                      {c.strength} · {c.dosageForm} · {c.routeOfAdministration}
                    </div>
                  </td>
                  <td>
                    <SchedulePill
                      schedule={c.controlledSubstanceSchedule}
                      isControlled={c.isControlledSubstance}
                    />
                  </td>
                  <td style={tdQty}>
                    {c.dispatchedQuantity} {c.dispatchedUnit}
                  </td>
                  <td className="wx-data-md">{c.lotNumber ?? "—"}</td>
                  <td>{shortDate(c.expirationDate)}</td>
                  <td className="wx-data-md">
                    {/* Null on an IPU stock kit, which has no per-patient prescription behind it. */}
                    {c.medicationOrderId ? shortId(c.medicationOrderId) : "stock kit"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel stack headingLevel={3} title="Chain of custody">
          <span className="wx-text-muted">
            The dispatch's own custody stamps. The per-lot ledger is the DEA perpetual log, behind
            its own permission.
          </span>
          <Timeline entries={timeline} />
        </Panel>

        <Panel stack headingLevel={3} title="Actions">
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Button
              tone="secondary"
              type="button"
              disabled={!canDeploy}
              title={canDeploy ? undefined : "Only a kit still marked dispatched can be deployed."}
              aria-disabled={!canDeploy}
              onClick={canDeploy ? () => openCeremony("deploy") : undefined}
            >
              Mark deployed at patient
            </Button>
            <Button
              tone="secondary"
              type="button"
              disabled={!canReturn}
              title={
                canReturn
                  ? undefined
                  : "A return opens once the kit is at the patient, and only while something is still out."
              }
              aria-disabled={!canReturn}
              onClick={canReturn ? () => openCeremony("return") : undefined}
            >
              Initiate return
            </Button>
          </div>
          <span className="wx-text-muted">
            Reconciliation is not an action here. The physical count, its witness and the disposal
            record live on the return record, which is a different authority from dispatching.
          </span>
        </Panel>
      </div>

      {ceremony === "deploy" ? (
        <FormDrawer
          title="Mark deployed at patient"
          busy={busy}
          error={actionError}
          onClose={close}
          save={
            <Button
              tone="primary"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    deployAtPatient(client, dispatchId, dispatch.updatedAt, {
                      deployedAt: toInstant(when),
                    }),
                  "The deployment could not be recorded.",
                )
              }
            >
              Mark deployed
            </Button>
          }
        >
          <Notice tone="info">
            This is the event the eMAR builds its bedside deployment from — the emitted payload
            carries the whole manifest, so M13 never has to read back into this module.
          </Notice>
          <TextField label="Deployed at" value={when} onChange={setWhen} type="datetime-local" />
        </FormDrawer>
      ) : null}
      {ceremony === "return" ? (
        <FormDrawer
          title="Open the return obligation"
          busy={busy}
          error={actionError}
          onClose={close}
          save={
            <Button
              tone="primary"
              type="button"
              disabled={busy || returnReason.trim() === ""}
              onClick={() =>
                void run(
                  () => createReturn(client, { dispatchId, returnReason: returnReason.trim() }),
                  "The return could not be opened.",
                )
              }
            >
              Open return
            </Button>
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
        </FormDrawer>
      ) : null}
    </div>
  );
}
