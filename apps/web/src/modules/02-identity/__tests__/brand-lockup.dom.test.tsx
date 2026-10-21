// @vitest-environment jsdom
// Every auth card shares one lockup: the ChartWarden mark asset beside the wordmark (no leftover flame glyph).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandLockup } from "../brand-lockup";

describe("BrandLockup", () => {
  it("renders the ChartWarden mark image beside the wordmark", () => {
    const { container } = render(<BrandLockup />);

    expect(screen.getByText("ChartWarden").className).toContain("wx-brand");
    const mark = container.querySelector("img");
    expect(mark?.getAttribute("src")).toBe("/chartwarden-mark.svg");
    expect(mark?.getAttribute("alt")).toBe(""); // decorative: the adjacent wordmark names it
    expect(container.querySelector("svg")).toBeNull();
  });
});
