import { render, screen } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { PatientContextTiles } from "./patient-context-tiles";

// WP 3.1: a tile the server omitted is not rendered at all (no empty card), a failing source reads "unavailable" and
// never "none", and every tile says when it was read and links to its owning screen.
const AS_OF = "2026-10-14T12:00:00.000Z";
const link = "/patients/p-1";

function mount(get: unknown) {
  const api = { GET: vi.fn().mockResolvedValue(get) } as unknown as ApiClient;
  render(
    <ApiClientProvider client={api}>
      <MemoryRouter>
        <PatientContextTiles patientId="p-1" />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

describe("PatientContextTiles", () => {
  it("renders only the tiles the server returned, each with an as-of label and a chart link", async () => {
    mount({
      data: {
        tiles: {
          status: { state: "ok", as_of: AS_OF, link, data: { status: "on_hold" } },
          allergies: {
            state: "ok",
            as_of: AS_OF,
            link,
            data: { entries: [{ allergen: "penicillin", severity: "severe" }] },
          },
        },
      },
    });

    expect(await screen.findByRole("region", { name: "Status" })).toBeTruthy();
    expect(screen.getByText("on hold")).toBeTruthy();
    expect(screen.getByText("penicillin (severe)")).toBeTruthy();
    expect(screen.getAllByText(/^As of /)).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Open in chart" })).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "Medications" })).toBeNull();
  });

  it("says unavailable, not none, when a source failed", async () => {
    mount({ data: { tiles: { allergies: { state: "unavailable", link } } } });

    expect(await screen.findByText(/Temporarily unavailable/)).toBeTruthy();
    expect(screen.queryByText("No allergies recorded")).toBeNull();
  });

  it("shows an error when the context cannot be loaded", async () => {
    mount({ data: undefined, error: {} });

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
  });

  it("says so when the server returned no tile at all, instead of a blank panel", async () => {
    mount({ data: { tiles: {} } });

    expect(await screen.findByText("No additional context available.")).toBeTruthy();
  });

  it("shows the caller's open-task count with a link to the task list, and nothing when the tile is absent", async () => {
    mount({
      data: {
        tiles: {
          open_tasks: {
            state: "ok",
            as_of: AS_OF,
            link: "/notifications?tab=tasks",
            data: { count: 3 },
          },
        },
      },
    });

    const card = await screen.findByRole("region", { name: "Your open tasks" });
    expect(card.textContent).toMatch(/3 open/);
    expect(screen.getByRole("link", { name: "Open tasks" }).getAttribute("href")).toBe(
      "/notifications?tab=tasks",
    );
  });

  it("omits the open-tasks card when the server left the tile out", async () => {
    mount({
      data: { tiles: { status: { state: "ok", as_of: AS_OF, link, data: { status: "on_hold" } } } },
    });

    await screen.findByRole("region", { name: "Status" });
    expect(screen.queryByRole("region", { name: "Your open tasks" })).toBeNull();
  });
});
