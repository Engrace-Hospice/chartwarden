import { describe, expect, it } from "vitest";
import { canSeeScreen } from "./actor-session";
import { resolveModuleNavigation } from "./module-navigation";
import { buildPrimaryNav } from "./primary-nav";
import type { Session } from "./session";

const screen = (id: string, path: string, title: string, requiredPermission?: string) => ({
  id,
  path,
  title,
  requiredPermission,
});

const admissions = [
  screen("admission.census", "/admissions", "Admissions", "admission.read"),
  screen("admission.create", "/admissions/new", "New admission", "admission.create"),
  screen("admission.referrals", "/referrals", "Pending Referrals", "referral.read"),
  screen("admission.referral-new", "/referrals/new", "New referral", "referral.create"),
  screen("admission.readmit-list", "/admissions/readmit", "Readmit", "admission.create"),
  screen(
    "admission.discharges",
    "/admissions/discharges",
    "Discharge / transfer",
    "discharge.create",
  ),
  screen("admission.compliance", "/compliance/admissions", "Compliance", "compliance.read"),
  screen("intake.queue", "/intake", "Intake Review", "intake.read"),
];

const scheduling = [
  screen(
    "scheduling.clinician-credentials",
    "/scheduling/clinician-credentials",
    "Clinician Credentials",
    "membership_credential.read",
  ),
  screen("scheduling.calendar", "/calendar", "Calendar"),
  screen("scheduling.day", "/scheduling/day", "Day View", "visit.read_team"),
  screen("scheduling.week", "/scheduling/week", "Week View", "visit.read_team"),
  screen("scheduling.proposals", "/scheduling/proposals", "Proposal Inbox", "visit.proposal.read"),
  screen(
    "scheduling.recurring",
    "/scheduling/recurring",
    "Recurring Policies",
    "recurring_visit.read",
  ),
  screen("scheduling.time-off", "/scheduling/time-off", "Time-Off Queue", "time_off.read_team"),
  screen(
    "scheduling.metrics",
    "/admin/scheduling-metrics",
    "Scheduling Metrics",
    "visit.read_metrics",
  ),
];

const fullSession: Session = {
  userId: "user-1",
  organizationId: "org-1",
  roles: [],
  isAdmin: false,
  permissions: [
    "admission.read",
    "admission.create",
    "referral.read",
    "referral.create",
    "discharge.create",
    "compliance.read",
    "intake.read",
  ],
};

