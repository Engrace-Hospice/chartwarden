// #648 (WCAG 2.5.8): the chart-overview links and icon-only actions are at least 24 x 24 CSS px.
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { TARGET_24 } from "../../shell/target-size";
import { PanelLink } from "./patient-overview";

afterEach(cleanup);

describe("#648 target size", () => {
  it("TARGET_24 reserves a 24px box", () => {
    expect(TARGET_24.minWidth).toBe("1.5rem");
    expect(TARGET_24.minHeight).toBe("1.5rem");
  });

  it("PanelLink (Edit / Manage / View all) carries the minimum height", () => {
    render(
      <MemoryRouter>
        <PanelLink to="/x">Manage</PanelLink>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Manage" }).style.minHeight).toBe("1.5rem");
  });
});
