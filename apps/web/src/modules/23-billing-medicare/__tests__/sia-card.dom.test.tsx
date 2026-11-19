import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaimEditor } from "../claim-editor";
import { SiaCard } from "../sia-card";
import type { SiaPricing, SiaVisit } from "../sia-card-model";

const visit = (over: Partial<SiaVisit> = {}): SiaVisit => ({
  id: "11111111-1111-4111-8111-111111111111",
  date: "2026-09-28",
  discipline: "rn",
  minutes: 75,
  timeSource: "evv",
  units: 5,
  paidUnits: 5,
  counted: true,
  reason: null,
  ...over,
});

const unitsSia = (over: Partial<SiaPricing> = {}): SiaPricing => ({
  basis: "units_v2",
  revision: 1,
  windowStart: "2026-09-24",
  windowEnd: "2026-09-30",
  paidUnits: 5,
  eligibleUnits: 6,
  truncatedUnits: 1,
  chcHourlyRateCents: 4_800,
  wageIndexFiscalYear: 2026,
  amountCents: 6_000,
  totalQualifyingMinutes: 75,
  calculatedAt: "2026-10-02T14:30:00.000Z",
  policy: {
    unitTieBreak: "up",
    videoEligible: false,
    visitDating: "service_date",
    wageBasis: "chc_labor_share",
  },
  visits: [visit()],
  priorClaimAdvisory: null,
  ...over,
});

const legacySia = (): SiaPricing =>
  unitsSia({
    basis: "minutes_v1",
    paidUnits: null,
    eligibleUnits: null,
    truncatedUnits: null,
    chcHourlyRateCents: null,
    wageIndexFiscalYear: null,
    amountCents: 7_200,
    totalQualifyingMinutes: 90,
    policy: null,
    visits: [],
  });

const HEADING = "Service Intensity Add-on (SIA)";

