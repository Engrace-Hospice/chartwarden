// apps/web/src/modules/06-admission/discharge-order-ui.tsx — the 42 CFR 418.26(b) written physician discharge
// order (FY 2027 rule, effective 2026-10-01).
//
// "Prior to discharging a patient for any reason listed in paragraph (a) …, the hospice must obtain a written
// physician's discharge order from the hospice medical director (or physician designee …) or physician member
// of the interdisciplinary group." Three pieces, each a self-contained component so the discharge workflow
// screens only need a mount point:
//   · `DischargeOrderFields` — capture on the discharge flow (route 39 `dischargeOrder`): eligible-signer
//     picker with capacity, signed-at, order text, source reference. Required for a live (non-death,
//     non-for-cause) discharge dated on/after 2026-10-01.
//   · `CosignOrderFields`   — the for-cause cosign IS the order (route 40): capacity + order text/reference.
//   · `DischargeOrderSection` — the read view on the admission (order, signer capacity, signed-at, the
//     persisted for-cause cosigner name/NPI), from `GET /admissions/:id/discharge-order`.
// Redesign kit only; mockup "Admissions" (03_20_25) — flat sections, label/value rows, lock + source line.
import {
  EmptyState,
  LoadingSpinner,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  useApiClient,
} from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { usDate } from "./election-addendum-format";
import {
  AuthoritySection,
  CAPACITY_LABEL,
  LockedFacts,
  type PhysicianSignerCapacity,
  PhysicianSignerPicker,
  localInputToIso,
  nowLocalInput,
  usDateTime,
} from "./physician-authority-ui";

/** 418.26(b) as amended by CMS-1851-F (mirrors the server's DISCHARGE_ORDER_EFFECTIVE_DATE). */
export const DISCHARGE_ORDER_EFFECTIVE_DATE = "2026-10-01";

/** True when this discharge must carry an order at filing (the server re-checks). */
export function dischargeOrderRequiredAtFiling(reason: string, dischargeDate: string): boolean {
  if (reason === "death" || reason === "for_cause") return false;
  return dischargeDate.slice(0, 10) >= DISCHARGE_ORDER_EFFECTIVE_DATE;
}

/** The capture state; `toBody` turns it into route 39's `dischargeOrder`. */
export interface DischargeOrderDraft {
  signedByUserId: string;
  capacity: PhysicianSignerCapacity | null;
  signedAtLocal: string;
  orderText: string;
  orderReference: string;
}

export function emptyDischargeOrder(): DischargeOrderDraft {
  return {
    signedByUserId: "",
    capacity: null,
    signedAtLocal: nowLocalInput(),
    orderText: "",
    orderReference: "",
  };
}

export function dischargeOrderComplete(d: DischargeOrderDraft): boolean {
  return d.signedByUserId !== "" && d.signedAtLocal !== "";
}

/** Route 39 body fragment, or `undefined` when nothing was captured. */
export function dischargeOrderBody(d: DischargeOrderDraft):
  | {
      signedByUserId: string;
      signedAt: string;
      capacity?: PhysicianSignerCapacity;
      orderText?: string;
      orderReference?: string;
    }
  | undefined {
  if (!dischargeOrderComplete(d)) return undefined;
  return {
    signedByUserId: d.signedByUserId,
    signedAt: localInputToIso(d.signedAtLocal),
    ...(d.capacity ? { capacity: d.capacity } : {}),
    ...(d.orderText.trim() ? { orderText: d.orderText.trim() } : {}),
    ...(d.orderReference.trim() ? { orderReference: d.orderReference.trim() } : {}),
  };
}

/** Capture on the discharge flow. Mount inside the discharge form for live (non-death) reasons. */
export function DischargeOrderFields({
  admissionId,
  reason,
  dischargeDate,
  value,
  onChange,
}: {
  admissionId: string;
  reason: string;
  dischargeDate: string;
  value: DischargeOrderDraft;
  onChange: (next: DischargeOrderDraft) => void;
}): JSX.Element | null {
  if (reason === "death" || reason === "for_cause") return null;
  const required = dischargeOrderRequiredAtFiling(reason, dischargeDate);
  return (
    <AuthoritySection
      icon="scroll"
      title="Physician discharge order"
      description={
        required
          ? "Required before this discharge: signed by the medical director, a physician designee, or the patient's IDG physician."
          : "Optional for a discharge dated before 10/01/2026 (the medical director signs under the prior rule)."
      }
      aside={
        <>
          <span className="wx-muted-code">42 CFR 418.26(b)</span>
          <StatusPill
            label={required ? "Required" : "Optional"}
            tone={required ? "warning" : "neutral"}
          />
        </>
      }
    >
      <div className="wx-field-grid">
        <div className="wx-field-grid-full">
          <PhysicianSignerPicker
            admissionId={admissionId}
            label="Ordering physician"
            value={value.signedByUserId}
            onChange={(userId, capacity) =>
              onChange({ ...value, signedByUserId: userId, capacity })
            }
          />
        </div>
        <TextField
          label="Order signed at"
          type="datetime-local"
          required={required}
          value={value.signedAtLocal}
          onChange={(e) => onChange({ ...value, signedAtLocal: e.target.value })}
          hint="No later than the discharge date."
        />
        <TextField
          label="Order reference"
          value={value.orderReference}
          maxLength={200}
          onChange={(e) => onChange({ ...value, orderReference: e.target.value })}
          hint="Signed order document or fax number, if any."
        />
        <div className="wx-field-grid-full">
          <TextAreaField
            label="Order text"
            value={value.orderText}
            maxLength={4000}
            onChange={(e) => onChange({ ...value, orderText: e.target.value })}
            hint="The physician's discharge order as written."
          />
        </div>
      </div>
    </AuthoritySection>
  );
}

