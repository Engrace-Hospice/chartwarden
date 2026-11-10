// @vitest-environment jsdom
// Step 6, Locations: the administrator adds service locations through the same M2 route as Agency setup.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LocationsPanel } from "./locations-panel";
import {
  COMPLIANCE_OFFICER,
  ORG_ADMIN,
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

const ENTITIES = "/api/v1/provider-entities";
const LOCATIONS = "/api/v1/locations";
const view = wizardView([wizardStep("locations_seeded", 1, { owner: "org_admin" })]);
const ENTITY = {
  id: "pe-1",
  legalName: "Cedar Ridge Hospice LLC",
  doingBusinessAs: null,
  ccn: "051234",
  npi: "1234567893",
  status: "active",
};
const LOCATION = {
  id: "loc-1",
  providerEntityId: "pe-1",
  name: "Main office",
  addressLine1: "1 Cedar Way",
  addressLine2: null,
  city: "Fresno",
  state: "CA",
  postalCode: "93701",
  timezone: "America/Los_Angeles",
  status: "active",
};
const page = (...items: unknown[]) => ok({ items, nextCursor: null });
const BODY = {
  providerEntityId: "pe-1",
  name: "Main office",
  addressLine1: "1 Cedar Way",
  city: "Fresno",
  state: "CA",
  postalCode: "93701",
  timezone: "America/Los_Angeles",
};

const reads = (entities: unknown[], locations: unknown[]) => ({
  GET: { [ENTITIES]: () => page(...entities), [LOCATIONS]: () => page(...locations) },
});

function mount(
  client: ReturnType<typeof stubClient>,
  session = ORG_ADMIN,
  at: Parameters<typeof renderAt>[0] = "/x",
  onChanged = vi.fn(async () => undefined),
) {
  const rendered = renderAt(
    at,
    [
      {
        path: "/x",
        element: <LocationsPanel {...panelProps(view, "locations_seeded", session, onChanged)} />,
      },
    ],
    client,
    session,
  );
  return { onChanged, ...rendered };
}
const type = (label: RegExp | string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
async function fill(): Promise<void> {
  await screen.findByRole("button", { name: /add location/i });
  type(/location name/i, BODY.name);
  type(/address line 1/i, BODY.addressLine1);
  type(/^city/i, BODY.city);
  type(/^state/i, BODY.state);
  type(/zip/i, BODY.postalCode);
  type(/time zone/i, BODY.timezone);
}
const submit = (): void => {
  fireEvent.submit(
    screen.getByRole("button", { name: /add location|adding/i }).closest("form") as HTMLFormElement,
  );
};

describe("LocationsPanel", () => {
  it("lists the locations that exist", async () => {
    mount(stubClient(reads([ENTITY], [LOCATION])));
    expect(await screen.findByText("Main office")).toBeTruthy();
    expect(screen.getByText("At least one service location")).toBeTruthy();
  });

  it("creates a location with an Idempotency-Key and reloads the lists and the wizard", async () => {
    const client = stubClient({
      ...reads([ENTITY], []),
      POST: { [LOCATIONS]: () => ok({ id: "loc-2" }) },
    });
    const { onChanged } = mount(client);
    await fill();
    submit();

    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [string, { body: unknown }];
    expect(path).toBe(LOCATIONS);
    expect(init.body).toEqual(BODY);
    expect(keyOf(client.POST.mock.calls[0] as unknown[])).toMatch(/\S+/);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("refuses a malformed state without sending, and shows the server's refusal otherwise", async () => {
    const client = stubClient({
      ...reads([ENTITY], []),
      POST: {
        [LOCATIONS]: () => refused(409, "LOCATION_NAME_TAKEN", "a location with that name exists"),
      },
    });
    mount(client);
    await fill();
    type(/^state/i, "California");
    submit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/2-letter code/);
    expect(client.POST).not.toHaveBeenCalled();

    type(/^state/i, "CA");
    submit();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /location with that name exists/,
    );
  });

  it("asks for a provider entity first when there is none", async () => {
    mount(stubClient(reads([], [])));
    expect(await screen.findByText(/add a provider entity first/i)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /add location/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps the typed fields through Re-verify", async () => {
    const client = stubClient({
      ...reads([ENTITY], []),
      POST: { [LOCATIONS]: () => refused(403, "STEP_UP_REQUIRED") },
    });
    const first = mount(client);
    await fill();
    submit();
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    await screen.findByText("step-up page");
    first.unmount();

    mount(client, ORG_ADMIN, RETURNED_FROM_STEP_UP);
    await screen.findByRole("button", { name: /add location/i });
    expect((screen.getByLabelText(/location name/i) as HTMLInputElement).value).toBe("Main office");
  });

  it("drops a second submit while the first is in flight", async () => {
    const gate = deferred(ok({ id: "loc-2" }));
    const client = stubClient({ ...reads([ENTITY], []), POST: { [LOCATIONS]: gate.handler } });
    mount(client);
    await fill();
    submit();
    submit();
    gate.release();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
  });

  it("reuses the same Idempotency-Key when the first attempt got no answer", async () => {
    let calls = 0;
    const client = stubClient({
      ...reads([ENTITY], []),
      POST: {
        [LOCATIONS]: () => {
          calls += 1;
          if (calls === 1) throw new Error("offline");
          return ok({ id: "loc-2" });
        },
      },
    });
    mount(client);
    await fill();
    submit();
    await screen.findByText(/could not reach the server/i);
    submit();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(keyOf(client.POST.mock.calls[1] as unknown[])).toBe(
      keyOf(client.POST.mock.calls[0] as unknown[]),
    );
  });

  it("offers no form to a role without org.manage", () => {
    const client = stubClient({});
    mount(client, COMPLIANCE_OFFICER);
    expect(screen.getByText(/your role cannot see or add locations/i)).toBeTruthy();
    expect(client.GET).not.toHaveBeenCalled();
  });
});
