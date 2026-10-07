import { describe, expect, it } from "vitest";
import { activeEntryKey, buildPrimaryNav } from "./primary-nav";

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
});