/** The for-cause cosign's order facts (the cosigner is the signed-in physician; the server derives roles). */
export interface CosignOrderDraft {
  capacity: PhysicianSignerCapacity | "";
  orderText: string;
  orderReference: string;
}

export function CosignOrderFields({
  value,
  onChange,
}: {
  value: CosignOrderDraft;
  onChange: (next: CosignOrderDraft) => void;
}): JSX.Element {
  return (
    <div className="wx-pa-stack">
      <SelectField
        label="Signing as"
        value={value.capacity}
        onChange={(e) =>
          onChange({ ...value, capacity: e.target.value as PhysicianSignerCapacity | "" })
        }
        hint="Your capacity is checked against your roles and this patient's IDG; leave blank to use it automatically."
        options={[
          { value: "", label: "Detect from my roles" },
          { value: "medical_director", label: CAPACITY_LABEL.medical_director },
          { value: "physician_designee", label: CAPACITY_LABEL.physician_designee },
          { value: "idg_physician_member", label: CAPACITY_LABEL.idg_physician_member },
        ]}
      />
      <TextAreaField
        label="Discharge order text"
        value={value.orderText}
        maxLength={4000}
        onChange={(e) => onChange({ ...value, orderText: e.target.value })}
        hint="Your cosign is the written discharge order (42 CFR 418.26(b))."
      />
      <TextField
        label="Order reference"
        value={value.orderReference}
        maxLength={200}
        onChange={(e) => onChange({ ...value, orderReference: e.target.value })}
      />
    </div>
  );
}

interface DischargeOrderRead {
  dischargeEventId: string;
  reason: string;
  status: string;
  dischargeDate: string;
  orderRequired: boolean;
  order: {
    signedByUserId: string;
    signedByName: string | null;
    capacity: PhysicianSignerCapacity;
    signedAt: string;
    orderText: string | null;
    orderReference: string | null;
  } | null;
  cosigner: { name: string; npi: string; cosignedAt: string | null } | null;
}

const REASON_LABEL: Record<string, string> = {
  death: "Death",
  moved_out_of_service_area: "Moved out of service area",
  no_longer_terminal: "No longer terminally ill",
  for_cause: "For cause",
  other: "Other",
};

/** The read view on the admission: renders nothing until the admission has a discharge. */
export function DischargeOrderSection({
  admissionId,
}: { admissionId: string }): JSX.Element | null {
  const client = useApiClient();
  const [data, setData] = useState<DischargeOrderRead | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    client
      .GET("/api/v1/admissions/{id}/discharge-order", { params: { path: { id: admissionId } } })
      .then((r) => {
        if (!active) return;
        if (r.error) {
          setFailed(true);
          setData(null);
          return;
        }
        setData(
          (r.data as { discharge?: DischargeOrderRead | null } | undefined)?.discharge ?? null,
        );
      })
      .catch(() => {
        if (active) {
          setFailed(true);
          setData(null);
        }
      });
    return () => {
      active = false;
    };
  }, [client, admissionId]);

  if (data === undefined) return <LoadingSpinner />;
  if (data === null && !failed) return null;
  return (
    <AuthoritySection
      icon="scroll"
      title="Discharge order"
      description="The written physician discharge order and, for a for-cause discharge, its cosigner."
      aside={
        data ? (
          <>
            <span className="wx-muted-code">42 CFR 418.26(b)</span>
            <StatusPill
              label={
                data.order ? "Order on file" : data.orderRequired ? "Order missing" : "Not required"
              }
              tone={data.order ? "success" : data.orderRequired ? "error" : "neutral"}
            />
          </>
        ) : null
      }
    >
      {data === null ? (
        <EmptyState title="Unavailable" description="The discharge order could not be loaded." />
      ) : (
        <div className="wx-pa-stack">
          <LockedFacts
            rows={[
              ["Reason", REASON_LABEL[data.reason] ?? data.reason],
              [
                "Discharge date",
                <span key="date" className="wx-nums">
                  {usDate(data.dischargeDate)}
                </span>,
              ],
              ...(data.order
                ? ([
                    ["Ordered by", data.order.signedByName ?? "Physician (no longer listed)"],
                    ["Capacity", CAPACITY_LABEL[data.order.capacity]],
                    [
                      "Signed",
                      <span key="signed" className="wx-nums">
                        {usDateTime(data.order.signedAt)}
                      </span>,
                    ],
                    ...(data.order.orderReference
                      ? ([["Reference", data.order.orderReference]] as const)
                      : []),
                    ...(data.order.orderText
                      ? ([
                          [
                            "Order text",
                            <span key="text" className="wx-pa-order-text">
                              {data.order.orderText}
                            </span>,
                          ],
                        ] as const)
                      : []),
                  ] as const)
                : ([
                    [
                      "Order",
                      data.orderRequired ? "Not on file" : "Not required (death or prior rule)",
                    ],
                  ] as const)),
              ...(data.cosigner
                ? ([
                    ["Cosigner", data.cosigner.name],
                    [
                      "Cosigner NPI",
                      <span key="npi" className="wx-data-md">
                        {data.cosigner.npi}
                      </span>,
                    ],
                    [
                      "Cosigned",
                      <span key="cosigned" className="wx-nums">
                        {usDateTime(data.cosigner.cosignedAt)}
                      </span>,
                    ],
                  ] as const)
                : []),
            ]}
            source="Recorded on the discharge · signer validated against the 418.26(b) signer set"
          />
        </div>
      )}
    </AuthoritySection>
  );
}
