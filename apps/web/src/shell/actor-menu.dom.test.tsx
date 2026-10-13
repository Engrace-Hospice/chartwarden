// The shell user menu hides its name/role text below 768px (app-shell.css `.wx-actor-text`), so the trigger button
// must carry its own accessible name or axe reports button-name (critical) at narrow widths.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ActorMenu } from "./layout";
import type { Session } from "./session";

const SESSION = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
  displayName: "Ada Administrator",
  isAdmin: true,
} as Session;

describe("ActorMenu trigger", () => {
  it("has an explicit accessible name that does not depend on the responsive text", () => {
    render(
      <MemoryRouter>
        <ActorMenu session={SESSION} />
      </MemoryRouter>,
    );
    const trigger = screen.getByRole("button", { name: /Ada Administrator/ });
    expect(trigger.getAttribute("aria-label")).toBe(
      "Ada Administrator, Administrator, account menu",
    );
  });

  it("omits the role segment when the actor has no role line", () => {
    render(
      <MemoryRouter>
        <ActorMenu session={{ ...SESSION, isAdmin: false, roles: [] }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: /Ada/ }).getAttribute("aria-label")).toBe(
      "Ada Administrator, account menu",
    );
  });
});
