// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { CreateUserDialog } from "../create-user-dialog";

const role = {
  roleId: "role-1",
  organizationId: null,
  key: "nurse",
  name: "Registered Nurse",
  category: "clinical_staff" as const,
  scopeLevel: "organization" as const,
  systemDefault: true,
  systemLocked: false,
  enabled: true,
  customized: false,
  permissionKeys: ["patient.read"],
};

function renderDialog(post: ReturnType<typeof vi.fn>): void {
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ POST: post } as unknown as ApiClient}>
        <ToastProvider>
          <CreateUserDialog
            open
            organizationId="org-1"
            roles={[role]}
            locations={[]}
            onClose={vi.fn()}
            onCreated={vi.fn()}
          />
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

const clinicalRoles = [
  { ...role, roleId: "rn", key: "rn", name: "Registered Nurse (RN)" },
  { ...role, roleId: "rn-cm", key: "rn_case_manager", name: "RN Case Manager" },
  { ...role, roleId: "md", key: "md", name: "Physician (MD/DO)" },
  { ...role, roleId: "hospice-md", key: "hospice_physician", name: "Hospice Physician" },
  {
    ...role,
    roleId: "medical-director",
    key: "medical_director",
    name: "Hospice Medical Director",
  },
  {
    ...role,
    roleId: "compliance",
    key: "compliance_officer",
    name: "Compliance Officer",
  },
];

describe("CreateUserDialog", () => {
  it("renders distinct role labels and keeps simultaneous selections keyed by role id", () => {
    const post = vi.fn();
    render(
      <MemoryRouter>
        <ApiClientProvider client={{ POST: post } as unknown as ApiClient}>
          <ToastProvider>
            <CreateUserDialog
              open
              organizationId="org-1"
              roles={clinicalRoles}
              locations={[]}
              onClose={vi.fn()}
              onCreated={vi.fn()}
            />
          </ToastProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    for (const item of clinicalRoles) {
      const checkbox = screen.getByLabelText(item.name) as HTMLInputElement;
      fireEvent.click(checkbox);
      expect(checkbox.checked).toBe(true);
    }
    expect(screen.getAllByRole("checkbox", { checked: true })).toHaveLength(clinicalRoles.length);
  });

  it("creates a username-only user with authorized roles and server-generated credentials", async () => {
    const post = vi.fn(async () => ({
      data: {
        userId: "user-1",
        membershipId: "membership-1",
        name: "Jordan Smith",
        username: "jsmith",
        email: null,
        credentialState: "password_change_required",
        roleIds: ["role-1"],
        defaultLocationIds: [],
        temporaryPassword: "One-Time-Generated#123",
      },
      error: undefined,
      response: { status: 201 },
    }));
    renderDialog(post);
    fireEvent.change(screen.getByLabelText(/Full Name/), { target: { value: "Jordan Smith" } });
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "jsmith" } });
    fireEvent.click(screen.getByLabelText("Registered Nurse"));
    fireEvent.click(screen.getByRole("button", { name: "Create User" }));
    await screen.findByText("Account created");
    expect(screen.getByText("Not provided")).toBeTruthy();
    expect(screen.getByText("One-Time-Generated#123")).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/api/v1/orgs/{orgId}/users", {
      params: { path: { orgId: "org-1" } },
      body: {
        name: "Jordan Smith",
        username: "jsmith",
        roleIds: ["role-1"],
        generateTemporaryPassword: true,
      },
    });
  });

  it("preserves entered values and explains a case-insensitive username conflict", async () => {
    const post = vi.fn(async () => ({
      data: undefined,
      error: { error: { code: "IDENTITY_CONFLICT", message: "unavailable" } },
      response: { status: 409 },
    }));
    renderDialog(post);
    const name = screen.getByLabelText(/Full Name/) as HTMLInputElement;
    const username = screen.getByLabelText(/Username/) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Jordan Smith" } });
    fireEvent.change(username, { target: { value: "JSmith" } });
    fireEvent.click(screen.getByLabelText("Registered Nurse"));
    fireEvent.click(screen.getByRole("button", { name: "Create User" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "username or email is unavailable",
    );
    await waitFor(() => expect(name.value).toBe("Jordan Smith"));
    expect(username.value).toBe("JSmith");
  });
});
