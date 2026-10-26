import { describe, expect, it } from "vitest";
import { type NavSectionSpec, activeEntryKey, buildPrimaryNav } from "./primary-nav";

const screen = (path: string, title = path) => ({ id: path, path, title });

describe("buildPrimaryNav", () => {
  it("puts every visible top-level screen under exactly one entry", () => {
    const screens = [
      screen("/patients"),
      screen("/search"),
      screen("/billing"),
      screen("/billing/claims"),
      screen("/billing/eligibility"),
      screen("/medicaid/billing/eligibility"),
      screen("/some/unclaimed/screen"),
      screen("/patients/:id"),
    ];
    const nav = buildPrimaryNav(screens);
    const entries = nav.flatMap((s) => s.entries);
    const placed = entries.flatMap((e) => [
      ...(e.href && e.href !== "/" ? [e.href] : []),
      ...e.children.map((c) => c.path),
    ]);
    for (const s of screens.filter((x) => !x.path.includes(":"))) {
      expect(placed.filter((p) => p === s.path)).toHaveLength(1);
    }
  });

  it("uses the longest matching claim, so Integrations wins over Billing", () => {
    const nav = buildPrimaryNav([screen("/billing"), screen("/billing/mac-credentials")]);
    const byKey = new Map(nav.flatMap((s) => s.entries).map((e) => [e.key, e]));
    expect(byKey.get("integrations")?.href).toBe("/billing/mac-credentials");
    expect(byKey.get("billing")?.href).toBe("/billing");
  });

  it("keeps Eligibility under Billing (it is a Billing tab), Medicare and Medicaid alike", () => {
    const nav = buildPrimaryNav([
      screen("/billing"),
      screen("/billing/eligibility"),
      screen("/medicaid/billing/eligibility"),
    ]);
    const byKey = new Map(nav.flatMap((s) => s.entries).map((e) => [e.key, e]));
    expect(byKey.has("eligibility")).toBe(false);
    expect(byKey.get("billing")?.children.map((c) => c.path)).toEqual(
      expect.arrayContaining(["/billing/eligibility", "/medicaid/billing/eligibility"]),
    );
    expect(activeEntryKey(nav, "/billing/eligibility")).toBe("billing");
  });

  it("files the commercial billing lane under Billing, not under Administration", () => {
    const nav = buildPrimaryNav([
      screen("/billing"),
      screen("/commercial/billing/claims"),
      screen("/commercial/billing/payers"),
    ]);
    const byKey = new Map(nav.flatMap((s) => s.entries).map((e) => [e.key, e]));
    expect(byKey.get("billing")?.children.map((c) => c.path)).toEqual(
      expect.arrayContaining(["/commercial/billing/claims", "/commercial/billing/payers"]),
    );
    expect(activeEntryKey(nav, "/commercial/billing/payers")).toBe("billing");
  });

  it("drops entries the actor cannot reach but always keeps Home", () => {
    const nav = buildPrimaryNav([screen("/patients")]);
    const keys = nav.flatMap((s) => s.entries).map((e) => e.key);
    expect(keys).toEqual(["home", "patients"]);
  });

  it("files referrals and Intake review under Admissions (Pending Referrals is its tab), not Documents", () => {
    const nav = buildPrimaryNav([
      screen("/admissions"),
      screen("/referrals"),
      screen("/documents"),
      screen("/intake"),
    ]);
    const byKey = new Map(nav.flatMap((s) => s.entries).map((e) => [e.key, e]));
    expect(byKey.get("admissions")?.children.map((c) => c.path)).toEqual(
      expect.arrayContaining(["/referrals", "/intake"]),
    );
    expect(byKey.has("referrals")).toBe(false);
    expect(byKey.get("documents")?.children.map((c) => c.path) ?? []).not.toContain("/intake");
    expect(activeEntryKey(nav, "/intake/abc/review")).toBe("admissions");
    expect(activeEntryKey(nav, "/referrals")).toBe("admissions");
    expect(activeEntryKey(nav, "/referrals/r-1")).toBe("admissions");
  });

  it("groups the Admissions submenu: admission pages, then referral pages, then IPU", () => {
    const nav = buildPrimaryNav([
      screen("/referrals"),
      screen("/referrals/new"),
      screen("/admissions/discharges"),
      screen("/admissions"),
      screen("/ipu/units"),
      screen("/compliance/admissions"),
      screen("/admissions/new"),
      screen("/admissions/readmit"),
      screen("/intake"),
    ]);
    const admissions = nav.flatMap((s) => s.entries).find((e) => e.key === "admissions");
    expect(admissions?.children.map((c) => c.path)).toEqual([
      "/admissions/new",
      // The Discharge / transfer hub sits right below New admission, whatever the registration order.
      "/admissions/discharges",
      // Readmit — the readmission candidates list — right after Discharge / transfer.
      "/admissions/readmit",
      "/compliance/admissions",
      "/referrals",
      "/referrals/new",
      "/intake",
      "/ipu/units",
    ]);
  });

  it("marks the owning entry current for nested patient routes", () => {
    const nav = buildPrimaryNav([screen("/patients"), screen("/hope")]);
    expect(activeEntryKey(nav, "/patients/abc/care-plan")).toBe("patients");
    expect(activeEntryKey(nav, "/hope")).toBe("assessments");
    expect(activeEntryKey(nav, "/")).toBe("home");
  });

  it("keeps on-call triage and field safety under Visits, with the page's own row as the child (#637)", () => {
    const nav = buildPrimaryNav([
      screen("/me/visits"),
      screen("/triage/intake"),
      screen("/safety/incidents/new"),
      screen("/me/oncall"),
    ]);
    for (const path of ["/triage/intake", "/safety/incidents/new", "/me/oncall"]) {
      expect(activeEntryKey(nav, path)).toBe("visits");
    }
    const visits = nav.flatMap((g) => g.entries).find((e) => e.key === "visits");
    expect(visits?.children.map((c) => c.path)).toEqual(
      expect.arrayContaining(["/triage/intake", "/safety/incidents/new", "/me/oncall"]),
    );
  });

  describe("Billing sub-sections", () => {
    const billingPaths = [
      "/billing",
      "/billing/claims",
      "/billing/eligibility",
      "/billing/mac-credentials",
      "/cap",
      "/platform/cap/constants",
      "/cost-reports",
      "/medicaid/billing/claims",
      "/medicaid/billing/trading-partner-credentials",
      "/remittance",
      "/remittance/denials",
      "/remittance/appeals",
      "/remittance/adrs",
      "/remittance/audits",
      "/remittance/tpe",
      "/remittance/report",
      "/commercial/billing/claims",
      "/commercial/billing/claims/new",
      "/commercial/billing/authorizations",
      "/commercial/billing/enrollments",
      "/commercial/billing/eligibility",
      "/admin/billing-audit",
    ];
    const billing = () =>
      buildPrimaryNav(billingPaths.map((p) => screen(p)))
        .flatMap((s) => s.entries)
        .find((e) => e.key === "billing");
    const subPaths = (key: string) =>
      billing()
        ?.subsections?.find((x) => x.key === key)
        ?.screens.map((x) => x.path);

    it("splits Billing into Medicare, Medicaid, Commercial and All payers", () => {
      expect(billing()?.subsections?.map((x) => x.label)).toEqual([
        "Medicare",
        "Medicaid",
        "Commercial",
        "All payers",
      ]);
      expect(subPaths("medicaid")).toEqual(["/medicaid/billing/claims"]);
      expect(subPaths("commercial")).toEqual([
        "/commercial/billing/claims",
        "/commercial/billing/claims/new",
        "/commercial/billing/authorizations",
        "/commercial/billing/enrollments",
        "/commercial/billing/eligibility",
      ]);
    });

    it("puts the Medicare-only review chain, cap and cost reports in Medicare; shared M25 screens in All payers", () => {
      expect(subPaths("medicare")).toEqual(
        expect.arrayContaining([
          "/billing",
          "/billing/claims",
          "/billing/eligibility",
          "/remittance/adrs",
          "/remittance/audits",
          "/remittance/tpe",
          "/remittance/report",
          "/cap",
          "/platform/cap/constants",
          "/cost-reports",
        ]),
      );
      expect(subPaths("all-payers")).toEqual(
        expect.arrayContaining(["/remittance", "/remittance/denials", "/remittance/appeals"]),
      );
      expect(subPaths("all-payers")).not.toContain("/remittance/adrs");
    });

    it("keeps credentials in Integrations and surveyor views in Audit Log, never in Billing", () => {
      const nav = buildPrimaryNav(billingPaths.map((p) => screen(p)));
      const byKey = new Map(nav.flatMap((s) => s.entries).map((e) => [e.key, e]));
      const billingPlaced = byKey.get("billing")?.screens.map((x) => x.path) ?? [];
      for (const p of [
        "/billing/mac-credentials",
        "/medicaid/billing/trading-partner-credentials",
        "/admin/billing-audit",
      ]) {
        expect(billingPlaced).not.toContain(p);
      }
      expect(byKey.get("integrations")?.screens.map((x) => x.path)).toEqual(
        expect.arrayContaining(["/billing/mac-credentials"]),
      );
      expect(byKey.get("audit-log")?.screens.map((x) => x.path)).toContain("/admin/billing-audit");
      expect(activeEntryKey(nav, "/admin/medicaid-billing-audit")).toBe("audit-log");
    });

    it("places every screen under exactly one entry and one subsection, one entry active", () => {
      const nav = buildPrimaryNav(billingPaths.map((p) => screen(p)));
      const placed = nav.flatMap((s) => s.entries).flatMap((e) => e.screens.map((x) => x.path));
      for (const p of billingPaths) expect(placed.filter((x) => x === p)).toHaveLength(1);
      const inSubs = billing()?.subsections?.flatMap((x) => x.screens.map((y) => y.path)) ?? [];
      expect(new Set(inSubs).size).toBe(inSubs.length);
      expect(activeEntryKey(nav, "/remittance/adrs")).toBe("billing");
      expect(activeEntryKey(nav, "/remittance/denials")).toBe("billing");
      expect(activeEntryKey(nav, "/cost-reports/workspace")).toBe("billing");
    });

    it("drops a subsection with no visible screens", () => {
      const nav = buildPrimaryNav([screen("/billing"), screen("/remittance")]);
      const b = nav.flatMap((s) => s.entries).find((e) => e.key === "billing");
      expect(b?.subsections?.map((x) => x.key)).toEqual(["medicare", "all-payers"]);
    });
  });

  describe("borrow", () => {
    const spec: NavSectionSpec[] = [
      {
        entries: [
          { key: "home", label: "Home", icon: "home", to: "/", claims: [] },
          {
            key: "a",
            label: "A",
            icon: "home",
            to: "/a",
            claims: ["/a"],
            borrow: [{ path: "/b/x", label: "B x (borrowed)" }, { path: "/nope" }],
            subsections: [
              {
                key: "s",
                label: "S",
                claims: ["/a/s"],
                borrow: [{ path: "/b/y" }, { path: "/a/s/own" }],
              },
            ],
          },
          { key: "b", label: "B", icon: "home", to: "/b", claims: ["/b"] },
        ],
      },
    ];
    const nav = buildPrimaryNav(
      ["/a", "/a/s/own", "/b", "/b/x", "/b/y"].map((p) => screen(p)),
      spec,
    );
    const byKey = new Map(nav.flatMap((s) => s.entries).map((e) => [e.key, e]));

    it("lists borrowed links under the host without taking ownership", () => {
      expect(byKey.get("a")?.borrowed?.map((x) => [x.path, x.title])).toEqual([
        ["/b/x", "B x (borrowed)"],
      ]);
      expect(byKey.get("a")?.subsections?.[0]?.borrowed.map((x) => x.path)).toEqual(["/b/y"]);
      expect(byKey.get("a")?.screens.map((x) => x.path)).not.toContain("/b/x");
      expect(byKey.get("b")?.screens.map((x) => x.path)).toEqual(["/b", "/b/x", "/b/y"]);
    });

    it("keeps the active highlight on the owner", () => {
      expect(activeEntryKey(nav, "/b/x")).toBe("b");
    });
  });
});
