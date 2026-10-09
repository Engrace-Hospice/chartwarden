import { fireEvent, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ModuleNavigationTabs } from "./module-navigation-tabs";
import { buildPrimaryNav } from "./primary-nav";

const sections = buildPrimaryNav([
  { id: "orders.home", path: "/orders", title: "Orders" },
  { id: "orders.verbal", path: "/orders/verbal-expiring", title: "Verbal Orders" },
  { id: "orders.cosign", path: "/orders/cosign-pending", title: "Cosign Queue" },
]);

function Harness(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <ModuleNavigationTabs sections={sections} pathname={location.pathname} />
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  );
}

describe("ModuleNavigationTabs", () => {
  it("renders route links with navigation semantics and a direct-link active state", () => {
    render(
      <MemoryRouter initialEntries={["/orders/cosign-pending"]}>
        <Harness />
      </MemoryRouter>,
    );

    const navigation = screen.getByRole("navigation", { name: "Orders pages" });
    expect(navigation.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("link", { name: "Cosign Queue" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("tracks link navigation and browser-style back navigation without remounting", () => {
    render(
      <MemoryRouter initialEntries={["/orders"]}>
        <Harness />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Verbal Orders" }));
    expect(screen.getByRole("link", { name: "Verbal Orders" }).getAttribute("aria-current")).toBe(
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("link", { name: "Awaiting Signature" }).getAttribute("aria-current"),
    ).toBe("page");
  });
});
