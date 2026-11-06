// @vitest-environment jsdom
// Step 1, Organisation: the display name and time zone the tenant's organisation carries, saved by the operator, then attested.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { OrganisationPanel } from "./organisation-panel";
import {
  ORG_SLUG,
  ok,
  panelCtx,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";

const PATCH = "/api/v1/platform/tenants/{orgSlug}/org-profile";
const view = (over = {}) =>
  wizardView([wizardStep("account_created", 1, { title: "Organisation" })], over);
const mount = (client: ReturnType<typeof stubClient>, v = view()) =>
  renderAt(
    "/x",
    [{ path: "/x", element: <OrganisationPanel ctx={panelCtx(v, "account_created")} /> }],
    client,
  );

beforeEach(() => window.sessionStorage.clear());

describe("OrganisationPanel", () => {
  it("shows the profile on file and the facts that settle the step", () => {
    mount(stubClient({}));
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Cedar Ridge");
    expect((screen.getByLabelText(/^Time zone/) as HTMLInputElement).value).toBe("America/Denver");
    expect(screen.getByText(/Display name is set/)).toBeTruthy();
    expect(screen.getByText(/Time zone is set/)).toBeTruthy();
  });

  it("saves the profile for this tenant and reloads the wizard", async () => {
    const client = stubClient({
      PATCH: {
        [PATCH]: () => ok({ displayName: "Cedar Ridge Hospice", orgTimezone: "America/Denver" }),
      },
    });
    const v = view();
    const ctx = panelCtx(v, "account_created");
    renderAt("/x", [{ path: "/x", element: <OrganisationPanel ctx={ctx} /> }], client);
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Cedar Ridge Hospice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    const [path, init] = client.PATCH.mock.calls[0] as [
      string,
      { params: { path: unknown }; body: unknown },
    ];
    expect(path).toBe(PATCH);
    expect((init as { headers?: Record<string, string> }).headers?.["Idempotency-Key"]).toMatch(
      /\S/,
    );
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG });
    expect(init.body).toEqual({
      displayName: "Cedar Ridge Hospice",
      orgTimezone: "America/Denver",
    });
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });

  it("will not save an empty display name", () => {
    const client = stubClient({});
    mount(client);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(client.PATCH).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter the display name/)).toBeTruthy();
  });

  it("shows the server's time zone refusal on the field", async () => {
    const client = stubClient({
      PATCH: {
        [PATCH]: () =>
          refused(422, "INVALID_ORG_TIMEZONE", "bad zone", [
            { field: "orgTimezone", code: "INVALID_ORG_TIMEZONE", message: "not an IANA zone" },
          ]),
      },
    });
    mount(client);
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("not an IANA zone")).toBeTruthy();
  });

  it("a stale step-up offers Re-verify and stashes what was typed", async () => {
    const client = stubClient({ PATCH: { [PATCH]: () => refused(403, "STEP_UP_REQUIRED") } });
    mount(client);
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Cedar Ridge Hospice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    expect(
      window.sessionStorage.getItem(
        "wx.admin.step-up-draft:wizard:cedar-ridge:account_created:profile",
      ),
    ).toContain("Cedar Ridge Hospice");
  });

  it("warns that a save voids a pending go-live attestation", () => {
    mount(
      stubClient({}),
      view({
        goLive: {
          state: "awaiting_approval",
          attestation: null,
          failedGuards: [],
          complianceOfficerMembershipId: null,
        },
      }),
    );
    expect(screen.getByText(/voids that attestation/)).toBeTruthy();
  });

  it("cannot be edited when the tenant is not onboarding", () => {
    mount(stubClient({}), view({ tenantStatus: "provisioning" }));
    expect((screen.getByLabelText("Display name") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
  });
});
