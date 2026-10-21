import {
  Button,
  EntityLookupField,
  Modal,
  SelectField,
  TextField,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/13-emar — the §2.8 D17 "SEND TO PRESCRIBER" ceremony (F-031).
//
// A reconciliation decision of `new_order` (or a `carry_forward` of a home medication into this setting)
// says a medication should be ordered. Until now that said it and nothing happened: no route minted an
// M12 draft from a decision, and `medication_reconciliation_decision.resulting_medication_order_id` — a
// column that has existed since M13-T02 — was written by nobody, so a worksheet could not even show which
// of its lines had been actioned.
//
// TWO DESIGN CHOICES WORTH STATING.
//
//   • The draft is minted against M12's OWN `POST /api/v1/medication-orders`, from the browser, not
//     through a new M13 route. M13 does not write another module's table, and a draft created here has to
//     be the SAME object a prescriber signs — one arriving by a different doorway, not a second kind of
//     order that only reconciliation produces. The decision is then linked with M13's own PATCH.
//   • It mints a DRAFT, never a signed order. The nurse reconciling a chart is not prescribing; the
//     prescriber signs it on M12's surface, where the §2.5 signature and EPCS ceremonies live. That is
//     why this form has no signature and no "send and sign".
//
// The prescriber field is a real M40 MDM lookup rather than a free-text name: `prescribingPhysicianMdmId`
// is a canonical-entity id, and a typed-in name would be a guess at a uuid.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  type ActiveMedicationOrder,
  type MedicationOrderDraftBody,
  createMedicationOrderDraft,
  errorMessage,
  searchMdmPhysicians,
} from "./emar-api";

export interface SendToPrescriberModalProps {
  open: boolean;
  patientId: string;
  admissionId: string;
  /** The line's source order, when the line came from one — every field prefills from it. */
  sourceOrder: ActiveMedicationOrder | null;
  onClose: () => void;
  /** The minted draft's id, for the caller to link onto the decision line. */
  onDrafted: (medicationOrderId: string) => void;
}

const MED_CLASSES: readonly { value: MedicationOrderDraftBody["medClass"]; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "controlled_substance", label: "Controlled substance" },
  { value: "compounded", label: "Compounded" },
];

