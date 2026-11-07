// apps/admin/src/modules/34-saas-platform/onboarding — the vendor change COMMITTED, but the billing service mode the operator chose could
// not be confirmed afterwards (the server retried once). Never a silent success: the operator is told, and sent to the contract to read and
// set the mode if it is not the one chosen.
import { InlineAlert } from "@chartwarden/ui";
import type { JSX } from "react";
import { Link } from "react-router-dom";

export function ModeUnconfirmedNotice({ orgSlug }: { orgSlug: string }): JSX.Element {
  return (
    <InlineAlert tone="warning">
      The clearinghouse was changed, but the billing service mode you chose could not be confirmed
      afterwards. Check it on{" "}
      <Link to={`/tenants/${encodeURIComponent(orgSlug)}/onboarding/plan_contract`}>
        the Plan and contract step
      </Link>{" "}
      and set it if it is not the one you chose.
    </InlineAlert>
  );
}
