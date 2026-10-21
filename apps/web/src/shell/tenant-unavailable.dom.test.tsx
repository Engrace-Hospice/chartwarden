// @vitest-environment jsdom
// ADR-0049: /tenant-unavailable has three static copies chosen by ?reason=, defaulting to "no organization here".
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { TenantUnavailable } from "./system-pages";

const at = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/tenant-unavailable${search}`]}>
      <TenantUnavailable />
    </MemoryRouter>,
  );

describe("TenantUnavailable", () => {
  it.each([
    ["?reason=closed", /no longer on ChartWarden/i],
    ["?reason=suspended", /suspended/i],
    ["?reason=unknown", /No organization at this address/i],
    ["", /No organization at this address/i],
    ["?reason=bogus", /No organization at this address/i],
  ])("renders the right copy for %s", (search, headline) => {
    at(search);
    expect(screen.getByRole("heading", { name: headline })).toBeTruthy();
  });
});
