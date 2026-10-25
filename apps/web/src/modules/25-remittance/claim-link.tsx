// apps/web/src/modules/25-remittance — a claim reference on a denial / ADR / appeal panel: a link to the claim page
// instead of a raw UUID. The panels carry the claim id only (no control number), so the link says what it opens; the
// id stays in the URL for support, not in the text. A record with no claim keeps its "None linked" wording.
import type { JSX } from "react";
import { Link } from "react-router-dom";

export function ClaimLink({
  claimId,
}: { claimId: string | null | undefined }): JSX.Element | string {
  if (!claimId) return "None linked";
  return (
    <Link
      to={`/billing/claims/${encodeURIComponent(claimId)}`}
      style={{ color: "var(--color-primary)", textDecoration: "underline" }}
    >
      Open claim
    </Link>
  );
}
