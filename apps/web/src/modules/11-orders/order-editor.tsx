import { Button, Modal, nowLocalInput, useApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { CanonicalOrderFields, kindDefaults } from "./order-kind-fields";
import { OrderAdmissionLookup, OrderingPhysicianLookup } from "./order-lookups";

const KINDS = [
  "lab",
  "dme",
  "level_of_care_change",
  "recertification",
  "comfort_kit",
  "supply",
  "ancillary_service",
  "idg_requested",
] as const;

type OrderKind = (typeof KINDS)[number];

/**
 * Mirrors `ORDER_KIND_CATALOG[kind].allowsVerbal` in `@chartwarden/orders` (§2.3): level-of-care changes
 * and recertifications need a written order ab initio, so the verbal form must not offer them.
 */
const KIND_OPTIONS: ReadonlyArray<{ value: OrderKind; label: string; allowsVerbal: boolean }> = [
  { value: "lab", label: "Lab", allowsVerbal: true },
  { value: "dme", label: "DME", allowsVerbal: true },
  { value: "level_of_care_change", label: "Level of care change", allowsVerbal: false },
  { value: "recertification", label: "Recertification", allowsVerbal: false },
  { value: "comfort_kit", label: "Comfort kit", allowsVerbal: true },
  { value: "supply", label: "Supply", allowsVerbal: true },
  { value: "ancillary_service", label: "Ancillary service", allowsVerbal: true },
];

export interface EditableOrder {
  id: string;
  admissionId: string;
  kind: OrderKind;
  priority: string;
  drafterDiscipline: string;
  orderingPhysicianMdmId: string;
  data: unknown;
}

export function OrderEditor({
  open,
  onClose,
  patientId,
  replacesOrderId,
  draft,
  verbal = false,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  patientId: string;
  replacesOrderId?: string;
  draft?: EditableOrder;
  verbal?: boolean;
  onSaved: (id: string) => void;
}): JSX.Element {
  const client = useApiClient();
  const [admissionId, setAdmissionId] = useState(draft?.admissionId ?? "");
  const [physicianId, setPhysicianId] = useState(draft?.orderingPhysicianMdmId ?? "");
  const [kind, setKind] = useState<OrderKind>(draft?.kind ?? "lab");
  const [discipline, setDiscipline] = useState(draft?.drafterDiscipline ?? "rn_case_manager");
  const [priority, setPriority] = useState(draft?.priority ?? "routine");
  const [data, setData] = useState<Record<string, unknown>>(() => asData(draft?.data));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [receivedAt, setReceivedAt] = useState(nowLocalInput);
  const [attestation, setAttestation] = useState("");
  const [readBackVerified, setReadBackVerified] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (draft) {
      setAdmissionId(draft.admissionId);
      setPhysicianId(draft.orderingPhysicianMdmId);
      setKind(draft.kind);
      setDiscipline(draft.drafterDiscipline);
      setPriority(draft.priority);
      setData(asData(draft.data));
    }
    setError(null);
    setFieldErrors({});
  }, [draft, open]);

  const save = async (): Promise<void> => {
    if (!admissionId || !physicianId) {
      setError("Admission and ordering physician are required.");
      return;
    }

    setBusy(true);
    setError(null);
    setFieldErrors({});
    const payload = { ...kindDefaults(kind), ...data };

    try {
      let result: { data?: unknown; error?: unknown };

      if (draft) {
        const patch = client.PATCH as unknown as (
          path: string,
          init: unknown,
        ) => Promise<{ data?: unknown; error?: unknown }>;
        result = await patch("/api/v1/orders/{id}", {
          params: { path: { id: draft.id } },
          body: { data: payload, priority },
        });
      } else {
        const post = client.POST as unknown as (
          path: string,
          init: unknown,
        ) => Promise<{ data?: unknown; error?: unknown }>;
        const path = verbal
          ? "/api/v1/verbal-orders"
          : replacesOrderId
            ? "/api/v1/orders/{id}/correct"
            : "/api/v1/orders";
        result = await post(path, {
          params: !verbal && replacesOrderId ? { path: { id: replacesOrderId } } : undefined,
          body: verbal
            ? {
                order: {
                  patientId,
                  admissionId,
                  kind,
                  drafterDiscipline: discipline,
                  data: payload,
                  priority,
                  orderingPhysicianMdmId: physicianId,
                },
                verbal: {
                  recorderDiscipline: discipline,
                  orderingPhysicianMdmId: physicianId,
                  receivedAt: new Date(receivedAt).toISOString(),
                  effectiveAt: new Date(receivedAt).toISOString(),
                  readBackVerified,
                  verbalAttestation: attestation,
                },
              }
            : {
                patientId,
                admissionId,
                kind,
                drafterDiscipline: discipline,
                data: payload,
                priority,
                orderingPhysicianMdmId: physicianId,
              },
        });
      }

      if (result.error || !result.data) {
        setError(message(result.error));
        setFieldErrors(findings(result.error));
        return;
      }

      onSaved((result.data as { id?: string }).id ?? draft?.id ?? "");
    } catch {
      setError("The server could not save this order. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const title = draft
    ? "Edit draft"
    : replacesOrderId
      ? "Create corrected order"
      : verbal
        ? "New verbal order"
        : "New order";

  return (
    <Modal open={open} onClose={busy ? undefined : onClose} ariaLabel={title} width="42rem">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        style={form}
      >
        <div>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <p style={intro}>
            {draft
              ? "Complete the clinical details for this draft. You can save incomplete work and return later."
              : replacesOrderId
                ? "The original order remains unchanged. This creates a replacement draft that must be reviewed and signed."
                : "Create the order as a draft. It will not become active until the required review and signatures are complete."}
          </p>
        </div>

        {error ? (
          <div role="alert" style={errorBox}>
            {error}
          </div>
        ) : null}

        <div style={section}>
          <h3 style={sectionTitle}>Order setup</h3>
          <div style={grid}>
            <label style={field}>
              Order kind
              <select
                value={kind}
                disabled={Boolean(draft)}
                onChange={(e) => setKind(e.target.value as OrderKind)}
                style={control}
              >
                {KIND_OPTIONS.filter((k) => !verbal || k.allowsVerbal).map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={field}>
              Priority
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                style={control}
              >
                <option value="routine">Routine</option>
                <option value="asap">ASAP</option>
                <option value="stat">STAT</option>
              </select>
            </label>
          </div>

          {!draft ? (
            <div style={{ ...grid, marginTop: "1rem" }}>
              <OrderAdmissionLookup
                label="Admission"
                value={admissionId}
                onChange={setAdmissionId}
                patientId={patientId}
                required
              />
              <OrderingPhysicianLookup
                label="Ordering physician"
                value={physicianId}
                onChange={setPhysicianId}
                required
              />
              <label style={field}>
                Drafting discipline
                <input
                  value={discipline}
                  onChange={(e) => setDiscipline(e.target.value)}
                  required
                  style={control}
                />
              </label>
            </div>
          ) : null}
        </div>

        <CanonicalOrderFields kind={kind} value={data} onChange={setData} errors={fieldErrors} />

        {verbal ? (
          <div style={section}>
            <h3 style={sectionTitle}>Verbal order details</h3>
            <div style={grid}>
              <label style={field}>
                Received at
                <input
                  type="datetime-local"
                  value={receivedAt}
                  onChange={(e) => setReceivedAt(e.target.value)}
                  required
                  style={control}
                />
              </label>
              <label style={{ ...field, gridColumn: "1 / -1" }}>
                Verbal attestation
                <textarea
                  value={attestation}
                  onChange={(e) => setAttestation(e.target.value)}
                  minLength={100}
                  maxLength={2000}
                  required
                  style={control}
                />
              </label>
              <label style={field}>
                <span>
                  <input
                    type="checkbox"
                    checked={readBackVerified}
                    onChange={(e) => setReadBackVerified(e.target.checked)}
                    required
                  />{" "}
                  Read-back verified
                </span>
              </label>
            </div>
          </div>
        ) : null}

        <div style={footer}>
          <span style={saveHint}>
            {draft
              ? "Saving updates this Draft only."
              : verbal
                ? "This records a verbal order pending signature."
                : "This will be saved as a Draft."}
          </span>
          <div style={{ display: "flex", gap: ".75rem" }}>
            <Button type="button" tone="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : verbal ? "Record verbal order" : "Save draft"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function asData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
type ApiError = {
  message?: string;
  detail?: string;
  details?: unknown;
};
/** The API wraps failures as `{ error: { message, details } }`; accept the unwrapped shape too. */
function apiError(error: unknown): ApiError {
  const x = error as (ApiError & { error?: ApiError }) | undefined;
  return x?.error ?? x ?? {};
}
export function message(error: unknown): string {
  const x = apiError(error);
  const lead = Array.isArray(x.details)
    ? (x.details[0] as { field?: string; message?: string } | undefined)
    : undefined;
  const field = lead?.field?.replace(/^data\.?/, "");
  const first = lead?.message ? (field ? `${field}: ${lead.message}` : lead.message) : undefined;
  return (
    first ??
    x.detail ??
    x.message ??
    "The server could not save this order. Review the clinical details and try again."
  );
}
export function findings(error: unknown): Record<string, string> {
  const details = apiError(error).details;
  const list = Array.isArray(details)
    ? (details as Array<{ field?: string; message?: string }>)
    : [];
  return Object.fromEntries(
    list
      .filter((x) => x.field && x.message)
      .map((x) => [x.field!.replace(/^data\./, ""), x.message!]),
  );
}

const form = { display: "grid", gap: "1.25rem", padding: "1.25rem" } as const;
const intro = {
  margin: ".4rem 0 0",
  color: "var(--color-on-surface-variant)",
  lineHeight: 1.5,
} as const;
const section = {
  padding: "1rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: ".75rem",
} as const;
const sectionTitle = { margin: "0 0 .9rem", fontSize: ".95rem" } as const;
const grid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
  gap: "1rem",
} as const;
const field = {
  display: "grid",
  gap: ".4rem",
  fontSize: ".875rem",
  fontWeight: 600,
} as const;
const control = {
  display: "block",
  width: "100%",
  boxSizing: "border-box" as const,
  minHeight: "2.5rem",
  padding: ".55rem .65rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: ".45rem",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
} as const;
const errorBox = {
  padding: ".75rem 1rem",
  border: "1px solid var(--color-error)",
  borderRadius: ".5rem",
  color: "var(--color-error)",
} as const;
const footer = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap" as const,
  gap: "1rem",
  paddingTop: ".25rem",
} as const;
const saveHint = {
  color: "var(--color-on-surface-variant)",
  fontSize: ".8rem",
} as const;
