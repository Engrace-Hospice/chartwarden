import { describe, expect, it } from "vitest";
import { resolveBreadcrumbs } from "./breadcrumb-navigation";
import { buildPrimaryNav } from "./primary-nav";
import type { WebScreenDescriptor } from "./screen-registry";

const paths = [
  ["/patients", "Patients"],
  ["/patients/:id", "Patient Chart"],
  ["/patients/:id/privacy", "Privacy restrictions"],
  ["/admissions", "Admissions"],
  ["/admissions/new", "New admission"],
  ["/admissions/discharges", "Discharge / transfer"],
  ["/discharges/:id/cosign", "Cosign"],
  ["/referrals", "Referral Inbox"],
  ["/referrals/:id", "Referral"],
] as const;
const screens: WebScreenDescriptor[] = paths.map(([path, title]) => ({
  id: path,
  path,
  title,
  screen: () => null,
}));
const sections = buildPrimaryNav(screens);

describe("route breadcrumbs", () => {
  it("links Direct intake back to the Admissions landing", () => {
    expect(resolveBreadcrumbs("/admissions/new", screens, sections)).toEqual([
      { label: "Admissions", href: "/admissions" },
      { label: "Direct intake" },
    ]);
  });

  it("keeps every real ancestor for a nested patient page", () => {
    expect(resolveBreadcrumbs("/patients/patient-1/privacy", screens, sections)).toEqual([
      { label: "Patients", href: "/patients" },
      { label: "Patient Chart", href: "/patients/patient-1" },
      { label: "Privacy restrictions" },
    ]);
  });

  it("shows a reachable detail route even when it is absent from permission-filtered navigation", () => {
    const visible = screens.filter((screen) => screen.path === "/patients");
    expect(resolveBreadcrumbs("/patients/patient-1/privacy", screens, sections, visible)).toEqual([
      { label: "Patients", href: "/patients" },
      { label: "Patient Chart" },
      { label: "Privacy restrictions" },
    ]);
  });

  it("places a referral detail under its inbox", () => {
    expect(resolveBreadcrumbs("/referrals/ref-1", screens, sections)).toEqual([
      { label: "Admissions", href: "/admissions" },
      { label: "Referral Inbox", href: "/referrals" },
      { label: "Referral" },
    ]);
  });

  it("links a workflow with a separate URL prefix through its real parent", () => {
    expect(resolveBreadcrumbs("/discharges/dis-1/cosign", screens, sections)).toEqual([
      { label: "Admissions", href: "/admissions" },
      { label: "Discharge / transfer", href: "/admissions/discharges" },
      { label: "Cosign" },
    ]);
  });
});
