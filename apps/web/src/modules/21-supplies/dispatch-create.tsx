// apps/web/src/modules/21-supplies — S21.3 COMFORT-KIT DISPATCH CREATION (`/supplies/dispatches/new`,
// §5.4, Track B / ADR-0030). Spec: docs/design/screens/clinical — "Use Form / Wizard."
//
// This is the DEA 21 CFR §1304 outbound-log entry point. The server runs the §2.5 five fail-closed refusals,
// decrements the hub shelf and inserts the per-line log in ONE transaction, behind the §4.4
// `controlled_substance_dispatcher_eligible` predicate AND a step-up gate.
//
// THREE DEPARTURES FROM §5.4, all because the published contract wins over the screen sketch:
//
//   1. §5.4 opens with a PATIENT autocomplete. `CreateDispatchBody` has no patient field — the patient,
//      admission and provider entity come from the SUPPLY REQUEST this dispatch is tied to (§2.5). So the
//      form starts from an open kit-kind request, which is also the only shape that can satisfy §3.1's
//      NOT NULL columns. A patient picker here would have collected an id the server ignores.
//   2. §5.4 asks for a WITNESS selection on each controlled row. There is no witness field on the dispatch:
//      the witness is a §2.6 RECONCILIATION fact (`disposal_witness_membership_id`, and only for at-home
//      witnessed destruction). Rendering a witness picker that went nowhere would tell a dispatcher a
//      second signature had been captured when none had.
//   3. §5.4's chain-of-custody scan/camera capture list is not built: `comfort_kit_dispatch` stores no
//      scan collection (§3.1.8 folds the attestation into discrete columns on the REQUEST), so there is
//      nothing to write the scans to. Delivery evidence is captured on the request's delivery attestation,
//      which does have a document column.
//
// The per-line lot / expiration fields stay OPTIONAL in the form exactly as they are in §4.2's TypeBox: the
// DOMAIN raises `M21_LOT_NUMBER_REQUIRED` with its own code on a controlled line, and letting the boundary
// pre-empt it with a generic "required field" would hide which rule actually refused.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  type ComfortKitTemplateView,
  type DispatchLineInput,
  type SupplyRequestListItem,
  createDispatch,
  errorMessage,
  listComfortKitTemplates,
  listSupplyRequests,
} from "./supplies-api";
import {
  Card,
  Field,
  Notice,
  SchedulePill,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  enumOptions,
  ghostButtonStyle,
  inputNarrowStyle,
  inputStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
  thNum,
} from "./supplies-ui";
import {
  DEFAULT_DEPLOYMENT_SITE,
  DEFAULT_DISPATCH_SOURCE,
  DEFAULT_PHARMACY_DISPATCH_MODE,
  DEPLOYMENT_SITES,
  DISPATCH_SOURCES,
  PHARMACY_DISPATCH_MODES,
  deploymentSiteLabel,
  humanize,
  requestKindLabel,
  shortDate,
  shortId,
} from "./supplies-status";

/** One editable line in the manifest, seeded from a template medication. */
interface LineDraft extends DispatchLineInput {
  drugName: string;
  strength: string;
  isControlledSubstance: boolean;
  controlledSubstanceSchedule: string | null;
}

