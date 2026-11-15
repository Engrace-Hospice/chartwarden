// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { AddressesTab, DemographicsTab } from "./patient-chart";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG = "org-1";

const session = (permissions: string[]): Session => ({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: ORG,
  displayName: "Synthetic Staff",
  permissions,
});

const demographics = {
  id: PATIENT,
  mrn: "SYN-0001",
  legalFirstName: "Synthetic",
  legalMiddleName: null,
  legalLastName: "Patient",
  legalNameSuffix: null,
  dob: "1940-01-02",
  sexAssignedAtBirth: "F",
  genderIdentityCode: null,
  sexualOrientationCode: null,
  pronounsCode: null,
  maritalStatusCode: null,
  preferredLanguageCode: "en",
  raceCodes: [],
  ethnicityCodes: [],
  aliases: [],
  status: "active",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mount(
  element: React.ReactNode,
  permissions: string[],
  fetchStub: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const router = createMemoryRouter(
    [
      { path: "/", element },
      { path: "/elsewhere", element: <h1>Elsewhere</h1> },
      { path: "/tenant-unavailable", element: <h1>Tenant unavailable</h1> },
    ],
    { initialEntries: ["/"] },
  );
  const result = render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <SessionProvider session={session(permissions)}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { ...result, router };
}

afterEach(cleanup);

describe("patient details permission-aware mutations", () => {
  it("does not offer demographics editing to a patient.read-only viewer", async () => {
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(req.url).pathname;
      if (path.endsWith("/demographics")) return json(demographics);
      if (path.endsWith("/identifiers")) return json({ identifiers: [] });
      return json({}, 404);
    };

    mount(
      <DemographicsTab patientId={PATIENT} onSaved={() => undefined} />,
      ["patient.read"],
      fetchStub,
    );

    expect(await screen.findByText("Demographics & Identifiers")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit demographics" })).toBeNull();
  });

  it("uses the typed PATCH contract, omits read-only language, and re-reads demographics", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    let demographicReads = 0;
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(req.url).pathname;
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      requests.push({ method: req.method, path, body });
      if (path.endsWith("/demographics")) {
        demographicReads += 1;
        return json(
          demographicReads > 1 ? { ...demographics, legalFirstName: "Updated" } : demographics,
        );
      }
      if (path.endsWith("/identifiers")) return json({ identifiers: [] });
      if (req.method === "PATCH" && path === `/api/v1/patients/${PATIENT}`) {
        return json({ patientId: PATIENT, changed: ["legalFirstName"] });
      }
      return json({}, 404);
    };

    mount(
      <DemographicsTab patientId={PATIENT} onSaved={() => undefined} />,
      ["patient.read", "patient.edit"],
      fetchStub,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit demographics" }));
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(demographicReads).toBe(2));
    const write = requests.find((request) => request.method !== "GET");
    expect(write?.method).toBe("PATCH");
    expect(write?.path).toBe(`/api/v1/patients/${PATIENT}`);
    expect(write?.body).toMatchObject({ legalFirstName: "Updated", legalLastName: "Patient" });
    expect(write?.body).not.toHaveProperty("preferredLanguageCode");
    expect(await screen.findByText("Updated Patient")).toBeTruthy();
  });

  it("protects dirty demographics from dialog close, in-app navigation, and browser unload", async () => {
    const user = userEvent.setup();
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(req.url).pathname;
      if (path.endsWith("/demographics")) return json(demographics);
      if (path.endsWith("/identifiers")) return json({ identifiers: [] });
      return json({}, 404);
    };
    const { router } = mount(
      <DemographicsTab patientId={PATIENT} onSaved={() => undefined} />,
      ["patient.read", "patient.edit"],
      fetchStub,
    );

    await user.click(await screen.findByRole("button", { name: "Edit demographics" }));
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);

    await user.clear(screen.getByLabelText("First name"));
    await user.type(screen.getByLabelText("First name"), "Changed");
    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const discard = screen.getByRole("alertdialog", { name: "Discard demographics changes" });
    expect(discard.textContent).toMatch(/not been saved/i);
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Changed");
    expect(document.activeElement?.textContent).toBe("Edit demographics");

    await act(async () => {
      await router.navigate("/elsewhere");
    });
    expect(screen.getByRole("alertdialog", { name: "Discard demographics changes" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Elsewhere" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByRole("heading", { name: "Elsewhere" })).toBeTruthy();
  });

  it("holds in-app navigation until an in-flight save and canonical re-read finish", async () => {
    const user = userEvent.setup();
    const write = deferred<Response>();
    let demographicReads = 0;
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(req.url).pathname;
      if (path.endsWith("/demographics")) {
        demographicReads += 1;
        return json(
          demographicReads > 1 ? { ...demographics, legalFirstName: "Changed" } : demographics,
        );
      }
      if (path.endsWith("/identifiers")) return json({ identifiers: [] });
      if (req.method === "PATCH") return write.promise;
      return json({}, 404);
    };
    const { router } = mount(
      <DemographicsTab patientId={PATIENT} onSaved={() => undefined} />,
      ["patient.read", "patient.edit"],
      fetchStub,
    );

    await user.click(await screen.findByRole("button", { name: "Edit demographics" }));
    await user.clear(screen.getByLabelText("First name"));
    await user.type(screen.getByLabelText("First name"), "Changed");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await act(async () => {
      void router.navigate("/elsewhere");
    });

    expect(screen.queryByRole("heading", { name: "Elsewhere" })).toBeNull();
    expect(screen.getByRole("alertdialog", { name: "Demographics save in progress" })).toBeTruthy();
    await act(async () => write.resolve(json({ patientId: PATIENT, changed: ["legalFirstName"] })));
    expect(await screen.findByRole("heading", { name: "Elsewhere" })).toBeTruthy();
  });

  it("does not call a completed PATCH unsaved when the canonical re-read fails", async () => {
    const user = userEvent.setup();
    let demographicReads = 0;
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(req.url).pathname;
      if (path.endsWith("/demographics")) {
        demographicReads += 1;
        return demographicReads > 1 ? json({}, 500) : json(demographics);
      }
      if (path.endsWith("/identifiers")) return json({ identifiers: [] });
      if (req.method === "PATCH") return json({ patientId: PATIENT, changed: ["legalFirstName"] });
      return json({}, 404);
    };
    mount(
      <DemographicsTab patientId={PATIENT} onSaved={() => undefined} />,
      ["patient.read", "patient.edit"],
      fetchStub,
    );

    await user.click(await screen.findByRole("button", { name: "Edit demographics" }));
    await user.clear(screen.getByLabelText("First name"));
    await user.type(screen.getByLabelText("First name"), "Changed");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText(/were saved, but the updated record could not be reloaded/i),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog", { name: "Discard demographics changes" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Edit patient demographics" })).toBeNull();
  });

  it("does not let a dirty draft intercept tenant-revocation navigation", async () => {
    const user = userEvent.setup();
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(req.url).pathname;
      if (path.endsWith("/demographics")) return json(demographics);
      if (path.endsWith("/identifiers")) return json({ identifiers: [] });
      return json({}, 404);
    };
    const { router } = mount(
      <DemographicsTab patientId={PATIENT} onSaved={() => undefined} />,
      ["patient.read", "patient.edit"],
      fetchStub,
    );

    await user.click(await screen.findByRole("button", { name: "Edit demographics" }));
    await user.clear(screen.getByLabelText("First name"));
    await user.type(screen.getByLabelText("First name"), "Changed");
    await act(async () => {
      await router.navigate("/tenant-unavailable");
    });

    expect(await screen.findByRole("heading", { name: "Tenant unavailable" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not render the add-address form for a patient.read-only viewer", async () => {
    const fetchStub = async () => json({ addresses: [] });
    mount(<AddressesTab patientId={PATIENT} />, ["patient.read"], fetchStub);

    expect(await screen.findByText("No current address")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Add address" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add address" })).toBeNull();
  });

  it("recovers from a rejected address write and re-enables submission", async () => {
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      if (req.method === "POST") throw new Error("network down");
      return json({ addresses: [] });
    };
    mount(<AddressesTab patientId={PATIENT} />, ["patient.read", "patient.edit"], fetchStub);

    await screen.findByText("No current address");
    fireEvent.change(screen.getByLabelText("Street address"), { target: { value: "1 Test Way" } });
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Testville" } });
    fireEvent.change(screen.getByLabelText("ZIP code"), { target: { value: "00000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add address" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not save the address/i);
    expect(
      (screen.getByRole("button", { name: "Add address" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