describe("resolveModuleNavigation", () => {
  it("uses the exact curated Admissions order and reuses Pending Referrals as Referral Inbox", () => {
    const visible = admissions.filter((item) => canSeeScreen(item, fullSession));
    const navigation = resolveModuleNavigation(buildPrimaryNav(visible), "/referrals");

    expect(navigation?.items.map(({ label, path }) => [label, path])).toEqual([
      ["All Admissions", "/admissions"],
      ["New Admission", "/admissions/new"],
      ["Referral Inbox", "/referrals"],
      ["New Referral", "/referrals/new"],
      ["Readmit", "/admissions/readmit"],
      ["Discharge/Transfer", "/admissions/discharges"],
    ]);
    expect(navigation?.items.some((item) => item.path === "/compliance/admissions")).toBe(false);
    expect(navigation?.items.some((item) => item.path === "/intake")).toBe(false);
  });

  it("fails closed with exactly the same permission-filtered destinations as the sidebar", () => {
    const limitedSession = { ...fullSession, permissions: ["admission.read", "referral.read"] };
    const visible = admissions.filter((item) => canSeeScreen(item, limitedSession));
    const sections = buildPrimaryNav(visible);
    const sidebar = sections
      .flatMap((section) => section.entries)
      .find((entry) => entry.key === "admissions");
    const navigation = resolveModuleNavigation(sections, "/admissions");

    expect(navigation?.items.map((item) => item.path)).toEqual(["/admissions", "/referrals"]);
    expect(
      navigation?.items.every((item) => sidebar?.screens.some((screen) => screen.id === item.id)),
    ).toBe(true);
  });

  it("reuses every resolved sidebar destination for non-Admissions modules", () => {
    const sections = buildPrimaryNav([
      screen("orders.home", "/orders", "Orders"),
      screen("orders.verbal", "/orders/verbal-expiring", "Verbal Orders"),
      screen("supplies.home", "/supplies", "Supplies"),
    ]);
    const sidebar = sections
      .flatMap((section) => section.entries)
      .find((entry) => entry.key === "orders");
    const navigation = resolveModuleNavigation(sections, "/orders/verbal-expiring");

    expect(navigation?.items.map((item) => item.id)).toEqual(
      sidebar?.screens.map((item) => item.id),
    );
    expect(navigation?.items[0]?.label).toBe("Awaiting Signature");
    expect(navigation?.activePath).toBe("/orders/verbal-expiring");
  });

  it.each([
    ["care-plans", "/bereavement", "Bereavement Caseload"],
    ["medications", "/prescribing/sign-inbox", "Awaiting Signature"],
    ["reports", "/reports", "Reports & Analytics"],
    ["administration", "/admin/onboarding", "Onboarding"],
    ["organization", "/admin/account", "Account"],
    ["scheduling", "/calendar", "Calendar"],
    [
      "integrations",
      "/medicaid/billing/trading-partner-credentials",
      "Trading Partner Credentials",
    ],
  ])("resolves the %s module from its real landing route", (key, path, label) => {
    const navigation = resolveModuleNavigation(
      buildPrimaryNav([screen(`${key}.home`, path, label)]),
      path,
    );
    expect(navigation?.key).toBe(key);
    expect(navigation?.items[0]?.label).toBe(label);
  });

  it("maps known nested workflows to a parent tab without guessing for ambiguous details", () => {
    const admissionSections = buildPrimaryNav(admissions);
    expect(resolveModuleNavigation(admissionSections, "/admissions/a-1/readmit")?.activePath).toBe(
      "/admissions/readmit",
    );
    expect(resolveModuleNavigation(admissionSections, "/referrals/r-1")?.activePath).toBe(
      "/referrals",
    );

    const orderSections = buildPrimaryNav([
      screen("orders.home", "/orders", "Orders"),
      screen("orders.cosign", "/orders/cosign-pending", "Cosign Queue"),
    ]);
    expect(resolveModuleNavigation(orderSections, "/orders/o-1")?.activePath).toBeNull();
  });

  it("uses Scheduling's eight sidebar destinations in the requested order", () => {
    const sections = buildPrimaryNav(scheduling);
    const navigation = resolveModuleNavigation(sections, "/calendar");
    expect(navigation?.items.map(({ label, path }) => [label, path])).toEqual([
      ["Calendar", "/calendar"],
      ["Clinician Credentials", "/scheduling/clinician-credentials"],
      ["Day View", "/scheduling/day"],
      ["Week View", "/scheduling/week"],
      ["Proposal Inbox", "/scheduling/proposals"],
      ["Recurring Policies", "/scheduling/recurring"],
      ["Time-Off Queue", "/scheduling/time-off"],
      ["Scheduling Metrics", "/admin/scheduling-metrics"],
    ]);
  });

  it("keeps Scheduling visibility identical to the permission-filtered sidebar", () => {
    const session = { ...fullSession, permissions: ["visit.read_team", "time_off.read_team"] };
    const sections = buildPrimaryNav(scheduling.filter((item) => canSeeScreen(item, session)));
    const sidebar = sections
      .flatMap((section) => section.entries)
      .find((entry) => entry.key === "scheduling");
    const navigation = resolveModuleNavigation(sections, "/scheduling/week");

    expect(navigation?.items.map((item) => item.path)).toEqual([
      "/calendar",
      "/scheduling/day",
      "/scheduling/week",
      "/scheduling/time-off",
    ]);
    expect(navigation?.items.map((item) => item.id)).toEqual(
      sidebar?.screens.map((item) => item.id),
    );
  });

  it.each(scheduling.map((item) => item.path))(
    "selects the Scheduling tab for a direct visit to %s",
    (path) => {
      expect(resolveModuleNavigation(buildPrimaryNav(scheduling), path)?.activePath).toBe(path);
    },
  );

  it("keeps Scheduling tabs on visit details without forcing an incorrect active destination", () => {
    const navigation = resolveModuleNavigation(
      buildPrimaryNav(scheduling),
      "/scheduling/visits/visit-1",
    );
    expect(navigation?.key).toBe("scheduling");
    expect(navigation?.items).toHaveLength(8);
    expect(navigation?.activePath).toBeNull();
  });

  it("does not add module tabs to Users", () => {
    const sections = buildPrimaryNav([screen("users", "/admin/staff", "Staff Management")]);
    expect(resolveModuleNavigation(sections, "/admin/staff")).toBeNull();
  });
});
