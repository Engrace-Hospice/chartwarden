import { ApiClientProvider } from "@chartwarden/ui";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { CosignatureQueue } from "../cosignature-queue";

function Location(): JSX.Element {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}</output>;
}

function mountQueue() {
  const client = {
    GET: vi.fn(async () => ({
      data: {
        encounters: [
          {
            id: "encounter-12345678",
            patientId: "patient-12345678",
            encounterType: "routine_visit",
            discipline: "lpn",
            serviceDate: "2026-11-15",
            status: "cosign_pending",
            signedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          },
        ],
      },
    })),
  };
  render(
    <MemoryRouter initialEntries={["/work/cosignatures"]}>
      <ApiClientProvider client={client as never}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <CosignatureQueue />
                <Location />
              </>
            }
          />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return client;
}

describe("Cosignature queue task actions", () => {
  it("presents one explicit review action instead of making the whole row an unnamed action", async () => {
    mountQueue();
    const queue = await screen.findByRole("region", { name: "Cosignature queue" });
    const row = within(queue).getByRole("row", { name: /Routine Visit/i });
    expect(row.getAttribute("role")).not.toBe("button");

    fireEvent.click(within(row).getByRole("button", { name: "Review LPN routine visit" }));
    expect(screen.getByLabelText("location").textContent).toBe(
      "/patients/patient-12345678/encounters/encounter-12345678",
    );
  });
});
