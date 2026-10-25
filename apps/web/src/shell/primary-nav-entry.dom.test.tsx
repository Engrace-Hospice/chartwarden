import { fireEvent, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PrimaryNavEntry } from "./layout";
import type { NavEntry } from "./primary-nav";

const entry: NavEntry = {
  key: "admissions",
  label: "Admissions",
  icon: "user-plus",
  href: "/admissions",
  screens: [
    { id: "admissions", path: "/admissions", title: "Admissions" },
    { id: "referrals", path: "/referrals", title: "Referral Inbox" },
  ],
  children: [{ id: "referrals", path: "/referrals", title: "Referral Inbox" }],
  matchPrefixes: ["/admissions", "/referrals"],
};

function Harness(): JSX.Element {
  const location = useLocation();
  return (
    <>
      <PrimaryNavEntry entry={entry} active={false} pathname={location.pathname} />
      <output aria-label="location">{location.pathname}</output>
    </>
  );
}

describe("PrimaryNavEntry", () => {
  it("navigates and toggles its children when the module link is clicked", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Harness />
      </MemoryRouter>,
    );

    const moduleLink = screen.getByRole("link", { name: "Admissions" });
    expect(moduleLink.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Referral Inbox" })).toBeNull();

    fireEvent.click(moduleLink);
    expect(screen.getByLabelText("location").textContent).toBe("/admissions");
    expect(moduleLink.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Referral Inbox" })).toBeTruthy();

    fireEvent.click(moduleLink);
    expect(moduleLink.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Referral Inbox" })).toBeNull();
  });

  it("keeps the dedicated disclosure button as an accessible alternative", () => {
    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show Admissions pages" }));
    expect(screen.getByRole("link", { name: "Referral Inbox" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide Admissions pages" }));
    expect(screen.queryByRole("link", { name: "Referral Inbox" })).toBeNull();
  });

  it("renders headed subsections and borrowed links; only owned links carry aria-current", () => {
    const grouped: NavEntry = {
      ...entry,
      children: [
        { id: "referrals", path: "/referrals", title: "Referral Inbox" },
        { id: "intake", path: "/intake", title: "Intake" },
      ],
      subsections: [
        {
          key: "s",
          label: "Group S",
          screens: [{ id: "referrals", path: "/referrals", title: "Referral Inbox" }],
          borrowed: [{ id: "intake", path: "/intake", title: "Intake (borrowed)" }],
        },
      ],
    };
    render(
      <MemoryRouter>
        <PrimaryNavEntry entry={grouped} active pathname="/referrals" />
      </MemoryRouter>,
    );
    expect(screen.getByText("Group S")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Referral Inbox" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      screen.getByRole("link", { name: "Intake (borrowed)" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Intake" })).toBeTruthy();
  });
});
