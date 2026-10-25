// apps/web/src/shell — the Medicaid billing navigation (M24): Overview · Work Queue · Claims · Compliance · Tools, with
// the views of the current area on a second row. Medicaid keeps its own sources, permissions and screens, so it has its
// own bar rather than a payer toggle on the Medicare one. Every Medicaid billing screen renders <MedicaidBillingTabs />.
import type { JSX } from "react";
import { AreaNav, type NavArea } from "./area-nav";

const HOME = "/medicaid/billing/ar-dashboard";

export const MEDICAID_AREAS: NavArea[] = [
  // Other Medicaid billing screens fall back to Overview (the shortest prefix).
  { label: "Overview", to: HOME, match: ["/medicaid/billing"], views: [] },
  {
    label: "Work Queue",
    views: [
      {
        to: "/medicaid/billing/validation-worklist",
        label: "Blocked claims",
        match: ["/medicaid/billing/validation-worklist"],
      },
    ],
  },
  {
    label: "Claims",
    to: "/medicaid/billing/claims",
    match: ["/medicaid/billing/claims"],
    views: [],
  },
  {
    label: "Compliance",
    views: [
      {
        to: "/medicaid/billing/rule-config",
        label: "Rules",
        match: ["/medicaid/billing/rule-config"],
      },
      {
        to: "/medicaid/billing/override-audit",
        label: "Override audit",
        match: ["/medicaid/billing/override-audit"],
      },
    ],
  },
  {
    label: "Tools",
    views: [
      {
        to: "/medicaid/billing/eligibility",
        label: "Eligibility",
        match: ["/medicaid/billing/eligibility"],
      },
      {
        to: "/medicaid/billing/trading-partner-credentials",
        label: "Trading partners",
        match: ["/medicaid/billing/trading-partner-credentials"],
      },
      {
        to: "/medicaid/billing/rb-arrangements",
        label: "Room & board",
        match: ["/medicaid/billing/rb-arrangements"],
      },
      { to: "/medicaid/billing/metrics", label: "Metrics", match: ["/medicaid/billing/metrics"] },
    ],
  },
];

export function MedicaidBillingTabs(): JSX.Element {
  return <AreaNav areas={MEDICAID_AREAS} label="Medicaid billing areas" home={HOME} />;
}
