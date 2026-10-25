// apps/web/src/shell — the Billing area's navigation: Overview · Work Queue · Claims · Revenue Cycle · Tools, with the
// views inside the current area on a second row (Work Queue: NOE / NOTR · Transfers · DDE queue; Claims: Medicare ·
// Commercial; Revenue Cycle: Remittances · Denials · ADR requests · Audits · Appeals; Tools: Eligibility · Rates · Wage index). The views are separate
// screens owned by M23, M25 and M41, so the bar lives in the shell and every one of them renders it.
// The current area and view are read from the URL (longest matching prefix), so callers just render <BillingTabs />.
import type { JSX } from "react";
import { AreaNav, type NavArea } from "./area-nav";

const AREAS: NavArea[] = [
  { label: "Overview", to: "/billing", match: ["/billing"], views: [] },
  {
    label: "Work Queue",
    views: [
      { to: "/billing/queue", label: "All work", match: ["/billing/queue"] },
      { to: "/billing/noe", label: "NOE / NOTR", match: ["/billing/noe", "/billing/notr"] },
      { to: "/billing/transfer-notices", label: "Transfers", match: ["/billing/transfer-notices"] },
      { to: "/billing/dde", label: "DDE queue", match: ["/billing/dde"] },
    ],
  },
  {
    label: "Claims",
    views: [
      { to: "/billing/claims", label: "Medicare", match: ["/billing/claims"] },
      { to: "/commercial/billing/claims", label: "Commercial", match: ["/commercial/billing"] },
    ],
  },
  {
    label: "Revenue Cycle",
    views: [
      { to: "/remittance", label: "Remittances", match: ["/remittance"] },
      { to: "/remittance/denials", label: "Denials", match: ["/remittance/denials"] },
      { to: "/remittance/adrs", label: "ADR requests", match: ["/remittance/adrs"] },
      { to: "/remittance/audits", label: "Audits", match: ["/remittance/audits"] },
      { to: "/remittance/appeals", label: "Appeals", match: ["/remittance/appeals"] },
    ],
  },
  {
    label: "Tools",
    views: [
      { to: "/billing/eligibility", label: "Eligibility", match: ["/billing/eligibility"] },
      { to: "/billing/rate-tables", label: "Rates", match: ["/billing/rate-tables"] },
      { to: "/billing/wage-indexes", label: "Wage index", match: ["/billing/wage-indexes"] },
    ],
  },
];

export function BillingTabs(): JSX.Element {
  return <AreaNav areas={AREAS} label="Billing areas" home="/billing" />;
}
