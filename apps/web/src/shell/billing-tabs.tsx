// apps/web/src/shell — the Billing area's tab bar (Claims · Remittances · Denials · NOE / NOTR ·
// Transfers (8xC) · DDE queue · Eligibility · Rates · Wage index). The tabs are separate screens owned by M23 and M25, so the bar lives in the shell and
// every one of them renders it: the current tab stays highlighted and Claims is always one click back.
// The current tab is read from the URL (longest matching prefix), so callers just render <BillingTabs />.
import type { JSX } from "react";
import { Link, useLocation } from "react-router-dom";

const TABS: { to: string; label: string; match: string[] }[] = [
  { to: "/billing", label: "Claims", match: ["/billing"] },
  { to: "/remittance", label: "Remittances", match: ["/remittance"] },
  { to: "/remittance/denials", label: "Denials", match: ["/remittance/denials"] },
  { to: "/billing/noe", label: "NOE / NOTR", match: ["/billing/noe", "/billing/notr"] },
  { to: "/billing/transfer-notices", label: "Transfers", match: ["/billing/transfer-notices"] },
  { to: "/billing/dde", label: "DDE queue", match: ["/billing/dde"] },
  { to: "/billing/eligibility", label: "Eligibility", match: ["/billing/eligibility"] },
  { to: "/billing/rate-tables", label: "Rates", match: ["/billing/rate-tables"] },
  { to: "/billing/wage-indexes", label: "Wage index", match: ["/billing/wage-indexes"] },
];

function currentTab(pathname: string): string | null {
  let best: { to: string; len: number } | null = null;
  for (const tab of TABS)
    for (const prefix of tab.match)
      if (pathname === prefix || pathname.startsWith(`${prefix}/`))
        if (!best || prefix.length > best.len) best = { to: tab.to, len: prefix.length };
  return best?.to ?? null;
}

export function BillingTabs(): JSX.Element {
  const current = currentTab(useLocation().pathname);
  return (
    <nav className="wx-subtabs" aria-label="Billing views">
      {TABS.map((tab) =>
        tab.to === current ? (
          <Link key={tab.to} to={tab.to} aria-current="page" className="is-current">
            {tab.label}
          </Link>
        ) : (
          <Link key={tab.to} to={tab.to}>
            {tab.label}
          </Link>
        ),
      )}
    </nav>
  );
}
