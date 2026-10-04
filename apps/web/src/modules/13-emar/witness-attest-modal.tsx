import { Button, Modal, SelectField, TextField, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/13-emar — the §2.6 D7 WITNESS ceremony (M13 §4.1 route 2; F-031).
//
// The other half of a controlled-substance administration, and the half that has to live on a different
// device. `POST /administrations/witness-attest` mints against the CALLER's session, and the route's
// `controlled_substance_witness_eligible` predicate refuses a witness who is the administering clinician,
// inactive, cross-tenant, or a caregiver. So this is not a field the administering clinician can fill in
// for themselves — a second clinician signs in on their own handset, opens this, and reads back a token
// that lives for sixty seconds and can be spent exactly once.
//
// That is why the ceremony hands back a STRING for a human to relay rather than completing the
// administration itself: the two acts are performed by two people, and the token is the only thing that
// crosses between them. The countdown is shown because a token that has quietly expired and a token that
// was never valid produce the same refusal at the other end, and the clinician needs to be able to tell
// which one happened.
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { type ActiveMedicationOrder, errorMessage, mintWitnessToken } from "./emar-api";

export interface WitnessAttestModalProps {
  open: boolean;
  patientId: string;
  /** Controlled-substance orders only — the D7 ceremony has no meaning for the rest. */
  orders: readonly ActiveMedicationOrder[];
  onClose: () => void;
}

const ATTESTATION =
  "I attest I observed the controlled-substance administration and verified the drug, dose and patient.";

export function WitnessAttestModal({
  open,
  patientId,
  orders,
  onClose,
}: WitnessAttestModalProps): JSX.Element | null {
  const client = useApiClient();
  const [orderId, setOrderId] = useState(orders[0]?.id ?? "");
  const [administeringId, setAdministeringId] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOrderId(orders[0]?.id ?? "");
    setAdministeringId("");
    setToken(null);
    setSecondsLeft(0);
    setError(null);
    setBusy(false);
  }, [open, orders]);

  // The token's own life, counted down locally. Purely informational — the SERVER decides expiry, and a
  // token that reaches 0 here is refused there too; this only stops a clinician reading out a dead one.
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  async function mint(): Promise<void> {
    setBusy(true);
    setError(null);
    const { minted, error: err } = await mintWitnessToken(client, {
      patientId,
      medicationOrderId: orderId,
      administeringClinicianMembershipId: administeringId.trim(),
      attestationText: ATTESTATION,
    });
    setBusy(false);
    if (err || !minted) {
      setError(
        errorMessage(
          err,
          "The witness attestation could not be minted. You cannot witness your own administration.",
        ),
      );
      return;
    }
    setToken(minted.token);
    setSecondsLeft(minted.expiresInSeconds);
  }

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Witness a controlled substance"
      width="32rem"
      accent={t.alert}
    >
      <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        <h2 style={title}>Witness a controlled substance</h2>
        <p style={meta}>{ATTESTATION}</p>

        {token === null ? (
          <>
            {orders.length === 0 ? (
              <TextField
                label="Medication order id"
                value={orderId}
                required
                onChange={(e) => setOrderId(e.target.value)}
              />
            ) : (
              <SelectField
                label="Medication"
                value={orderId}
                required
                options={orders.map((o) => ({
                  value: o.id,
                  label: `${o.drugName} ${o.strength} · ${o.route}`,
                }))}
                onChange={(e) => setOrderId(e.target.value)}
              />
            )}
            <TextField
              label="Administering clinician's code"
              value={administeringId}
              required
              hint="Shown on the administering clinician's own Administer dialog. The token is bound to them and to this order."
              onChange={(e) => setAdministeringId(e.target.value)}
            />
          </>
        ) : (
          <div style={tokenBox}>
            <span style={legend}>Read this to the administering clinician</span>
            <code style={tokenText}>{token}</code>
            <span
              style={{ ...meta, color: secondsLeft > 10 ? t.onSurfaceVariant : t.error }}
              className="tabular-nums"
            >
              {secondsLeft > 0
                ? `Expires in ${secondsLeft}s · single use`
                : "Expired — mint a new one."}
            </span>
          </div>
        )}

        {error ? (
          <p role="alert" style={alert}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <Button tone="secondary" onClick={onClose} disabled={busy}>
            {token === null ? "Cancel" : "Done"}
          </Button>
          {token === null || secondsLeft <= 0 ? (
            <Button
              tone="danger"
              disabled={busy || orderId.trim().length === 0 || administeringId.trim().length === 0}
              loading={busy}
              onClick={() => void mint()}
            >
              {token === null ? "Mint attestation" : "Mint a new one"}
            </Button>
          ) : null}
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
const meta: CSSProperties = { fontSize: "0.78rem", color: t.onSurfaceVariant, margin: 0 };
const tokenBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
  background: t.surfaceLow,
  borderRadius: t.radiusLg,
  padding: "0.875rem 1rem",
};
const legend: CSSProperties = {
  fontSize: "0.6875rem",
  fontWeight: 600,
  color: t.muted,
};
const tokenText: CSSProperties = {
  fontFamily: t.fontMono,
  fontSize: "0.8rem",
  color: t.onSurface,
  wordBreak: "break-all",
};
const alert: CSSProperties = { fontSize: "0.8rem", color: t.error, margin: 0 };