describe("SiaCard: no SIA", () => {
  it("says there is no add-on and shows no table", () => {
    render(<SiaCard sia={null} />);
    expect(screen.getByRole("heading", { name: HEADING })).toBeInTheDocument();
    expect(screen.getByText("No SIA add-on for this claim.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("SiaCard: legacy minutes basis", () => {
  it("keeps the old summary and explains why there is no per-visit detail", () => {
    render(<SiaCard sia={legacySia()} />);
    expect(screen.getByText("2026-09-24 → 2026-09-30")).toBeInTheDocument();
    expect(screen.getByText("90")).toBeInTheDocument();
    expect(screen.getByText("$72.00")).toBeInTheDocument();
    expect(screen.getByText(/earlier minutes-based method/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("warns that the dollar amount came from the earlier method and may not match what Medicare pays", () => {
    render(<SiaCard sia={legacySia()} />);
    expect(
      screen.getByText(/came from the earlier method and may not match the units-based amount/i),
    ).toBeInTheDocument();
  });

  it("does not put that caveat on a units-based card", () => {
    render(<SiaCard sia={unitsSia()} />);
    expect(screen.queryByText(/earlier method/i)).not.toBeInTheDocument();
  });
});

describe("SiaCard: units basis", () => {
  it("shows units x CHC hourly rate / 4 as dollars", () => {
    render(<SiaCard sia={unitsSia()} />);
    expect(screen.getByText("5 units × $48.00 per hour ÷ 4 = $60.00")).toBeInTheDocument();
    expect(screen.getByText(/wage index FY2026/)).toBeInTheDocument();
  });

  it("states paid, eligible and truncated units", () => {
    render(<SiaCard sia={unitsSia()} />);
    expect(
      screen.getByText("5 units paid of 6 eligible; 1 unit over the 16-unit daily cap."),
    ).toBeInTheDocument();
  });

  it("does not mention a cap when nothing was truncated", () => {
    render(<SiaCard sia={unitsSia({ eligibleUnits: 5, truncatedUnits: 0 })} />);
    expect(screen.getByText("5 units paid of 5 eligible.")).toBeInTheDocument();
  });

  it("flags a later revision", () => {
    render(<SiaCard sia={unitsSia({ revision: 3 })} />);
    expect(screen.getByText("Revision 3")).toBeInTheDocument();
  });

  it("lists each visit with date, discipline, minutes, units and whether it counted", () => {
    const sia = unitsSia({
      visits: [
        visit({
          id: "a",
          date: "2026-09-28",
          discipline: "rn",
          minutes: 75,
          timeSource: null,
          units: 5,
          paidUnits: 5,
        }),
        visit({
          id: "b",
          date: "2026-09-29",
          discipline: "msw",
          minutes: null,
          units: null,
          paidUnits: 0,
          counted: false,
          reason: "no_documented_time",
        }),
      ],
    });
    render(<SiaCard sia={sia} />);
    const table = screen.getByRole("table", { name: "SIA visits in the last 7 days" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const [, counted, excluded] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(counted).getByText("2026-09-28")).toBeInTheDocument();
    expect(within(counted).getByText("RN")).toBeInTheDocument();
    expect(within(counted).getByText("75")).toBeInTheDocument();
    expect(within(counted).getByText("Counted")).toBeInTheDocument();
    expect(within(excluded).getByText("MSW")).toBeInTheDocument();
    expect(within(excluded).getByText("Excluded")).toBeInTheDocument();
    expect(within(excluded).getByText("No documented start/stop time")).toBeInTheDocument();
  });

  it("shows when a counted visit was only partly paid because of the daily cap", () => {
    render(<SiaCard sia={unitsSia({ visits: [visit({ units: 8, paidUnits: 5 })] })} />);
    expect(screen.getByText("5 of 8 units paid (daily cap)")).toBeInTheDocument();
  });

  it("explains a zero add-on instead of showing a $0.00 equation", () => {
    const sia = unitsSia({
      paidUnits: 0,
      eligibleUnits: 0,
      truncatedUnits: 0,
      amountCents: 0,
      totalQualifyingMinutes: 0,
      visits: [
        visit({ counted: false, units: null, paidUnits: 0, reason: "modality_unconfirmed" }),
      ],
    });
    render(<SiaCard sia={sia} />);
    expect(
      screen.getByText("No units are payable on this claim. The visits below show why."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/per hour ÷ 4/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Visit delivery mode not confirmed by the clinician"),
    ).toBeInTheDocument();
  });

  const zeroPaid = (over: Partial<SiaPricing> = {}): SiaPricing =>
    unitsSia({
      paidUnits: 0,
      eligibleUnits: 0,
      truncatedUnits: 0,
      amountCents: 0,
      totalQualifyingMinutes: 0,
      ...over,
    });

  it("says no units are payable without pointing at visits that are not there", () => {
    render(<SiaCard sia={zeroPaid({ visits: [] })} />);
    expect(screen.getByText("No units are payable on this claim.")).toBeInTheDocument();
    expect(screen.queryByText(/below/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("does not claim 'no visit counted' when visits qualified but belong to the prior month's claim", () => {
    const advisory = { from: "2026-09-28", to: "2026-09-30", units: 7, cents: 8_400 };
    render(<SiaCard sia={zeroPaid({ visits: [visit()], priorClaimAdvisory: advisory })} />);
    expect(screen.queryByText(/no visit counted/i)).not.toBeInTheDocument();
    expect(screen.getByText(/No units are payable on this claim\./)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Medicare adjusts the prior month's claim",
    );
  });

  it("shows whole minutes as they are and a fractional EVV bracket to one decimal", () => {
    const sia = unitsSia({
      visits: [
        visit({ id: "whole", date: "2026-09-27", minutes: 75, timeSource: null }),
        visit({ id: "fractional", date: "2026-09-28", minutes: 12.333_333_3, timeSource: null }),
      ],
    });
    render(<SiaCard sia={sia} />);
    const rows = within(screen.getByRole("table", { name: "SIA visits in the last 7 days" }))
      .getAllByRole("row")
      .slice(1) as [HTMLElement, HTMLElement];
    const [whole, fractional] = rows;
    expect(within(whole).getByText("75")).toBeInTheDocument();
    expect(within(fractional).getByText("12.3")).toBeInTheDocument();
  });

  it("marks minutes a clinician typed (and EVV ones), so a reviewer can see which units rest on typed times", () => {
    const sia = unitsSia({
      visits: [
        visit({ id: "typed", date: "2026-09-27", minutes: 75, timeSource: "clinician" }),
        visit({ id: "evv", date: "2026-09-28", minutes: 30, timeSource: "evv" }),
      ],
    });
    render(<SiaCard sia={sia} />);
    const rows = within(screen.getByRole("table", { name: "SIA visits in the last 7 days" }))
      .getAllByRole("row")
      .slice(1) as [HTMLElement, HTMLElement];
    const [typed, evv] = rows;
    expect(within(typed).getByText("75 (typed)")).toBeInTheDocument();
    expect(within(evv).getByText("30 (EVV)")).toBeInTheDocument();
  });

  it("keeps the visit date as plain text when the claim's patient is not known", () => {
    render(<SiaCard sia={unitsSia()} />);
    expect(screen.getByText("2026-09-28")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("links each visit's date to its encounter when the claim's patient is known", () => {
    const sia = unitsSia({
      visits: [
        visit({ id: "enc-a", date: "2026-09-28" }),
        visit({ id: "enc-b", date: "2026-09-29" }),
      ],
    });
    render(
      <MemoryRouter>
        <SiaCard sia={sia} patientId="patient-1" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "2026-09-28" })).toHaveAttribute(
      "href",
      "/patients/patient-1/encounters/enc-a",
    );
    expect(screen.getByRole("link", { name: "2026-09-29" })).toHaveAttribute(
      "href",
      "/patients/patient-1/encounters/enc-b",
    );
  });

  // Keep in step with SiaExclusionReason (packages/billing/src/sia/sia-units.ts): every code has plain language.
  const REASONS: ReadonlyArray<readonly [string, string]> = [
    ["outside_claim_window", "Outside this claim's service dates"],
    ["ineligible_discipline", "Only RN and social work visits count"],
    ["awaiting_cosignature", "Waiting for a co-signature"],
    ["not_billable", "Visit is not billable"],
    ["modality_telephonic", "Phone visit"],
    ["non_visit_encounter", "Not an in-person patient visit"],
    ["post_mortem", "Visit after the patient died"],
    ["pm_modifier", "Billed with the post-mortem (PM) modifier"],
    ["modality_unconfirmed", "Visit delivery mode not confirmed by the clinician"],
    ["modality_video", "Video visit (not counted under the current policy)"],
    ["no_documented_time", "No documented start/stop time"],
    ["non_rhc_day", "Not a routine home care day"],
    ["over_daily_cap", "Over the 16-unit daily cap"],
  ];

  it.each(REASONS)("explains %s in plain language", (code, text) => {
    const sia = unitsSia({
      visits: [visit({ counted: false, units: null, paidUnits: 0, reason: code })],
    });
    render(<SiaCard sia={sia} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText(code)).not.toBeInTheDocument();
  });

  it("falls back to a generic line for a reason this screen does not know", () => {
    const sia = unitsSia({
      visits: [visit({ counted: false, units: null, paidUnits: 0, reason: "some_future_reason" })],
    });
    render(<SiaCard sia={sia} />);
    expect(screen.getByText("Not counted for another reason")).toBeInTheDocument();
    expect(screen.queryByText("some_future_reason")).not.toBeInTheDocument();
  });

  it("shows the prior-claim banner when death fell in the first 7 days of the month", () => {
    const advisory = { from: "2026-09-28", to: "2026-09-30", units: 7, cents: 8_400 };
    render(<SiaCard sia={unitsSia({ priorClaimAdvisory: advisory })} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(
      "Death fell in the first 7 days of the month: Medicare adjusts the prior month's claim for the add-on; nothing to submit here.",
    );
    expect(banner).toHaveTextContent("7 units");
    expect(banner).toHaveTextContent("$84.00");
    expect(banner).toHaveTextContent("2026-09-28 → 2026-09-30");
  });

  it("says the prior-claim units are not priced (never $0.00) when the death year's rate was unavailable", () => {
    const advisory = { from: "2026-09-28", to: "2026-09-30", units: 7, cents: null };
    render(<SiaCard sia={unitsSia({ priorClaimAdvisory: advisory })} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("7 units");
    expect(banner).toHaveTextContent("not priced");
    expect(banner).not.toHaveTextContent("$");
  });

  it("shows no banner without an advisory", () => {
    render(<SiaCard sia={unitsSia()} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("SiaCard: width on the pricing row", () => {
  const cardOf = (): HTMLElement => screen.getByRole("region", { name: HEADING });

  it("takes the whole row when it carries a visit table, so no column is pushed out of view", () => {
    render(
      <MemoryRouter>
        <SiaCard sia={unitsSia()} patientId="patient-1" />
      </MemoryRouter>,
    );
    expect(cardOf().style.flex).toBe("1 1 100%");
  });

  const withoutVisitTable: ReadonlyArray<readonly [string, SiaPricing | null]> = [
    ["no SIA", null],
    ["a minutes-based calculation", legacySia()],
    ["a units calculation with no visits", unitsSia({ visits: [] })],
  ];
  it.each(withoutVisitTable)("shares the row with the per-diem card for %s", (_label, sia) => {
    render(<SiaCard sia={sia} />);
    expect(cardOf().style.flex).toBe("1 1 16rem");
  });
});

describe("ClaimEditor: the SIA card", () => {
  const CLAIM = "c1c1c1c1-0000-4000-8000-000000000001";
  const ok = (data: unknown) => ({ data, error: undefined, response: new Response(null) });
  afterEach(() => window.history.pushState({}, "", "/"));

  it("renders the card from the claim's pricing.sia and links each visit to its patient's encounter", async () => {
    window.history.pushState({}, "", `/billing/claims/${CLAIM}`);
    const claim = {
      claimId: CLAIM,
      providerEntityId: "pe-1",
      patientId: "patient-1",
      admissionId: "a1a1a1a1-0000-4000-8000-000000000001",
      tob: "812",
      state: "ready",
      serviceFrom: "2026-09-01",
      serviceTo: "2026-09-30",
      claimControlNumber: "CCN-1",
      payerClaimControlNumber: null,
      macJurisdiction: "ngs_j6",
      totalChargeCents: 100,
      totalExpectedPaymentCents: 90,
      version: 1,
      sequestrationAppliedPct: "2.0",
      sequestrationPolicyId: "sp-1",
      replacesClaimId: null,
      replacedByClaimId: null,
      replacementReason: null,
      latestValidation: null,
      pricing: {
        perDiemClass: null,
        sia: unitsSia({ visits: [visit({ id: "enc-a", date: "2026-09-28" })] }),
      },
      attention: null,
    };
    const GET = vi.fn(async (path: string) =>
      path === "/api/v1/billing/claims/{id}" ? ok(claim) : ok([]),
    );
    render(
      <ApiClientProvider client={{ GET, POST: vi.fn() } as unknown as ApiClient}>
        <MemoryRouter initialEntries={[`/billing/claims/${CLAIM}`]}>
          <Routes>
            <Route path="/billing/claims/:claimId" element={<ClaimEditor />} />
          </Routes>
        </MemoryRouter>
      </ApiClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: HEADING })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2026-09-28" })).toHaveAttribute(
      "href",
      "/patients/patient-1/encounters/enc-a",
    );
  });
});