export function ComfortKitDispatchCreate(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [requests, setRequests] = useState<SupplyRequestListItem[]>([]);
  const [templates, setTemplates] = useState<ComfortKitTemplateView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [supplyRequestId, setSupplyRequestId] = useState(params.get("supplyRequestId") ?? "");
  const [templateId, setTemplateId] = useState("");
  const [deploymentSite, setDeploymentSite] = useState(DEFAULT_DEPLOYMENT_SITE);
  const [ipuRoomId, setIpuRoomId] = useState("");
  const [facilityName, setFacilityName] = useState("");
  const [facilityNpi, setFacilityNpi] = useState("");
  const [roomNumber, setRoomNumber] = useState("");
  const [dispatchSource, setDispatchSource] = useState(DEFAULT_DISPATCH_SOURCE);
  const [pharmacyDispatchMode, setPharmacyDispatchMode] = useState(DEFAULT_PHARMACY_DISPATCH_MODE);
  const [pharmacyPartnerId, setPharmacyPartnerId] = useState("");
  const [kitSerialNumber, setKitSerialNumber] = useState("");
  const [specialHandlingNotes, setSpecialHandlingNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [reqs, tmpls] = await Promise.all([
      // Only the two kit kinds can produce a dispatch (§2.1). Two reads rather than one unfiltered page:
      // the list route filters by a SINGLE kind, and scanning an unfiltered page client-side would drop
      // kit requests that fell past the cap behind a wall of DME.
      Promise.all([
        listSupplyRequests(client, { kind: "comfort_kit_deploy", openOnly: true, limit: 100 }),
        listSupplyRequests(client, { kind: "comfort_kit_replenish", openOnly: true, limit: 100 }),
      ]),
      listComfortKitTemplates(client, { includePlatformFloor: true, limit: 100 }),
    ]);
    const [deploys, replenishes] = reqs;
    if (deploys.error) {
      setLoadError(errorMessage(deploys.error, "Open comfort-kit requests could not be loaded."));
      setLoading(false);
      return;
    }
    setRequests([...(deploys.page?.data ?? []), ...(replenishes.page?.data ?? [])]);
    setTemplates(tmpls.page?.data ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Seeding the manifest from a template REPLACES the lines. A merge would silently keep a lot number
   *  entered against a medication the newly-picked recipe does not contain. */
  const pickTemplate = (id: string) => {
    setTemplateId(id);
    const template = templates.find((tm) => tm.comfortKitTemplateId === id);
    setLines(
      (template?.medications ?? []).map((m) => ({
        comfortKitTemplateMedicationId: m.templateMedicationId,
        dispatchedQuantity: m.expectedQuantity,
        dispatchedUnit: m.expectedUnit,
        drugName: m.drugName,
        strength: m.strength,
        isControlledSubstance: m.isControlledSubstance,
        controlledSubstanceSchedule: m.controlledSubstanceSchedule,
      })),
    );
  };

  const patchLine = (index: number, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  if (loading) return <LoadingSpinner />;
  if (loadError) return <EmptyState title="Unavailable" description={loadError} />;

  const selectedRequest = requests.find((r) => r.supplyRequestId === supplyRequestId);
  const needsFacility = deploymentSite !== "home";
  const isIpu = deploymentSite === "ipu_room";
  const controlledCount = lines.filter((l) => l.isControlledSubstance).length;

  const ready =
    supplyRequestId !== "" &&
    templateId !== "" &&
    kitSerialNumber.trim() !== "" &&
    lines.length > 0 &&
    lines.every((l) => l.dispatchedQuantity.trim() !== "" && l.dispatchedUnit.trim() !== "") &&
    (!isIpu || ipuRoomId.trim() !== "");

  const submit = async () => {
    if (!selectedRequest) return;
    setBusy(true);
    setSubmitError(null);
    const { dispatch, error } = await createDispatch(client, {
      supplyRequestId,
      comfortKitTemplateId: templateId,
      locationId: selectedRequest.locationId,
      deploymentSite,
      ...(isIpu ? { ipuRoomId: ipuRoomId.trim() } : {}),
      ...(needsFacility && facilityName.trim()
        ? {
            facilityIdentifier: {
              facilityName: facilityName.trim(),
              ...(facilityNpi.trim() ? { facilityNpi: facilityNpi.trim() } : {}),
              ...(roomNumber.trim() ? { roomNumber: roomNumber.trim() } : {}),
            },
          }
        : {}),
      dispatchSource,
      pharmacyDispatchMode,
      ...(pharmacyPartnerId.trim() ? { pharmacyPartnerId: pharmacyPartnerId.trim() } : {}),
      kitSerialNumber: kitSerialNumber.trim(),
      contents: lines.map((l) => ({
        comfortKitTemplateMedicationId: l.comfortKitTemplateMedicationId,
        dispatchedQuantity: l.dispatchedQuantity.trim(),
        dispatchedUnit: l.dispatchedUnit.trim(),
        ...(l.lotNumber?.trim() ? { lotNumber: l.lotNumber.trim() } : {}),
        ...(l.expirationDate?.trim() ? { expirationDate: l.expirationDate.trim() } : {}),
        ...(l.manufacturerNdc?.trim() ? { manufacturerNdc: l.manufacturerNdc.trim() } : {}),
        ...(l.medicationOrderId?.trim() ? { medicationOrderId: l.medicationOrderId.trim() } : {}),
      })),
      ...(specialHandlingNotes.trim() ? { specialHandlingNotes: specialHandlingNotes.trim() } : {}),
    });
    setBusy(false);
    if (error) {
      setSubmitError(errorMessage(error, "The comfort kit could not be dispatched."));
      return;
    }
    if (dispatch) navigate(`/supplies/dispatches/${dispatch.dispatchId}`);
  };

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Dispatch a comfort kit</span>}
        breadcrumb="Supplies — comfort kits"
      />

      <Notice tone="warning">
        This records a controlled-substance movement under DEA 21 CFR §1304. The server verifies your
        dispatch authority and asks for a second factor before anything is written; the hub shelf is
        decremented in the same transaction, so a kit that "shipped" off an empty shelf is refused rather
        than recorded.
      </Notice>

      {submitError ? <p style={alertStyle}>{submitError}</p> : null}

      <Card title="Supply request">
        {requests.length === 0 ? (
          <span style={mutedStyle}>
            No open comfort-kit request is available. A dispatch is always tied to one — the patient,
            admission and provider entity come from the request, not from this form.
          </span>
        ) : (
          <>
            <SelectField
              label="Open comfort-kit request"
              value={supplyRequestId}
              options={[
                { value: "", label: "select a request…" },
                ...requests.map((r) => ({
                  value: r.supplyRequestId,
                  label: `${shortId(r.supplyRequestId)} · ${requestKindLabel(r.kind)} · patient ${shortId(r.patientId)} · ${shortDate(r.createdAt)}`,
                })),
              ]}
              onChange={setSupplyRequestId}
            />
            {selectedRequest ? (
              <SummaryGrid>
                <Field label="Patient" value={shortId(selectedRequest.patientId)} mono />
                <Field label="Location" value={shortId(selectedRequest.locationId)} mono />
                <Field label="Kind" value={requestKindLabel(selectedRequest.kind)} />
                <Field label="Status" value={humanize(selectedRequest.status)} />
              </SummaryGrid>
            ) : null}
          </>
        )}
      </Card>

      <Card title="Kit">
        <div style={{ display: "flex", gap: t.space4, flexWrap: "wrap" }}>
          <SelectField
            label="Comfort-kit template"
            value={templateId}
            options={[
              { value: "", label: "select a template…" },
              ...templates.map((tm) => ({
                value: tm.comfortKitTemplateId,
                label: tm.isPlatformFloor ? `${tm.name} (platform floor)` : tm.name,
              })),
            ]}
            onChange={pickTemplate}
          />
          <TextField
            label="Kit serial number"
            value={kitSerialNumber}
            onChange={setKitSerialNumber}
            mono
          />
          <SelectField
            label="Deployment site"
            value={deploymentSite}
            options={enumOptions(DEPLOYMENT_SITES, deploymentSiteLabel)}
            onChange={setDeploymentSite}
          />
          <SelectField
            label="Dispatch source (DEA registration)"
            value={dispatchSource}
            options={enumOptions(DISPATCH_SOURCES)}
            onChange={setDispatchSource}
          />
          <SelectField
            label="Pharmacy dispatch mode"
            value={pharmacyDispatchMode}
            options={enumOptions(PHARMACY_DISPATCH_MODES)}
            onChange={setPharmacyDispatchMode}
          />
          {pharmacyDispatchMode !== "supply_hub_dispatch" ? (
            <TextField
              label="Pharmacy partner id"
              value={pharmacyPartnerId}
              onChange={setPharmacyPartnerId}
              mono
            />
          ) : null}
        </div>

        {/* The FORM SHAPE carries §3.1.8's CHECK: `ipu_room` is the only site with a room id, and the only
            one with no patient delivery address. */}
        {isIpu ? (
          <TextField label="IPU room id" value={ipuRoomId} onChange={setIpuRoomId} mono />
        ) : null}
        {needsFacility ? (
          <div style={{ display: "flex", gap: t.space4, flexWrap: "wrap" }}>
            <TextField label="Facility name" value={facilityName} onChange={setFacilityName} />
            <TextField label="Facility NPI" value={facilityNpi} onChange={setFacilityNpi} mono />
            <TextField label="Room number" value={roomNumber} onChange={setRoomNumber} />
          </div>
        ) : null}
      </Card>

      <Card
        title="Manifest"
        actions={
          controlledCount > 0 ? (
            <StatusPill label={`${controlledCount} controlled line(s)`} tone="warning" />
          ) : undefined
        }
      >
        {lines.length === 0 ? (
          <span style={mutedStyle}>
            Pick a template — its medications seed the manifest. Quantities default to the recipe's expected
            amounts and are edited per line to what physically went in the box.
          </span>
        ) : (
          <>
            <Notice tone="info">
              A controlled line REQUIRES a lot number and an expiration date, and the expiration must sit at
              least 14 days out. Those rules are enforced by the server with their own error codes, so a
              refusal names the rule instead of a generic validation failure.
            </Notice>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Medication</th>
                  <th style={th}>Schedule</th>
                  <th style={thNum}>Quantity</th>
                  <th style={th}>Unit</th>
                  <th style={th}>Lot</th>
                  <th style={th}>Expires</th>
                  <th style={th}>Manufacturer NDC</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.comfortKitTemplateMedicationId} style={rowLine}>
                    <td style={td}>
                      {l.drugName}
                      <div style={mutedStyle}>{l.strength}</div>
                    </td>
                    <td style={td}>
                      <SchedulePill
                        schedule={l.controlledSubstanceSchedule}
                        isControlled={l.isControlledSubstance}
                      />
                    </td>
                    <td style={td}>
                      <input
                        aria-label={`Dispatched quantity for ${l.drugName}`}
                        value={l.dispatchedQuantity}
                        onChange={(e) => patchLine(i, { dispatchedQuantity: e.target.value })}
                        style={inputNarrowStyle}
                      />
                    </td>
                    <td style={td}>
                      <input
                        aria-label={`Unit for ${l.drugName}`}
                        value={l.dispatchedUnit}
                        onChange={(e) => patchLine(i, { dispatchedUnit: e.target.value })}
                        style={{ ...inputStyle, minWidth: "5rem", width: "6rem" }}
                      />
                    </td>
                    <td style={td}>
                      <input
                        aria-label={`Lot number for ${l.drugName}`}
                        value={l.lotNumber ?? ""}
                        onChange={(e) => patchLine(i, { lotNumber: e.target.value })}
                        style={{ ...inputStyle, minWidth: "7rem", fontFamily: t.fontMono }}
                      />
                    </td>
                    <td style={td}>
                      <input
                        aria-label={`Expiration date for ${l.drugName}`}
                        type="date"
                        value={l.expirationDate ?? ""}
                        onChange={(e) => patchLine(i, { expirationDate: e.target.value })}
                        style={{ ...inputStyle, minWidth: "9rem" }}
                      />
                    </td>
                    <td style={td}>
                      <input
                        aria-label={`Manufacturer NDC for ${l.drugName}`}
                        value={l.manufacturerNdc ?? ""}
                        onChange={(e) => patchLine(i, { manufacturerNdc: e.target.value })}
                        style={{ ...inputStyle, minWidth: "7rem", fontFamily: t.fontMono }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>

      <Card title="Handling">
        <TextAreaField
          label="Special handling notes"
          value={specialHandlingNotes}
          onChange={setSpecialHandlingNotes}
          rows={3}
          hint="Audit-denylisted free text (D13) — it is scrubbed from the M4 snapshot, so keep it operational rather than clinical."
        />
      </Card>

      <div style={{ display: "flex", gap: t.space2, justifyContent: "flex-end" }}>
        <button type="button" style={ghostButtonStyle} onClick={() => navigate("/supplies")}>
          Back to queue
        </button>
        <button
          type="button"
          disabled={!ready || busy}
          style={!ready || busy ? disabledButtonStyle : primaryButtonStyle}
          onClick={() => void submit()}
        >
          Dispatch kit
        </button>
      </div>
    </div>
  );
}
