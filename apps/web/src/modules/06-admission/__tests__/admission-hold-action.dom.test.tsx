import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionHoldAction } from "../admission-hold-action";

afterEach(cleanup);

function clientWith(error?: unknown): ApiClient {
  return {
    POST: vi.fn(async () => ({
      data: error ? undefined : {},
      error,
      response: new Response(null, { status: error ? 409 : 200 }),
    })),
  } as unknown as ApiClient;
}

function renderAction(client: ApiClient, state: string, onChanged = vi.fn()) {
  render(
    <ApiClientProvider client={client}>
      <AdmissionHoldAction admissionId="adm-1" state={state} version={7} onChanged={onChanged} />
    </ApiClientProvider>,
  );
  return onChanged;
}

describe("AdmissionHoldAction (GAP-021 hold/resume)", () => {
  it("places an active admission on hold with a reason of at least 10 characters", async () => {
    const client = clientWith();
    const onChanged = renderAction(client, "active");
    fireEvent.click(screen.getByRole("button", { name: "Place on hold" }));
    const submit = screen.getByRole("button", { name: "Confirm hold" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: "Patient admitted to hospital" },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith("/api/v1/admissions/{id}/hold", {
        params: { path: { id: "adm-1" } },
        body: { reason: "Patient admitted to hospital", ifVersion: 7 },
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("resumes an on-hold admission", async () => {
    const client = clientWith();
    const onChanged = renderAction(client, "on_hold");
    fireEvent.click(screen.getByRole("button", { name: "Resume admission" }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith("/api/v1/admissions/{id}/resume", {
        params: { path: { id: "adm-1" } },
        body: { ifVersion: 7 },
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows an error and does not reload when the server refuses", async () => {
    const client = clientWith({ error: { code: "VERSION_CONFLICT" } });
    const onChanged = renderAction(client, "on_hold");
    fireEvent.click(screen.getByRole("button", { name: "Resume admission" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("renders nothing for a state that cannot be held or resumed", () => {
    renderAction(clientWith(), "discharged");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
