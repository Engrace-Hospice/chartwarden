// The labelled stat-card group and the marker-less list: named groups and lists without a <fieldset> or per-site lint ignores.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatGrid } from "./stat-grid";
import { UnstyledList } from "./unstyled-list";

afterEach(cleanup);

describe("StatGrid", () => {
  it("is a named group of its cards, not a fieldset", () => {
    render(
      <StatGrid label="Outbox summary">
        <div className="wx-stat-card">Pending 3</div>
      </StatGrid>,
    );
    const group = screen.getByRole("group", { name: "Outbox summary" });
    expect(group.tagName).toBe("DIV");
    expect(group.className).toBe("wx-stat-grid");
    expect(group.textContent).toBe("Pending 3");
  });

  it("takes a screen's own grid class", () => {
    render(
      <StatGrid label="Load summary" className="wx-work-summary">
        <span>x</span>
      </StatGrid>,
    );
    expect(screen.getByRole("group", { name: "Load summary" }).className).toBe("wx-work-summary");
  });
});

describe("UnstyledList", () => {
  it("is a list that says so (Safari drops list semantics without markers), with its name and class", () => {
    render(
      <UnstyledList className="wx-fact-list" aria-label="Endpoints">
        <li>a</li>
        <li>b</li>
      </UnstyledList>,
    );
    const list = screen.getByRole("list", { name: "Endpoints" });
    expect(list.tagName).toBe("UL");
    expect(list.getAttribute("role")).toBe("list");
    expect(list.className).toBe("wx-fact-list");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
