import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// GAP-116 — the Roles & Permissions controls must issue the writes. Asserted on RECORDED FETCH CALLS (not a
// spy over the client), same shape as `10-hope/hope-writes.dom.test.tsx`.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { RolesPermissions } from "./roles-permissions";

const ROLE_ID = "role-tenant-1";
const tenantRole = {
  roleId: ROLE_ID,
  organizationId: "org-1",
  key: "visit_nurse",
  name: "Visit nurse",
  category: "clinical_staff",
  scopeLevel: "location",
  systemDefault: false,
  systemLocked: false,
  enabled: true,
  customized: true,
  permissionKeys: ["patient.read"],
};
const catalog = [
  { key: "patient.read", resource: "patient", action: "read", category: "clinical" },
  { key: "patient.create", resource: "patient", action: "create", category: "clinical" },
];

let calls: string[] = [];
let bodies: unknown[] = [];
let myPermissions: string[] = [];
let patchFailure: { message: string } | null = null;

function requestOf(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string")
    return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL)
    return { url: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (method !== "GET" && typeof input === "object" && "clone" in input) {
    const raw = await (input as Request).clone().text();
    if (raw) bodies.push(JSON.parse(raw));
  }
  if (method === "PATCH") {
    if (patchFailure)
      return json({ error: { code: "FORBIDDEN", message: patchFailure.message } }, 403);
    const sent = bodies[bodies.length - 1] as { permissionKeys?: string[] };
    return json({
      ...tenantRole,
      permissionKeys: sent.permissionKeys ?? tenantRole.permissionKeys,
    });
  }
  if (method === "DELETE") return json({ deleted: true });
  if (path === "/api/v1/me/permissions") return json({ permissions: myPermissions });
  if (path === "/api/v1/roles") return json({ roles: [tenantRole] });
  if (path === "/api/v1/permissions") return json({ permissions: catalog });
  return json({});
}

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ToastProvider>
        <MemoryRouter>
          <RolesPermissions />
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
}

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  calls = [];
  bodies = [];
  myPermissions = ["role.read", "role.manage"];
  patchFailure = null;
});

describe("GAP-116 — role writes", () => {
  it("Edit permissions -> toggle -> Save PATCHes the role's permission set", async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit permissions" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit permissions" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "patient.create" }));
    fireEvent.click(screen.getByRole("button", { name: /Save 2 permissions/ }));
    await waitFor(() => expect(writes()).toContain(`PATCH /api/v1/roles/${ROLE_ID}`));
    expect((bodies[0] as { permissionKeys: string[] }).permissionKeys.sort()).toEqual([
      "patient.create",
      "patient.read",
    ]);
  });

  it("shows the server's refusal in place when the save is denied", async () => {
    patchFailure = { message: "cannot grant permission 'patient.create' you do not hold" };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit permissions" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "patient.create" }));
    fireEvent.click(screen.getByRole("button", { name: /Save 2 permissions/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("you do not hold");
  });

  it("Delete role needs a confirm click, then DELETEs", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Delete role" }));
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(writes()).toContain(`DELETE /api/v1/roles/${ROLE_ID}`));
  });

  it("offers no write control without role.manage", async () => {
    myPermissions = ["role.read"];
    mount();
    await waitFor(() => expect(calls).toContain("GET /api/v1/permissions"));
    expect(screen.queryByRole("button", { name: "Edit permissions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New role" })).toBeNull();
  });
});
