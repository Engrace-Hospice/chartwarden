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
  useReloadFocus,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { FormModal } from "../../shell/form-modal";
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
  columnStyle,
  ghostButtonStyle,
  pageTitleStyle,
  tdQty,
  thNum,
} from "./supplies-ui";
import { useLatestRead } from "./use-latest-read";
import { useWrite } from "./use-write";

type Ceremony = "deploy" | "return" | null;

const LOAD_FAILURE = "This comfort-kit dispatch could not be loaded.";

function toInstant(local: string): string {
  const ms = Date.parse(local);
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

/** The route's screen. Keyed by the dispatch, so moving to another dispatch (Back / Forward) starts a fresh screen: the
 *  open step, its typed fields and its stamp never follow the responder onto another record. */
export function ComfortKitDispatchDetail(): JSX.Element {
  const { dispatchId } = useParams<{ dispatchId: string }>();
  return <DispatchBody key={dispatchId} dispatchId={dispatchId} />;
}

function DispatchBody({ dispatchId }: { dispatchId: string | undefined }): JSX.Element {
  const client = useApiClient();
  const [dispatch, setDispatch] = useState<Dispatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { busy, run: runWrite } = useWrite();
  const startRead = useLatestRead();
  const focusRef = useReloadFocus<HTMLDivElement>(loading);
  const [when, setWhen] = useState(nowLocalInput);
  const [returnReason, setReturnReason] = useState("");

  const load = useCallback(async () => {
    const isLatest = startRead();
    if (!dispatchId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { dispatch: d, error: err } = await getDispatch(client, dispatchId);
      if (!isLatest()) return;
      if (err) {
        setError(errorMessage(err, LOAD_FAILURE));
        return;
      }
      setDispatch(d);
    } catch {
      // A rejected read (no reply) must not leave the page on its spinner for good.
      if (isLatest()) setError(LOAD_FAILURE);
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, [client, dispatchId, startRead]);

  useEffect(() => {
    void load();
  }, [load]);

  // The spinner is for the first read only. A refetch after a write keeps the page mounted, so the opener that launched
  // the step is still there for the modal to hand focus back to.
  if (loading && !dispatch) return <LoadingSpinner />;
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

  /** Both steps' fields back to their start. A step is an attestation, so nothing typed for it — or left behind by a
   *  Cancel — may reach the next open: a leftover return reason would arm a write the responder did not just
   *  write. The deployment time is a custody timestamp, so it starts at the moment the step is opened. */
  const resetDrafts = () => {
    setWhen(nowLocalInput());
    setReturnReason("");
  };

  const close = () => {
    resetDrafts();
    setCeremony(null);
    setActionError(null);
  };

  const openCeremony = (next: Exclude<Ceremony, null>) => {
    resetDrafts();
    setActionError(null);
    setCeremony(next);
  };

  /** Run a write, then reload. A refusal (or a rejected request) stays in the modal, beside Save. */
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
      ref={focusRef}
      tabIndex={-1}
      className="wx-kit-column"
      aria-busy={loading}
      style={{ ...columnStyle, outline: "none" }}
    >
      <PageHeader
        title={<span style={pageTitleStyle}>Comfort kit {dispatch.kitSerialNumber}</span>}
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
          What physically left the hub. These quantities are the DEA outbound record — every return
          count is subtracted from them, and they are never edited: a correction is a new
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
          The dispatch's own custody stamps. The per-lot ledger is the DEA perpetual log, behind its
          own permission.
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

      {ceremony === "deploy" ? (
        <FormModal
          title="Mark deployed at patient"
          busy={busy}
          error={actionError}
          onClose={close}
          save={
            <Button
              tone="primary"
              type="button"
              disabled={busy || loading}
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
        </FormModal>
      ) : null}
      {ceremony === "return" ? (
        <FormModal
          title="Open the return obligation"
          busy={busy}
          error={actionError}
          onClose={close}
          save={
            <Button
              tone="primary"
              type="button"
              disabled={busy || loading || returnReason.trim() === ""}
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
        </FormModal>
      ) : null}
    </div>
  );
}
