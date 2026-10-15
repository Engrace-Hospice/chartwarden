import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createApiClient } from "@wardenx/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/app";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

const json = (data: unknown) => Response.json(data);
const patient = (id: string, label: string) => ({
  patientId: id, grantId: id, grantKind: "family_caregiver",
  layPatientLabel: label, scopeSet: ["visits"],
});
function stub(handler: (path: string, method: string, body: Record<string, unknown> | null) => Response | Promise<Response>) {
  return createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const req = input instanceof Request ? input : new Request(input);
      const body = req.method === "POST" ? JSON.parse(await req.text()) as Record<string, unknown> : null;
      return handler(new URL(req.url).pathname, req.method, body);
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("PR4.1 onboarding", () => {
  it("preserves a chromeless, guided sign-in with a password alternative", () => {
    window.history.pushState({}, "", "/");
    render(<PortalApp client={stub(() => new Response(null, { status: 404 }))} />);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Portal navigation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use a password instead" }));
    expect(screen.getByRole("heading", { name: "Sign in with your password" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Email me a sign-in link instead" }));
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("handles sign-in network failures without leaving the form stuck", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", mockFetch);
    window.history.pushState({}, "", "/");
    render(<PortalApp client={stub(() => new Response(null, { status: 404 }))} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), { target: { value: "care@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(await screen.findByText(/couldn't connect securely/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Email me a sign-in link" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("binds the only eligible organization by explicit account ID even with blocked accounts", async () => {
    const bound: unknown[] = [];
    const patientSelected: unknown[] = [];
    window.history.pushState({}, "", "/signed-in");
    render(<PortalApp client={stub((path, method, body) => {
      if (path.endsWith("/sign-in/accounts")) return json({ items: [
        { portalAccountId: "blocked", organizationName: "Inactive", relationship: "caregiver", blockedReason: "SIGN_IN_ACCOUNT_NOT_ACTIVE" },
        { portalAccountId: "eligible", organizationName: "Care Team", relationship: "family_caregiver", blockedReason: null },
      ] });
      if (path.endsWith("/sign-in/establish") && method === "POST") { bound.push(body?.portalAccountId); return json({ ok: true }); }
      if (path.endsWith("/sessions/patients")) return json({ items: [patient(P1, "Sam Example")] });
      if (path.endsWith("/sessions/select-patient")) { patientSelected.push(body?.patientId); return json({ ok: true }); }
      if (path.endsWith("/care-summary")) return json({ patient: { layLabel: "Sam Example" } });
      return new Response(null, { status: 404 });
    })} />);
    await waitFor(() => expect(bound).toEqual(["eligible"]));
    await waitFor(() => expect(patientSelected).toEqual([P1]));
    await waitFor(() => expect(window.location.pathname).toBe(`/p/${P1}`));
  });

  it("lets the user choose among multiple eligible care teams", async () => {
    const bound: unknown[] = [];
    window.history.pushState({}, "", "/signed-in");
    render(<PortalApp client={stub((path, _method, body) => {
      if (path.endsWith("/sign-in/accounts")) return json({ items: [
        { portalAccountId: "a", organizationName: "Hospice A", relationship: "family_caregiver", blockedReason: null },
        { portalAccountId: "b", organizationName: "Hospice B", relationship: "healthcare_dpoa", blockedReason: null },
      ] });
      if (path.endsWith("/sign-in/establish")) { bound.push(body?.portalAccountId); return json({ ok: true }); }
      if (path.endsWith("/sessions/patients")) return json({ items: [] });
      return new Response(null, { status: 404 });
    })} />);
    fireEvent.click(await screen.findByRole("button", { name: /Hospice B/ }));
    await waitFor(() => expect(bound).toEqual(["b"]));
  });

  it("requires successful server patient selection and prevents a second selection while pending", async () => {
    let complete: ((value: Response) => void) | undefined;
    const selected: unknown[] = [];
    window.history.pushState({}, "", "/patient-picker");
    render(<PortalApp client={stub((path, method, body) => {
      if (path.endsWith("/sessions/patients")) return json({ items: [patient(P1, "Patient One"), patient(P2, "Patient Two")] });
      if (path.endsWith("/sessions/select-patient") && method === "POST") {
        selected.push(body?.patientId);
        return new Promise<Response>((resolve) => { complete = resolve; });
      }
      if (path.endsWith("/care-summary")) return json({ patient: { layLabel: "Patient One" } });
      return new Response(null, { status: 404 });
    })} />);
    const first = await screen.findByRole("button", { name: /Patient One/ });
    fireEvent.click(first);
    await waitFor(() => expect(selected).toEqual([P1]));
    fireEvent.click(screen.getByRole("button", { name: /Patient Two/ }));
    expect(selected).toEqual([P1]);
    expect(window.location.pathname).toBe("/patient-picker");
    complete?.(json({ ok: true }));
    await waitFor(() => expect(window.location.pathname).toBe(`/p/${P1}`));
  });

  it("keeps the selection error on the picker and permits retry", async () => {
    let calls = 0;
    window.history.pushState({}, "", "/patient-picker");
    render(<PortalApp client={stub((path) => {
      if (path.endsWith("/sessions/patients")) return json({ items: [patient(P1, "Patient One")] });
      if (path.endsWith("/sessions/select-patient")) {
        calls++;
        return calls === 1 ? new Response(null, { status: 403 }) : json({ ok: true });
      }
      if (path.endsWith("/care-summary")) return json({ patient: { layLabel: "Patient One" } });
      return new Response(null, { status: 404 });
    })} />);
    fireEvent.click(await screen.findByRole("button", { name: /Patient One/ }));
    expect(await screen.findByText("This information is not available on your account.")).toBeTruthy();
    expect(window.location.pathname).toBe("/patient-picker");
    fireEvent.click(screen.getByRole("button", { name: /Patient One/ }));
    await waitFor(() => expect(window.location.pathname).toBe(`/p/${P1}`));
  });

  it("accepts an invitation without displaying or retaining its URL token", async () => {
    const submitted: unknown[] = [];
    window.history.pushState({}, "", "/accept-invitation?token=synthetic-secret");
    render(<PortalApp client={stub((path, _method, body) => {
      if (path.endsWith("/invitations/accept")) { submitted.push(body?.token); return json({ ok: true }); }
      return new Response(null, { status: 404 });
    })} />);
    expect(await screen.findByRole("heading", { name: "Your access is ready" })).toBeTruthy();
    expect(submitted).toEqual(["synthetic-secret"]);
    expect(window.location.search).toBe("");
    expect(screen.queryByText("synthetic-secret")).toBeNull();
  });

});
