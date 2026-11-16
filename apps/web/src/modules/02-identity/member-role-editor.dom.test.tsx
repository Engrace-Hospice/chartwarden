// MemberRoleEditor — what a refused grant tells the admin, and which roles the dropdown offers.
//
// A platform role (category `platform_staff`) can never be bound through this surface: the assign route answers
// 422 RESERVED_ROLE to every caller, a superadmin included (GAP-003 — only the ticketed operator CLI binds one).
// The editor used to offer those roles anyway and blame EVERY failure on "anti-escalation", so a superadmin who held
// every permission read that they lacked one. These tests pin the honest behaviour over a stubbed fetch.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemberRoleEditor } from "./member-role-editor";

const MEMBERSHIP = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PLATFORM_ROLE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const NURSE_ROLE = "cccccccc-3333-4333-8333-cccccccccccc";
const LEGACY_PLATFORM_KEY_ROLE = "dddddddd-4444-4444-8444-dddddddddddd";
const LEGACY_SUPERADMIN_ROLE = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const HINT = /ChartWarden operations grants them/;

const role = (roleId: string, key: string, name: string, category: string) => ({
  roleId,
  organizationId: null as string | null,
  key,
  name,
  category,
  scopeLevel: "organization",
  systemDefault: false,
  systemLocked: false,
  enabled: true,
  customized: false,
  permissionKeys: [] as string[],
});

const defaultRoles = () => [
  role(PLATFORM_ROLE, "platform_ops", "Platform Operations", "platform_staff"),
  role(NURSE_ROLE, "registered_nurse", "Registered Nurse", "clinical_staff"),
];

let roles = defaultRoles();
let grantAnswer: { status: number; body: unknown } = { status: 200, body: {} };
const posts: { path: string; body: unknown }[] = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input as RequestInfo, init);
  const path = new URL(req.url).pathname;
  if (req.method === "POST") {
    posts.push({ path, body: JSON.parse(await req.clone().text()) });
    return json(grantAnswer.status, grantAnswer.body);
  }
  if (path === "/api/v1/roles") return json(200, { roles });
  if (path === `/api/v1/memberships/${MEMBERSHIP}/roles`) return json(200, { roles: [] });
  return json(404, { error: { code: "NOT_FOUND", message: "not found" } });
}

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter>
        <MemberRoleEditor membershipId={MEMBERSHIP} memberLabel="Sam Superadmin" />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

async function pickAndGrant(roleId: string): Promise<void> {
  const select = await screen.findByLabelText("Role to grant");
  fireEvent.change(select, { target: { value: roleId } });
  fireEvent.click(screen.getByRole("button", { name: "Grant" }));
}

beforeEach(() => {
  posts.length = 0;
  grantAnswer = { status: 200, body: {} };
});
afterEach(() => {
  roles = defaultRoles();
});

describe("MemberRoleEditor", () => {
  it("does not offer a platform role, and says where one is granted", async () => {
    mount();
    const select = await screen.findByLabelText("Role to grant");
    const offered = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(offered).toContain("Registered Nurse");
    expect(offered).not.toContain("Platform Operations");
    // The hint is tenant-neutral (a tenant admin cannot run the operator CLI) and is announced with the select.
    const hint = screen.getByText(HINT);
    expect(hint.textContent).not.toMatch(/db:platform-role/);
    expect(select.getAttribute("aria-describedby")).toBe(hint.id);
  });

  it("also hides a legacy row the server reserves by KEY (platform_*, superadmin), whatever its category", async () => {
    // Rows that predate migration 0318 can sit in a tenant under an ordinary category; the server still refuses them.
    roles = [
      ...defaultRoles(),
      role(LEGACY_PLATFORM_KEY_ROLE, "platform_legacy", "Legacy Platform", "operations"),
      role(LEGACY_SUPERADMIN_ROLE, "superadmin", "Tenant Superadmin", "clinical_staff"),
    ];
    mount();
    const select = await screen.findByLabelText("Role to grant");
    const offered = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(offered).toContain("Registered Nurse");
    expect(offered).not.toContain("Legacy Platform");
    expect(offered).not.toContain("Tenant Superadmin");
  });

  it("shows no platform-role hint when the catalog holds none", async () => {
    roles = [role(NURSE_ROLE, "registered_nurse", "Registered Nurse", "clinical_staff")];
    mount();
    const select = await screen.findByLabelText("Role to grant");
    expect(screen.queryByText(HINT)).toBeNull();
    expect(select.getAttribute("aria-describedby")).toBeNull();
  });

  it("names a reserved role as a platform role, not as anti-escalation", async () => {
    grantAnswer = {
      status: 422,
      body: { error: { code: "RESERVED_ROLE", message: "platform role keys are reserved" } },
    };
    mount();
    await pickAndGrant(NURSE_ROLE);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/platform role/i);
    expect(alert.textContent).not.toMatch(/anti-escalation/i);
  });

  it("keeps the anti-escalation wording for an ESCALATION_BLOCKED refusal", async () => {
    grantAnswer = {
      status: 403,
      body: {
        error: {
          code: "ESCALATION_BLOCKED",
          message: "cannot grant permission 'x' you do not hold",
        },
      },
    };
    mount();
    await pickAndGrant(NURSE_ROLE);
    expect((await screen.findByRole("alert")).textContent).toMatch(/anti-escalation/i);
  });

  it("does not call a plain 403 anti-escalation (a missing role.assign, a step-up, an ABAC deny)", async () => {
    grantAnswer = { status: 403, body: { error: { code: "FORBIDDEN", message: "Forbidden" } } };
    mount();
    await pickAndGrant(NURSE_ROLE);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not permitted/i);
    expect(alert.textContent).not.toMatch(/anti-escalation/i);
  });

  it("tells a step-up refusal apart from a plain 403: re-authenticate, not 'not permitted'", async () => {
    grantAnswer = {
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED", message: "recent authentication required" } },
    };
    mount();
    await pickAndGrant(NURSE_ROLE);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/re-authenticate/i);
    expect(alert.textContent).not.toMatch(/not permitted|anti-escalation/i);
    // ...and gives the way to do it, like the sibling dialogs: a link to the step-up page, back to this screen.
    const link = within(alert).getByRole("link", { name: /re-verify now/i });
    expect(link.getAttribute("href")).toMatch(/^\/step-up\?returnTo=/);
  });

  it("offers no re-verify link for a refusal that is not a step-up", async () => {
    grantAnswer = { status: 403, body: { error: { code: "FORBIDDEN", message: "Forbidden" } } };
    mount();
    await pickAndGrant(NURSE_ROLE);
    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("link")).toBeNull();
  });

  it("does not blame escalation for an unrelated failure", async () => {
    grantAnswer = { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "boom" } } };
    mount();
    await pickAndGrant(NURSE_ROLE);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not grant that role/i);
    expect(alert.textContent).not.toMatch(/anti-escalation/i);
    // The editor is usable again after a refusal (busy is cleared before the message is read).
    expect(screen.getByRole("button", { name: "Grant" }).hasAttribute("disabled")).toBe(false);
  });

  it("posts the chosen role id, then clears the choice", async () => {
    mount();
    await pickAndGrant(NURSE_ROLE);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      path: `/api/v1/memberships/${MEMBERSHIP}/roles`,
      body: { roleId: NURSE_ROLE },
    });
    const select = screen.getByLabelText("Role to grant") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(""));
  });
});
