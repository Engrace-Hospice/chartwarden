import {
  Button,
  Modal,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/12-dosespot — the §2.2 prescribe surface (#91).
//
// Nothing in the staff app could write a prescription. In a hospice, symptom control IS medication —
// this modal is the origin of the chain M13's eMAR administers against, and until #136 the chain did
// not reach the eMAR either (a signed order had one exit, through a DoseSpot transmission worker that
// does not exist, so every signed order was frozen short of `active`).
//
// THE DRUG IDENTITY COMES FROM M38, NOT FROM TYPING. `POST /api/v1/medication-orders` requires
// `rxnormRxcui` AND `ndc`. Those are identity codes: a prescriber typing them is a transcription error
// waiting to be dispensed. The search below is M38's `GET /terminology/rxnorm/search`, and the NDC list
// is the resolved concept's own `properties.ndcs` — the packaged forms of that clinical drug, published
// by the terminology service.
//
// THE SIG IS `data.sigStructured`, AND THAT SHAPE IS NOT A GUESS. `medication_order.data` is
// `Type.Unknown()` at the boundary and stored as opaque jsonb, so a client could put anything there.
// What it MUST put there is `SigStructuredDto`: M12's seam store projects `data.sigStructured` through
// an allowlist into the DTO M13 reads before every administration, including the D11 titration bounds
// that decide whether an infusion rate change is authorised. Keys outside that allowlist are dropped, so
// writing them would be writing to nobody.
//
// CONTROLLED SUBSTANCES ARE OFFERED ONLY WHEN THE AGENCY CAN ACTUALLY SIGN ONE. §2.4/D18:
// `requestSignature` refuses a controlled order unless the tenant is DEA EPCS-certified, and Phase 1
// ships `not_certified`. A prescriber allowed to draft one would get a draft that can never be signed,
// completed or discontinued — a dead end, not a control. The availability is READ from
// `GET /admin/controlled-substance-policy`, not assumed here, so an agency that completes certification
// gets the class without a code change.
//
// ROUTE AND DOSE FORM come from the `route_of_administration` / `dosage_form` value sets when M38 holds
// members for them, and fall back to a free-text field when it does not — those sets are
// concept-data-dependent and empty until the per-system loaders have run (`PLATFORM_VALUE_SET_MEMBERS`'
// own header says so). An empty dropdown for a REQUIRED field would make prescribing impossible on a
// deployment whose terminology has not been loaded; the fallback says which state it is in rather than
// silently offering nothing.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  type CoverageDraft,
  HospiceCoverageFields,
  isNotCovered,
  validateCoverageForm,
} from "../../shell/hospice-coverage";
import {
  type ConceptSearchResult,
  type CreateOrderBody,
  type MedClass,
  type MedicationOrderView,
  type SigStructured,
  controlledPrescribingAvailable,
  createOrder,
  expandValueSet,
  lookupDrug,
  searchDrugs,
  setCoverageDetermination,
} from "./medications-api";

/** The §2.11 frequency codes the sig carries. Free-form at the boundary; these are the common ones. */
const FREQUENCIES = [
  ["QD", "Once daily"],
  ["BID", "Twice daily"],
  ["TID", "Three times daily"],
  ["QID", "Four times daily"],
  ["Q4H", "Every 4 hours"],
  ["Q6H", "Every 6 hours"],
  ["Q8H", "Every 8 hours"],
  ["QHS", "At bedtime"],
  ["PRN", "As needed only"],
] as const;

const MED_CLASSES = [
  ["standard", "Standard"],
  ["compounded", "Compounded"],
  ["controlled_substance", "Controlled substance"],
] as const satisfies readonly (readonly [MedClass, string])[];

export interface PrescribeModalProps {
  readonly open: boolean;
  readonly patientId: string;
  readonly admissionId: string;
  readonly onClose: () => void;
  readonly onCreated: (order: MedicationOrderView) => void;
}

export function PrescribeModal({
  open,
  patientId,
  admissionId,
  onClose,
  onCreated,
}: PrescribeModalProps): JSX.Element | null {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // drug identity (from M38, never typed)
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConceptSearchResult["results"]>([]);
  const [searching, setSearching] = useState(false);
  const [rxcui, setRxcui] = useState("");
  const [drugName, setDrugName] = useState("");
  const [ndcs, setNdcs] = useState<string[]>([]);
  const [ndc, setNdc] = useState("");

  // vocabularies
  const [routes, setRoutes] = useState<string[]>([]);
  const [doseForms, setDoseForms] = useState<string[]>([]);
  const [controlledAvailable, setControlledAvailable] = useState(false);

  // prescriber-entered fields
  const [medClass, setMedClass] = useState<MedClass>("standard");
  const [strength, setStrength] = useState("");
  const [doseForm, setDoseForm] = useState("");
  const [route, setRoute] = useState("");
  const [doseQuantity, setDoseQuantity] = useState("");
  const [doseUnit, setDoseUnit] = useState("mg");
  const [frequencyCode, setFrequencyCode] = useState<string>("QD");
  const [asNeededReason, setAsNeededReason] = useState("");
  const [refills, setRefills] = useState("0");
  const [physicianMdmId, setPhysicianMdmId] = useState("");
  const [prescriberDiscipline, setPrescriberDiscipline] = useState("hospice_physician");
  // COP27 — the hospice coverage determination; a non-default value is saved right after the draft exists.
  const [coverage, setCoverage] = useState<CoverageDraft>({
    hospiceCoverage: "covered_related",
    reason: "",
  });
  const [coverageError, setCoverageError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setQuery("");
    setResults([]);
    setRxcui("");
    setDrugName("");
    setNdcs([]);
    setNdc("");
    setMedClass("standard");
    setStrength("");
    setDoseQuantity("");
    setAsNeededReason("");
    setRefills("0");
    setPhysicianMdmId("");
    setCoverage({ hospiceCoverage: "covered_related", reason: "" });
    setCoverageError(null);
    void (async () => {
      const [r, f, controlled] = await Promise.all([
        expandValueSet(client, "route_of_administration"),
        expandValueSet(client, "dosage_form"),
        controlledPrescribingAvailable(client),
      ]);
      setRoutes(r.map((m) => m.display));
      setDoseForms(f.map((m) => m.display));
      setControlledAvailable(controlled);
      setRoute(r[0]?.display ?? "");
      setDoseForm(f[0]?.display ?? "");
    })();
  }, [open, client]);

  const runSearch = useCallback(async () => {
    setSearching(true);
    setResults(await searchDrugs(client, query));
    setSearching(false);
  }, [client, query]);

  async function pick(code: string, display: string): Promise<void> {
    setRxcui(code);
    setDrugName(display);
    setResults([]);
    const concept = await lookupDrug(client, code);
    const props = (concept?.properties ?? {}) as { ndcs?: string[] };
    const list = props.ndcs ?? [];
    setNdcs(list);
    setNdc(list[0] ?? "");
  }

  if (!open) return null;

  const isPrn = frequencyCode === "PRN";
  const blocked =
    rxcui === "" ||
    ndc === "" ||
    strength.trim() === "" ||
    route.trim() === "" ||
    doseForm.trim() === "" ||
    physicianMdmId.trim() === "" ||
    !(Number(doseQuantity) > 0);

  async function submit(): Promise<void> {
    const coverageInvalid = validateCoverageForm(coverage.hospiceCoverage, coverage.reason);
    if (coverageInvalid) {
      setCoverageError(coverageInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    const sig: SigStructured = {
      doseQuantity: Number(doseQuantity),
      doseUnit,
      route,
      frequencyCode,
      asNeeded: isPrn,
      ...(isPrn && asNeededReason.trim() !== ""
        ? { asNeededReasonCode: asNeededReason.trim() }
        : {}),
    };
    const body = {
      patientId,
      admissionId,
      medClass,
      rxnormRxcui: rxcui,
      ndc,
      drugName,
      strength: strength.trim(),
      doseForm,
      route,
      // `sigStructured` is the key M12's seam store projects into the DTO M13 reads. Nesting it here
      // rather than at the root is what that projection prefers, and it leaves room for the per-class
      // `data` fields the §2.1 catalog promises without colliding with them.
      data: { sigStructured: sig },
      prescriberDiscipline,
      prescribingPhysicianMdmId: physicianMdmId.trim(),
      refillsAuthorized: Number(refills) || 0,
      ...(medClass === "controlled_substance" ? { deaSchedule: "II" as const } : {}),
    } as CreateOrderBody;
    const res = await createOrder(client, body);
    if (!res.ok) {
      setBusy(false);
      setError(res.message);
      return;
    }
    let created = res.value;
    if (isNotCovered(coverage.hospiceCoverage)) {
      const cov = await setCoverageDetermination(client, created.id, {
        hospiceCoverage: coverage.hospiceCoverage,
        reason: coverage.reason.trim(),
      });
      if (!cov.ok) {
        // The draft exists; say so rather than implying nothing was saved.
        setBusy(false);
        onCreated(created);
        setError(
          `The draft was created, but the hospice coverage determination was not saved: ${cov.message} Set it from the order detail.`,
        );
        return;
      }
      created = cov.value;
    }
    setBusy(false);
    onCreated(created);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Prescribe a medication"
      width="36rem"
    >
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h2 style={title}>Prescribe a medication</h2>

        {rxcui === "" ? (
          <>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <TextField
                  label="Find a drug (RxNorm)"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <Button
                tone="tertiary"
                onClick={() => void runSearch()}
                disabled={query.trim().length < 2}
              >
                {searching ? "Searching…" : "Search"}
              </Button>
            </div>
            {results.length > 0 ? (
              <ul style={resultList}>
                {results.map((r) => (
                  <li key={r.code}>
                    <button
                      type="button"
                      style={resultRow}
                      onClick={() => void pick(r.code, r.display)}
                    >
                      <span>{r.display}</span>
                      <span className="wx-data-md">{r.code}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : query.trim().length >= 2 && !searching ? (
              <p style={meta}>
                No RxNorm concepts matched. If this deployment's terminology has not been loaded,
                the platform-ops terminology load is what populates it — a drug cannot be prescribed
                by typing its code here.
              </p>
            ) : null}
          </>
        ) : (
          <div style={pickedBox}>
            <div>
              <strong>{drugName}</strong>{" "}
              <span className="wx-data-md" style={{ fontSize: "0.75rem" }}>
                RxCUI {rxcui}
              </span>
            </div>
            <Button tone="tertiary" onClick={() => setRxcui("")}>
              Change
            </Button>
          </div>
        )}

        {rxcui !== "" ? (
          <>
            {ndcs.length === 0 ? (
              <p style={warn}>
                This concept publishes no NDCs, and the order requires one. Choose a packaged form
                (an SCD/SBD rather than an ingredient) — the create will be refused without it.
              </p>
            ) : (
              <SelectField
                label="NDC (packaged form)"
                value={ndc}
                onChange={(e) => setNdc(e.target.value)}
                options={ndcs.map((n) => ({ value: n, label: n }))}
              />
            )}

            <SelectField
              label="Class"
              value={medClass}
              onChange={(e) => setMedClass(e.target.value as MedClass)}
              options={MED_CLASSES.filter(
                ([v]) => v !== "controlled_substance" || controlledAvailable,
              ).map(([value, label]) => ({ value, label }))}
            />
            {!controlledAvailable ? (
              <p style={meta}>
                Controlled substances are not offered: the agency is not DEA EPCS-certified, so the
                server refuses to move such an order past draft (§2.4 D18). Drafting one would
                create a record that can never be signed, completed or discontinued.
              </p>
            ) : null}

            <div style={row2}>
              <TextField
                label="Strength"
                value={strength}
                onChange={(e) => setStrength(e.target.value)}
              />
              {doseForms.length > 0 ? (
                <SelectField
                  label="Dose form"
                  value={doseForm}
                  onChange={(e) => setDoseForm(e.target.value)}
                  options={doseForms.map((d) => ({ value: d, label: d }))}
                />
              ) : (
                <TextField
                  label="Dose form"
                  value={doseForm}
                  onChange={(e) => setDoseForm(e.target.value)}
                />
              )}
            </div>

            <div style={row3}>
              <TextField
                label="Dose"
                value={doseQuantity}
                onChange={(e) => setDoseQuantity(e.target.value)}
              />
              <TextField
                label="Unit"
                value={doseUnit}
                onChange={(e) => setDoseUnit(e.target.value)}
              />
              {routes.length > 0 ? (
                <SelectField
                  label="Route"
                  value={route}
                  onChange={(e) => setRoute(e.target.value)}
                  options={routes.map((r) => ({ value: r, label: r }))}
                />
              ) : (
                <TextField label="Route" value={route} onChange={(e) => setRoute(e.target.value)} />
              )}
            </div>

            <SelectField
              label="Frequency"
              value={frequencyCode}
              onChange={(e) => setFrequencyCode(e.target.value)}
              options={FREQUENCIES.map(([value, label]) => ({ value, label }))}
            />
            {isPrn ? (
              <TextAreaField
                label="PRN indication"
                value={asNeededReason}
                onChange={(e) => setAsNeededReason(e.target.value)}
                rows={2}
              />
            ) : null}

            <div style={row2}>
              <TextField
                label="Refills authorised"
                value={refills}
                onChange={(e) => setRefills(e.target.value)}
              />
              <TextField
                label="Ordering physician (MDM id)"
                value={physicianMdmId}
                onChange={(e) => setPhysicianMdmId(e.target.value)}
              />
            </div>
            <SelectField
              label="Prescribing as"
              value={prescriberDiscipline}
              onChange={(e) => setPrescriberDiscipline(e.target.value)}
              options={[
                { value: "hospice_physician", label: "Hospice physician" },
                { value: "medical_director", label: "Medical director" },
                { value: "np", label: "Nurse practitioner" },
              ]}
            />
            <HospiceCoverageFields
              value={coverage}
              onChange={(next) => {
                setCoverage(next);
                setCoverageError(null);
              }}
              error={coverageError}
              disabled={busy}
            />
            <p style={meta}>
              This creates a DRAFT. The server decides whether your discipline may sign this class;
              send it for signature, or sign it yourself from the Sign Inbox.
            </p>
          </>
        ) : null}

        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || blocked}>
            {busy ? "Drafting…" : "Create draft"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const title = { margin: 0, fontSize: "1.05rem", fontWeight: 600 } as const;
const meta = { margin: 0, fontSize: "0.75rem", color: "var(--color-on-surface-variant)" } as const;
const warn = { margin: 0, fontSize: "0.75rem", color: "var(--color-warning)" } as const;
const errorText = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" } as const;
const resultList = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  maxHeight: "12rem",
  overflowY: "auto",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
  borderRadius: "0.5rem",
} as const;
const resultRow = {
  display: "flex",
  width: "100%",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.5rem 0.75rem",
  border: "none",
  background: "none",
  cursor: "pointer",
  textAlign: "left",
  fontSize: "0.85rem",
  color: "var(--color-on-surface)",
} as const;
const pickedBox = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  fontSize: "0.9rem",
} as const;
const row2 = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" } as const;
const row3 = { display: "grid", gridTemplateColumns: "1fr 1fr 1.4fr", gap: "0.5rem" } as const;
