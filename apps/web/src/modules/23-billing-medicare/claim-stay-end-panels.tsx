import { useApiClient } from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — the claim editor's rail panels for how the stay ended: the guided
// "missing discharge details" panel and the Type of Bill panel with its remedy action (re-run validation for an
// unsubmitted claim; open the TOB-817 replacement ceremony for an accepted / paid one). Split from claim-editor.tsx
// to keep that file within the size budget; the panels themselves live in discharge-attention.tsx.
import { type JSX, useState } from "react";
import {
  type ClaimAttention,
  MissingDischargeDetailsPanel,
  TypeOfBillPanel,
} from "./discharge-attention";

export function ClaimStayEndPanels({
  claim,
  canReplace,
  onReplace,
  onRevalidated,
}: {
  claim: { claimId: string; tob: string; state: string; attention?: ClaimAttention | null };
  canReplace: boolean;
  onReplace: () => void;
  onRevalidated: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = claim.attention?.missingDischargeDetail ?? null;
  const t = claim.attention?.typeOfBill;
  const remedy = t?.changed ? t.remedy : null;

  // A validation run re-types an unsubmitted claim (claim-validation-service `refreshedTypeOfBill`).
  const revalidate = async () => {
    setBusy(true);
    setError(null);
    try {
      const { error: err } = (await client.POST("/api/v1/claims/{id}/validate", {
        params: { path: { id: claim.claimId } },
      } as never)) as { error?: unknown };
      if (err) {
        setError("Re-validation could not be started — try again shortly.");
        return;
      }
      onRevalidated();
    } catch {
      setError("Re-validation could not be started — check your connection.");
    } finally {
      setBusy(false);
    }
  };

  const action =
    remedy === "revalidate" ? (
      <button
        type="button"
        className="wx-btn-secondary"
        disabled={busy}
        onClick={() => void revalidate()}
      >
        {busy ? "Re-validating…" : "Re-run validation"}
      </button>
    ) : remedy === "replace" && canReplace ? (
      <button type="button" className="wx-btn-secondary" onClick={onReplace}>
        Build replacement claim (TOB 817)
      </button>
    ) : null;

  return (
    <>
      {missing ? (
        <MissingDischargeDetailsPanel
          detail={missing.detail}
          admissionId={missing.admissionId}
          claimId={claim.claimId}
          fixPath={missing.fixPath}
        />
      ) : null}
      <TypeOfBillPanel
        tob={claim.tob}
        state={claim.state}
        attention={claim.attention}
        action={action}
      />
      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-error)" }}>
          {error}
        </p>
      ) : null}
    </>
  );
}
