// @vitest-environment jsdom
// Step 1, Organisation: the administrator saves the display name and time zone (PATCH /api/v1/tenant/org-profile); ChartWarden confirms.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrganisationPanel } from "./organisation-panel";
import {
  COMPLIANCE_OFFICER,
  RETURNED_FROM_STEP_UP,
  deferred,
  keyOf,
  ok,
  panelProps,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";

const PATH = "/api/v1/tenant/org-profile";
const view = wizardView([wizardStep("account_created", 1)]);

function mount(
  client: ReturnType<typeof stubClient>,
  at: Parameters<typeof renderAt>[0] = "/x",
  onChanged = vi.fn(async () => undefined),
) {
  renderAt(
    at,
    [
      {
        path: "/x",
        element: (
          <OrganisationPanel {...panelProps(view, "account_created", undefined, onChanged)} />
        ),
      },
    ],
    client,
  );
  return onChanged;
}
const type = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
// Submit the form itself: while a save is in flight its button is disabled, and a second Enter still reaches the form.
const save = (): void => {
  fireEvent.submit(screen.getByRole("form", { name: "Organisation profile form" }));
};

describe("OrganisationPanel", () => {
  it("saves the profile with an Idempotency-Key and reloads the wizard", async () => {
    const client = stubClient({
      PATCH: { [PATH]: () => ok({ displayName: "Cedar", orgTimezone: "America/Denver" }) },
    });
    const onChanged = mount(client);
    type("Display name", "Cedar Ridge Hospice");
    save();

    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    const [path, init] = client.PATCH.mock.calls[0] as [string, { body: unknown }];
    expect(path).toBe(PATH);
    expect(init.body).toEqual({
      displayName: "Cedar Ridge Hospice",
      orgTimezone: "America/Denver",
    });
    expect(keyOf(client.PATCH.mock.calls[0] as unknown[])).toMatch(/\S+/);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText("Profile saved.")).toBeTruthy();
  });

  it("tells the tenant what to do when the server refuses the time zone, and keeps what was typed", async () => {
    const client = stubClient({ PATCH: { [PATH]: () => refused(422, "INVALID_ORG_TIMEZONE") } });
    mount(client);
    type("Time zone", "Mars/Olympus");
    save();

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /not a valid time zone.*America\/Denver/,
    );
    expect((screen.getByLabelText("Time zone") as HTMLInputElement).value).toBe("Mars/Olympus");
  });

  it("offers Re-verify on a stale step-up and brings the draft back on return", async () => {
    const client = stubClient({ PATCH: { [PATH]: () => refused(403, "STEP_UP_REQUIRED") } });
    const first = renderAt(
      "/x",
      [{ path: "/x", element: <OrganisationPanel {...panelProps(view, "account_created")} /> }],
      client,
    );
    type("Display name", "Cedar Ridge Hospice");
    save();
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    expect(await screen.findByText("step-up page")).toBeTruthy();
    first.unmount();

    renderAt(
      RETURNED_FROM_STEP_UP,
      [{ path: "/x", element: <OrganisationPanel {...panelProps(view, "account_created")} /> }],
      client,
    );
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe(
      "Cedar Ridge Hospice",
    );
  });

  it("reloads the wizard when the refusal says the step moved (its copy says it was reloaded)", async () => {
    const client = stubClient({ PATCH: { [PATH]: () => refused(409, "TENANT_NOT_ONBOARDING") } });
    const onChanged = mount(client);
    type("Display name", "Cedar Ridge Hospice");
    save();
    expect((await screen.findByRole("alert")).textContent).toMatch(/not in onboarding/i);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("drops a second submit while the first is in flight", async () => {
    const gate = deferred(ok({ displayName: "x", orgTimezone: "y" }));
    const client = stubClient({ PATCH: { [PATH]: gate.handler } });
    mount(client);
    type("Display name", "Cedar Ridge Hospice");
    save();
    save();
    gate.release();
    await waitFor(() => expect(screen.getByText("Profile saved.")).toBeTruthy());
    expect(client.PATCH).toHaveBeenCalledTimes(1);
  });

  it("reuses the same Idempotency-Key when the first attempt got no answer", async () => {
    let calls = 0;
    const client = stubClient({
      PATCH: {
        [PATH]: () => {
          calls += 1;
          if (calls === 1) throw new Error("offline");
          return ok({ displayName: "x", orgTimezone: "y" });
        },
      },
    });
    mount(client);
    type("Display name", "Cedar Ridge Hospice");
    save();
    await screen.findByText(/could not reach the server/i);
    save();
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(2));
    expect(keyOf(client.PATCH.mock.calls[1] as unknown[])).toBe(
      keyOf(client.PATCH.mock.calls[0] as unknown[]),
    );
  });

  it("is read-only for the compliance officer and says so", () => {
    renderAt(
      "/x",
      [
        {
          path: "/x",
          element: (
            <OrganisationPanel {...panelProps(view, "account_created", COMPLIANCE_OFFICER)} />
          ),
        },
      ],
      stubClient({}),
      COMPLIANCE_OFFICER,
    );
    expect(screen.queryByRole("button", { name: /save profile/i })).toBeNull();
    expect(screen.getByText(/your role cannot change the organization's profile/i)).toBeTruthy();
  });
});
