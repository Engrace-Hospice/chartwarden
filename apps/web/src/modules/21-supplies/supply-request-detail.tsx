// apps/web/src/modules/21-supplies — S21.2 SUPPLY REQUEST DETAIL (`/supplies/requests/:id`, §5.3,
// Track B / ADR-0030). Spec: docs/design/screens/clinical — "Use Record Detail."
//
// One request driven through the §2.2 fulfillment machine: the kind-specific payload, the frozen D4 routing
// record, the lifecycle timeline and the context-sensitive action panel. §5.3's ceremonies live HERE rather
// than as registry entries, because each needs the `updatedAt` stamp this screen already read for its
// `If-Match` — a modal that had to re-read the row could act on a stamp that moved in between.
//
// THE ACTION PANEL IS DERIVED FROM THE STATUS, AND IT ONLY OFFERS WHAT §4.1 PUBLISHES. Four §2.2 edges have
// no route at all and the panel says so instead of pretending:
//   • `completeRequest` (received_confirmed → completed) is automatic for one-shot DME/supply, waits on the
//     M13 ack for a kit, and waits on `m11.order.discontinued` for rental DME.
//   • `vendorConfirmedCancellation` / `vendorRefusedCancellation` are the VENDOR's answer, arriving through
//     the §4.5 inbound path — a button here would let a coordinator record an answer nobody gave.
//   • `completeReturnReconciliation` closes when the `comfort_kit_return` row reaches `reconciled`, which is
//     S21.5's job.
// A disabled button carries the missing precondition as its `title`; the SERVER's typed refusal is the real
// control, and the disable is a courtesy.
//
// §5.3 asks for an "audit drawer" pulling the M4 log filtered to this request. Not built: the M4 audit read
// surface is M4's own screen and its own permission (`audit.read`), and re-rendering a filtered slice of it
// inside a supplies screen would put a second, unaudited copy of the accounting trail in a second place.
// The lifecycle timeline below is reconstructed from the request's OWN columns and says so.
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  nowLocalInput,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { HospiceCoverageBadge, HospiceCoverageSection } from "../../shell/hospice-coverage";
import {
  type DeliveryMethod,
  type PharmacyDispatchMode,
  type ReceivedConfirmedActor,
  type SupplyRequestDetail as RequestDetail,
  type VendorRoutingFulfillmentMode,
  assignVendor,
  cancelSupplyRequest,
  confirmReceived,
  errorMessage,
  getSupplyRequest,
  markDelivered,
  markInTransit,
  markOrdered,
  returnSupplyRequest,
  setCoverageDetermination,
} from "./supplies-api";
import {
  DEFAULT_DELIVERY_METHOD,
  DEFAULT_FULFILLMENT_MODE,
  DEFAULT_RECEIPT_ACTOR,
  DELIVERY_METHODS,
  FULFILLMENT_MODES,
  KIT_REQUEST_KINDS,
  PHARMACY_DISPATCH_MODES,
  RECEIPT_ACTORS,
  REQUEST_STATUS_TONE,
  dateTime,
  humanize,
  requestKindLabel,
  shortDate,
  shortId,
  toneOf,
} from "./supplies-status";
import {
  Card,
  Field,
  Modal,
  Notice,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  Timeline,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  enumOptions,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./supplies-ui";

type Ceremony =
  | "assign-vendor"
  | "mark-ordered"
  | "mark-in-transit"
  | "mark-delivered"
  | "confirm-received"
  | "cancel"
  | "return"
  | null;

/** A `datetime-local` value → the ISO instant the §4.2 `date-time` format expects. */
function toInstant(local: string): string {
  const ms = Date.parse(local);
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

export function SupplyRequestDetailScreen(): JSX.Element {
  const client = useApiClient();
  const { supplyRequestId } = useParams<{ supplyRequestId: string }>();
  const [request, setRequest] = useState<RequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ceremony fields
  const [vendorId, setVendorId] = useState("");
  const [fulfillmentMode, setFulfillmentMode] = useState(DEFAULT_FULFILLMENT_MODE);
  const [pharmacyMode, setPharmacyMode] = useState("");
  const [reason, setReason] = useState("");
  const [orderReference, setOrderReference] = useState("");
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState("");
  const [deliveryMethod, setDeliveryMethod] = useState(DEFAULT_DELIVERY_METHOD);
  const [evidenceDocumentId, setEvidenceDocumentId] = useState("");
  const [when, setWhen] = useState(nowLocalInput);
  const [receiptActor, setReceiptActor] = useState(DEFAULT_RECEIPT_ACTOR);

  const load = useCallback(async () => {
    if (!supplyRequestId) return;
    setLoading(true);
    setError(null);
    const { request: r, error: err } = await getSupplyRequest(client, supplyRequestId);
    if (err) {
      setError(errorMessage(err, "This supply request could not be loaded."));
      setLoading(false);
      return;
    }
    setRequest(r);
    setLoading(false);
  }, [client, supplyRequestId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!request || !supplyRequestId)
    return (
      <EmptyState
        title="Not found"
        description="This supply request does not exist, or is outside your organization."
      />
    );

  const stamp = request.updatedAt;
  const isKit = KIT_REQUEST_KINDS.includes(request.kind);

  const close = () => {
    setCeremony(null);
    setActionError(null);
  };

  /** Run a transition, then reload — the response carries the new row, but a reload also refreshes the
   *  derived `dispatchId` the kit path needs, and costs one read on a screen nobody opens in a loop. */
  const run = async (fn: () => Promise<{ error: unknown }>, failure: string) => {
    setBusy(true);
    setActionError(null);
    const { error: err } = await fn();
    setBusy(false);
    if (err) {
      setActionError(errorMessage(err, failure));
      return;
    }
    close();
    void load();
  };

  // §2.2 — which edges the CURRENT status allows, and which of those §4.1 actually publishes.
  const can = {
    assignVendor: request.status === "requested",
    markOrdered: request.status === "vendor_assigned",
    markInTransit: request.status === "ordered",
    markDelivered: request.status === "in_transit",
    confirmReceived: request.status === "delivered",
    cancel: ["requested", "vendor_assigned", "ordered", "in_transit"].includes(request.status),
    // `initiateReturn` is KIT-ONLY: giving DME a `returned` edge would let a bed pickup enter the
    // reconciliation pipeline that exists to count morphine.
    initiateReturn: isKit && ["delivered", "received_confirmed"].includes(request.status),
  };

  const timeline = [
    {
      label: "Requested",
      at: dateTime(request.createdAt),
      by: shortId(request.requestedByMembershipId),
    },
    request.orderedAt ? { label: "Ordered with vendor", at: dateTime(request.orderedAt) } : null,
    request.shippedAt ? { label: "Shipped", at: dateTime(request.shippedAt) } : null,
    request.deliveredAt
      ? {
          label: `Delivered (${humanize(request.deliveryMethod)})`,
          at: dateTime(request.deliveredAt),
          by: shortId(request.deliveredByMembershipId),
        }
      : null,
    request.receivedConfirmedAt
      ? {
          label: `Receipt confirmed by ${humanize(request.receivedConfirmedActor)}`,
          at: dateTime(request.receivedConfirmedAt),
        }
      : null,
    request.cancellationPendingAt
      ? {
          label: "Cancellation requested of the vendor",
          at: dateTime(request.cancellationPendingAt),
        }
      : null,
    request.cancelledAt ? { label: "Cancelled", at: dateTime(request.cancelledAt) } : null,
    request.completedAt ? { label: "Completed", at: dateTime(request.completedAt) } : null,
  ].filter((e): e is { label: string; at: string; by?: string } => e !== null);

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={
          <span style={pageTitleStyle}>Supply request {shortId(request.supplyRequestId)}</span>
        }
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/supplies" style={ghostButtonStyle}>
              Back to queue
            </Link>
            {request.dispatchId ? (
              <Link to={`/supplies/dispatches/${request.dispatchId}`} style={ghostButtonStyle}>
                Comfort-kit dispatch
              </Link>
            ) : null}
          </div>
        }
      />

      {request.status === "cancellation_pending" ? (
        <Notice tone="warning">
          Cancellation has been REQUESTED of the vendor and is not yet a fact. The row keeps its
          real state until the vendor answers — a DME already on the truck cannot be un-shipped by
          our writing "cancelled". Their answer arrives through the vendor inbound path, not from
          this screen.
        </Notice>
      ) : null}

      {request.status === "received_confirmed" ? (
        <Notice tone="info">
          Completion is not a button. A one-shot DME/supply request completes automatically; a
          comfort kit waits on the M13 deployment ack; a rental DME waits on
          `m11.order.discontinued`.
        </Notice>
      ) : null}

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      <Card
        title="Request"
        actions={
          <span className="wx-coverage-actions">
            <StatusPill
              label={humanize(request.status)}
              tone={toneOf(REQUEST_STATUS_TONE, request.status)}
            />
            <HospiceCoverageBadge coverage={request.hospiceCoverage} />
          </span>
        }
      >
        <SummaryGrid>
          <Field label="Kind" value={requestKindLabel(request.kind)} />
          <Field label="Patient" value={shortId(request.patientId)} mono />
          <Field label="Admission" value={shortId(request.admissionId)} mono />
          <Field label="Location" value={shortId(request.locationId)} mono />
          <Field label="Provider entity" value={shortId(request.providerEntityId)} mono />
          <Field
            label="Origin"
            value={
              request.sourceOrderId
                ? `M11 order ${shortId(request.sourceOrderId)}`
                : request.sourceReplenishmentEventId
                  ? `M13 replenishment ${shortId(request.sourceReplenishmentEventId)}`
                  : "Direct creation"
            }
          />
          <Field label="Requested" value={dateTime(request.createdAt)} />
          <Field label="Version stamp" value={dateTime(request.updatedAt)} />
        </SummaryGrid>
        {request.deliveryInstructions ? (
          <div>
            <span style={mutedStyle}>Delivery instructions (D13 — audit-denylisted free text)</span>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: t.onSurface }}>
              {request.deliveryInstructions}
            </p>
          </div>
        ) : null}
        {request.cancellationReason ? (
          <div>
            <span style={mutedStyle}>Cancellation reason</span>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: t.onSurface }}>
              {request.cancellationReason}
            </p>
          </div>
        ) : null}
      </Card>

      {/* COP27 (42 CFR 418.24(c)) — dme / supply only; a comfort-kit drug is determined on its M12 order. */}
      {!isKit ? (
        <HospiceCoverageSection
          current={request}
          onSave={async (draft) => {
            const { request: next, error: err } = await setCoverageDetermination(
              client,
              supplyRequestId,
              stamp,
              draft,
            );
            if (err || !next)
              return errorMessage(err, "The coverage determination could not be saved.");
            setRequest(next);
            return null;
          }}
        />
      ) : null}

      <Card title={`${requestKindLabel(request.kind)} payload`}>
        {/* The per-kind D1 `data` payload is rendered as data. §3.4's per-kind TypeBox is NOT published to
            the client, so a hand-written field list here would be a second, drifting copy of the contract
            the write path validates against — and would silently hide a field a kind gained. */}
        <span style={mutedStyle}>
          The per-kind payload as stored. M21 publishes no client-side schema for it, so it is shown
          verbatim rather than re-rendered into fields this screen would have to guess.
        </span>
        <pre
          style={{
            margin: 0,
            padding: t.space3,
            borderRadius: t.radiusMd,
            background: t.surfaceLow,
            color: t.onSurface,
            fontFamily: t.fontMono,
            fontSize: "0.78rem",
            overflowX: "auto",
          }}
        >
          {JSON.stringify(request.data, null, 2)}
        </pre>
      </Card>

      <Card
        title="Vendor & routing"
        actions={
          can.assignVendor ? (
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={() => setCeremony("assign-vendor")}
            >
              Override vendor
            </button>
          ) : undefined
        }
      >
        <SummaryGrid>
          <Field label="Assigned vendor" value={shortId(request.assignedVendorId)} mono />
          <Field label="Pharmacy partner" value={shortId(request.pharmacyPartnerId)} mono />
          <Field label="Vendor order reference" value={request.vendorOrderReference ?? "—"} mono />
          <Field
            label="Tracking"
            value={
              request.trackingNumber ? `${request.carrier ?? "—"} · ${request.trackingNumber}` : "—"
            }
            mono
          />
        </SummaryGrid>
        {request.routingRuleResolved ? (
          <>
            <SummaryGrid>
              <Field
                label="Precedence level used"
                value={humanize(request.routingRuleResolved.precedenceLevelUsed)}
              />
              <Field
                label="Matched rule"
                value={shortId(request.routingRuleResolved.matchedRuleId)}
                mono
              />
              <Field
                label="Fulfillment mode"
                value={humanize(request.routingRuleResolved.assignedFulfillmentMode)}
              />
              <Field label="Resolved" value={dateTime(request.routingRuleResolved.resolvedAt)} />
              <Field
                label="Resolver version"
                value={request.routingRuleResolved.resolverVersion}
                mono
              />
              <Field
                label="Policy digest"
                value={shortId(request.routingRuleResolved.routingPolicyDigest)}
                mono
              />
            </SummaryGrid>
            <span style={mutedStyle}>
              Every rule the D4 ladder evaluated, in precedence order — this is the frozen answer to
              "why this vendor", and it survives an override.
            </span>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Precedence</th>
                  <th style={th}>Rule</th>
                  <th style={th}>Matched</th>
                  <th style={th}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {request.routingRuleResolved.candidatesEvaluated.map((c, i) => (
                  <tr key={`${c.precedenceLevel}-${c.ruleId ?? i}`} style={rowLine}>
                    <td style={td}>{humanize(c.precedenceLevel)}</td>
                    <td style={{ ...td, fontFamily: t.fontMono }}>{shortId(c.ruleId)}</td>
                    <td style={td}>
                      <StatusPill
                        label={c.matched ? "Matched" : "Skipped"}
                        tone={c.matched ? "success" : "neutral"}
                      />
                    </td>
                    <td style={td}>{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <span style={mutedStyle}>
            No routing has been resolved yet. The D4 ladder runs at vendor assignment and is frozen
            onto the row from that moment.
          </span>
        )}
      </Card>

      <Card title="Lifecycle">
        <span style={mutedStyle}>
          Reconstructed from this request's own timestamp columns. The immutable actor trail — who
          read it, who was refused, who broke glass — belongs to the M4 audit surface that owns it.
        </span>
        {timeline.length === 0 ? (
          <span style={mutedStyle}>Nothing has happened to this request yet.</span>
        ) : (
          <Timeline entries={timeline} />
        )}
      </Card>

      <Card title="Actions">
        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
          <ActionButton
            label="Assign / override vendor"
            enabled={can.assignVendor}
            precondition="Only a request still in `requested` can have its vendor assigned."
            onClick={() => setCeremony("assign-vendor")}
          />
          <ActionButton
            label="Mark ordered"
            enabled={can.markOrdered}
            precondition="A vendor must be assigned before an order can be placed."
            onClick={() => setCeremony("mark-ordered")}
          />
          <ActionButton
            label="Mark in transit"
            enabled={can.markInTransit}
            precondition="The vendor must have accepted the order first."
            onClick={() => setCeremony("mark-in-transit")}
          />
          <ActionButton
            label="Record delivery"
            enabled={can.markDelivered}
            precondition="Only a shipment in transit can be attested as delivered."
            onClick={() => setCeremony("mark-delivered")}
          />
          <ActionButton
            label="Confirm receipt"
            enabled={can.confirmReceived}
            precondition="Receipt is confirmed after delivery is attested."
            onClick={() => setCeremony("confirm-received")}
          />
          <ActionButton
            label="Initiate kit return"
            enabled={can.initiateReturn}
            precondition={
              isKit
                ? "A kit return opens once the kit has been delivered or its receipt confirmed."
                : "Only a comfort-kit request has a return branch — DME comes back through the M11 rental-pickup path."
            }
            onClick={() => setCeremony("return")}
          />
          <ActionButton
            label="Cancel"
            enabled={can.cancel}
            precondition="This request has already reached a state cancellation cannot touch."
            onClick={() => setCeremony("cancel")}
          />
        </div>
      </Card>

      {ceremony === "assign-vendor" ? (
        <Modal
          title="Assign or override the vendor"
          onClose={close}
          footer={
            <button
              type="button"
              disabled={busy}
              style={busy ? disabledButtonStyle : primaryButtonStyle}
              onClick={() =>
                void run(
                  () =>
                    assignVendor(client, supplyRequestId, stamp, {
                      // A null vendor routes to the internal hub — which is why the field is NULLABLE
                      // rather than absent-or-uuid. An empty box means "the hub", not "unset".
                      vendorId: vendorId.trim() === "" ? null : vendorId.trim(),
                      // Always one of the closed vocabularies the SelectFields below offer.
                      fulfillmentMode: fulfillmentMode as VendorRoutingFulfillmentMode,
                      ...(pharmacyMode
                        ? { pharmacyDispatchMode: pharmacyMode as PharmacyDispatchMode }
                        : {}),
                      ...(reason.trim() ? { overrideReason: reason.trim() } : {}),
                    }),
                  "The vendor could not be assigned.",
                )
              }
            >
              Assign vendor
            </button>
          }
        >
          <Notice tone="info">
            The D4 ladder still runs. An override is recorded ON TOP of its trace, so the record
            shows both the rules evaluated and the human decision that overrode them.
          </Notice>
          <TextField
            label="Vendor id (leave blank to route to the internal supply hub)"
            value={vendorId}
            onChange={setVendorId}
            mono
          />
          <SelectField
            label="Fulfillment mode"
            value={fulfillmentMode}
            options={enumOptions(FULFILLMENT_MODES)}
            onChange={setFulfillmentMode}
          />
          <SelectField
            label="Pharmacy dispatch mode (kit kinds)"
            value={pharmacyMode}
            options={[
              { value: "", label: "not applicable" },
              ...enumOptions(PHARMACY_DISPATCH_MODES),
            ]}
            onChange={setPharmacyMode}
          />
          <TextAreaField
            label="Override reason"
            value={reason}
            onChange={setReason}
            rows={3}
            hint="Recorded with the routing trace. Required in practice whenever the ladder's answer is being set aside."
          />
        </Modal>
      ) : null}

      {ceremony === "mark-ordered" ? (
        <Modal
          title="Record the vendor's acceptance"
          onClose={close}
          footer={
            <button
              type="button"
              disabled={busy || orderReference.trim() === ""}
              style={
                busy || orderReference.trim() === "" ? disabledButtonStyle : primaryButtonStyle
              }
              onClick={() =>
                void run(
                  () =>
                    markOrdered(client, supplyRequestId, stamp, {
                      vendorOrderReference: orderReference.trim(),
                    }),
                  "The order could not be recorded.",
                )
              }
            >
              Mark ordered
            </button>
          }
        >
          <Notice tone="info">
            Phase 1 records the vendor's portal / email / fax acceptance by hand; Phase 2 fills this
            from the EDI 855 acknowledgment.
          </Notice>
          <TextField
            label="Vendor order reference"
            value={orderReference}
            onChange={setOrderReference}
            mono
          />
        </Modal>
      ) : null}

      {ceremony === "mark-in-transit" ? (
        <Modal
          title="Record the shipment"
          onClose={close}
          footer={
            <button
              type="button"
              disabled={busy || tracking.trim() === "" || carrier.trim() === ""}
              style={
                busy || tracking.trim() === "" || carrier.trim() === ""
                  ? disabledButtonStyle
                  : primaryButtonStyle
              }
              onClick={() =>
                void run(
                  () =>
                    markInTransit(client, supplyRequestId, stamp, {
                      trackingNumber: tracking.trim(),
                      carrier: carrier.trim(),
                    }),
                  "The shipment could not be recorded.",
                )
              }
            >
              Mark in transit
            </button>
          }
        >
          <TextField label="Carrier" value={carrier} onChange={setCarrier} />
          <TextField label="Tracking number" value={tracking} onChange={setTracking} mono />
        </Modal>
      ) : null}

      {ceremony === "mark-delivered" ? (
        <Modal
          title="Attest delivery"
          onClose={close}
          footer={
            <button
              type="button"
              disabled={busy}
              style={busy ? disabledButtonStyle : primaryButtonStyle}
              onClick={() =>
                void run(
                  () =>
                    markDelivered(client, supplyRequestId, stamp, {
                      deliveredAt: toInstant(when),
                      // `deliveryMethod` is always one of DELIVERY_METHODS — the SelectField below offers
                      // no other value.
                      deliveryMethod: deliveryMethod as DeliveryMethod,
                      ...(evidenceDocumentId.trim()
                        ? { evidenceDocumentId: evidenceDocumentId.trim() }
                        : {}),
                    }),
                  "The delivery attestation could not be recorded.",
                )
              }
            >
              Attest delivery
            </button>
          }
        >
          <Notice tone="warning">
            You are attesting as YOURSELF. The delivering membership is stamped from your session
            and cannot be named in this form — a courier who could name someone else has attested to
            nothing.
          </Notice>
          <TextField label="Delivered at" value={when} onChange={setWhen} type="datetime-local" />
          <SelectField
            label="Delivery method"
            value={deliveryMethod}
            options={enumOptions(DELIVERY_METHODS)}
            onChange={setDeliveryMethod}
          />
          <TextField
            label="Evidence document id (M22 — photo / signature capture, optional)"
            value={evidenceDocumentId}
            onChange={setEvidenceDocumentId}
            mono
          />
        </Modal>
      ) : null}

      {ceremony === "confirm-received" ? (
        <Modal
          title="Confirm receipt"
          onClose={close}
          footer={
            <button
              type="button"
              disabled={busy}
              style={busy ? disabledButtonStyle : primaryButtonStyle}
              onClick={() =>
                void run(
                  () =>
                    confirmReceived(client, supplyRequestId, stamp, {
                      // `receiptActor` is always one of the closed vocabulary the SelectField below offers.
                      actor: receiptActor as ReceivedConfirmedActor,
                      confirmedAt: toInstant(when),
                    }),
                  "Receipt could not be confirmed.",
                )
              }
            >
              Confirm receipt
            </button>
          }
        >
          <Notice tone="info">
            "System auto-confirm" is not offered. It is the 72-hour fallback the worker writes, and
            claiming it here would erase the distinction between an unattended timeout and a person
            who confirmed.
          </Notice>
          <SelectField
            label="Confirmed by"
            value={receiptActor}
            options={enumOptions(RECEIPT_ACTORS)}
            onChange={setReceiptActor}
          />
          <TextField label="Confirmed at" value={when} onChange={setWhen} type="datetime-local" />
        </Modal>
      ) : null}

      {ceremony === "cancel" || ceremony === "return" ? (
        <Modal
          title={ceremony === "cancel" ? "Cancel this request" : "Initiate the kit return"}
          onClose={close}
          footer={
            <button
              type="button"
              disabled={busy || reason.trim() === ""}
              style={busy || reason.trim() === "" ? disabledButtonStyle : primaryButtonStyle}
              onClick={() =>
                void run(
                  () =>
                    ceremony === "cancel"
                      ? cancelSupplyRequest(client, supplyRequestId, stamp, {
                          reason: reason.trim(),
                        })
                      : returnSupplyRequest(client, supplyRequestId, stamp, {
                          reason: reason.trim(),
                        }),
                  ceremony === "cancel"
                    ? "The request could not be cancelled."
                    : "The return could not be initiated.",
                )
              }
            >
              {ceremony === "cancel" ? "Cancel request" : "Initiate return"}
            </button>
          }
        >
          {ceremony === "cancel" ? (
            <Notice tone="warning">
              Before the vendor has the order this cancels immediately. Once ordered or shipping it
              becomes a REQUEST to the vendor and the row moves to "cancellation pending" until they
              answer.
            </Notice>
          ) : (
            <Notice tone="info">
              This opens the §2.6 chain of custody for the kit. Reconciliation — the physical count
              and its witnessed disposal — happens on the return record, not here.
            </Notice>
          )}
          <TextAreaField label="Reason" value={reason} onChange={setReason} rows={3} />
        </Modal>
      ) : null}
    </div>
  );
}

/** An action button that carries its missing precondition rather than vanishing — §5.3: "disabled buttons
 *  surface a tooltip with the missing precondition". A hidden button leaves the gate invisible. */
function ActionButton({
  label,
  enabled,
  precondition,
  onClick,
}: { label: string; enabled: boolean; precondition: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      disabled={!enabled}
      title={enabled ? undefined : precondition}
      aria-disabled={!enabled}
      style={enabled ? ghostButtonStyle : disabledButtonStyle}
      onClick={enabled ? onClick : undefined}
    >
      {label}
    </button>
  );
}
