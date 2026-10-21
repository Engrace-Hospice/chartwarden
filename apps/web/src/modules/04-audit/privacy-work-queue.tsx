// apps/web/src/modules/04-audit — HIPAA privacy work queue (GAP-012; WARDENX_UI_HIPAA_PRIVACY_DISCLOSURE).
// The staff surface for the individual-rights obligations that already have backend routes:
//   · Amendment requests (§164.526, 60-day clock): list pending, accept / deny (denial reason required).
//   · Accounting of disclosures (§164.528): GET /api/v1/audit/patients/:patientId/accounting.
//   · Access report ("who touched this chart"): GET /api/v1/audit/patients/:patientId/access.
// The pending-amendments list is `GET /api/v1/amendments?status=pending` (M5, patient.amend_review).
import { EmptyState, PageHeader, WorkQueueLayout } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import { AmendmentInbox } from "./privacy-amendment-inbox";
import { AccessReport, AccountingReport } from "./privacy-patient-reports";

type Tab = "amendments" | "accounting" | "access";

const AMEND_PERMISSION = "patient.amend_review";

interface TabDef {
  id: Tab;
  label: string;
  permission: string | null;
}

const TABS: readonly TabDef[] = [
  { id: "amendments", label: "Amendment requests", permission: AMEND_PERMISSION },
  { id: "accounting", label: "Accounting of disclosures", permission: "audit.disclosure_report" },
  { id: "access", label: "Access report", permission: "audit.read" },
];

export function PrivacyWorkQueue(): JSX.Element {
  const session = useSession();
  const can = (permission: string | null): boolean =>
    permission === null || (session?.permissions?.includes(permission) ?? false);
  const visible = TABS.filter((t) => can(t.permission));
  const [chosen, setChosen] = useState<Tab | null>(null);
  const active = visible.find((t) => t.id === chosen) ?? visible[0] ?? null;

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Privacy Requests" breadcrumb="Compliance / HIPAA">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Work patient amendment requests (§164.526) and produce the accounting of disclosures
            (§164.528) and chart access history.
          </div>
        </PageHeader>
      }
      filters={
        <div style={{ padding: "0 1.5rem 0.75rem" }}>
          <div className="wx-subtabs wx-subtabs-inline" role="tablist">
            {visible.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active?.id === t.id}
                onClick={() => setChosen(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      }
      table={
        <div style={{ padding: "0 1.5rem 1.5rem" }}>
          {active?.id === "amendments" ? <AmendmentInbox /> : null}
          {active?.id === "accounting" ? <AccountingReport /> : null}
          {active?.id === "access" ? <AccessReport /> : null}
          {active === null ? (
            <EmptyState
              title="No privacy requests available"
              description="Your role does not include any privacy-request permissions."
            />
          ) : null}
        </div>
      }
      detail={null}
      fullPageScroll
    />
  );
}