export function SendToPrescriberModal({
  open,
  patientId,
  admissionId,
  sourceOrder,
  onClose,
  onDrafted,
}: SendToPrescriberModalProps): JSX.Element | null {
  const client = useApiClient();
  const [drugName, setDrugName] = useState("");
  const [strength, setStrength] = useState("");
  const [doseForm, setDoseForm] = useState("");
  const [route, setRoute] = useState("");
  const [medClass, setMedClass] = useState<MedicationOrderDraftBody["medClass"]>("standard");
  const [prescriberMdmId, setPrescriberMdmId] = useState("");
  const [prescriberLabel, setPrescriberLabel] = useState("");
  const [discipline, setDiscipline] = useState("md");
  const [refills, setRefills] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDrugName(sourceOrder?.drugName ?? "");
    setStrength(sourceOrder?.strength ?? "");
    setDoseForm(sourceOrder?.doseForm ?? "");
    setRoute(sourceOrder?.route ?? "");
    setMedClass(sourceOrder?.medClass ?? "standard");
    // A carried-forward order keeps its own prescriber; a caregiver-reported home med has none, so the
    // lookup starts empty rather than defaulting to whoever happens to be first.
    setPrescriberMdmId(sourceOrder?.prescribingPhysicianMdmId ?? "");
    setPrescriberLabel(sourceOrder ? "Prescriber from the source order" : "");
    setDiscipline(sourceOrder?.prescriberDiscipline ?? "md");
    setRefills("0");
    setError(null);
    setBusy(false);
  }, [open, sourceOrder]);

  const loadPrescribers = useCallback(
    async ({ query, limit }: { query: string; limit: number }) => {
      const { results } = await searchMdmPhysicians(client, query, limit);
      return {
        options: results.map((r) => ({
          id: r.id,
          label: r.canonical.displayName,
          searchLabel: r.canonical.displayName,
          description: `${r.canonical.identifierType.toUpperCase()} ${r.canonical.identifierValue}`,
        })),
      };
    },
    [client],
  );

  const ready =
    !busy &&
    drugName.trim().length > 0 &&
    strength.trim().length > 0 &&
    doseForm.trim().length > 0 &&
    route.trim().length > 0 &&
    prescriberMdmId.length > 0 &&
    discipline.trim().length > 0 &&
    Number.isInteger(Number(refills));

  async function commit(): Promise<void> {
    setBusy(true);
    setError(null);
    const { draft, error: err } = await createMedicationOrderDraft(client, {
      patientId,
      admissionId,
      medClass,
      // The drug identity carries across when there is a source order; a caregiver-reported home med has
      // no coded identity and is sent as null rather than as a fabricated code — M12 and M38 are where a
      // code gets bound, and guessing one here would poison the terminology chain.
      rxnormRxcui: sourceOrder?.rxnormRxcui ?? null,
      ndc: sourceOrder?.ndc ?? null,
      drugName: drugName.trim(),
      strength: strength.trim(),
      doseForm: doseForm.trim(),
      route: route.trim(),
      data: {},
      prescriberDiscipline: discipline.trim(),
      prescribingPhysicianMdmId: prescriberMdmId,
      refillsAuthorized: Number(refills),
      ...(sourceOrder?.deaSchedule ? { deaSchedule: sourceOrder.deaSchedule } : {}),
    });
    setBusy(false);
    if (err || !draft) {
      setError(errorMessage(err, "The draft order could not be created."));
      return;
    }
    onDrafted(draft.id);
  }

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Send to prescriber"
      width="34rem"
    >
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        <h2 style={title}>Send to prescriber</h2>
        <p style={meta}>
          Creates a medication-order <strong>draft</strong> for the prescriber to review and sign.
          It is not an order until they sign it, and this links it back to the reconciliation line.
        </p>

        <TextField
          label="Drug"
          required
          value={drugName}
          onChange={(e) => setDrugName(e.target.value)}
        />
        <div style={{ display: "flex", gap: "0.6rem", alignItems: "flex-end" }}>
          <TextField
            label="Strength"
            required
            value={strength}
            onChange={(e) => setStrength(e.target.value)}
            style={{ width: "100%" }}
          />
          <TextField
            label="Dose form"
            required
            value={doseForm}
            onChange={(e) => setDoseForm(e.target.value)}
            style={{ width: "100%" }}
          />
          <TextField
            label="Route"
            required
            value={route}
            onChange={(e) => setRoute(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>

        <SelectField
          label="Medication class"
          value={medClass}
          options={MED_CLASSES}
          onChange={(e) => setMedClass(e.target.value as MedicationOrderDraftBody["medClass"])}
        />

        <EntityLookupField
          label="Prescriber"
          required
          value={prescriberMdmId}
          valueLabel={prescriberLabel}
          placeholder="Search physicians..."
          hint="The canonical MDM physician the draft is addressed to."
          loadOptions={loadPrescribers}
          onChange={(value, option) => {
            setPrescriberMdmId(value);
            setPrescriberLabel(option ? String(option.searchLabel) : "");
          }}
        />

        <div style={{ display: "flex", gap: "0.6rem", alignItems: "flex-end" }}>
          <TextField
            label="Prescriber discipline"
            required
            value={discipline}
            onChange={(e) => setDiscipline(e.target.value)}
            style={{ width: "100%" }}
          />
          <TextField
            label="Refills authorized"
            inputMode="numeric"
            value={refills}
            onChange={(e) => setRefills(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>

        {error ? (
          <p role="alert" style={alert}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <Button tone="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button tone="primary" disabled={!ready} loading={busy} onClick={() => void commit()}>
            Create draft order
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const title: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.25rem",
  color: t.onSurface,
};
const meta: CSSProperties = { fontSize: "0.8rem", color: t.onSurfaceVariant, margin: 0 };
const alert: CSSProperties = { fontSize: "0.8rem", color: t.error, margin: 0 };
