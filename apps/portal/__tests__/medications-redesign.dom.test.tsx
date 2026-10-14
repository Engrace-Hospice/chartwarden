import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createApiClient } from "@wardenx/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/app";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PATIENT = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";
const medications = {
  items: [
    {
      medicationOrderId: ORDER,
      drugName: "Sample medication",
      dose: "5 mg",
      route: "oral",
      scheduleSummary: "Every morning",
      isPrn: false,
    },
    {
      medicationOrderId: "44444444-4444-4444-8444-444444444444",
      drugName: "As-needed medication",
      dose: "2 mg",
      isPrn: true,
    },
  ],
};
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

type Handler = (
  url: URL,
  method: string,
  request: Request,
) => Response | Promise<Response>;
function clientFor(handler: Handler) {
  return createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/portal/sessions/current")
        return json({
          portalAccountId: "55555555-5555-4555-8555-555555555555",
          activePatientId: PATIENT,
          scopeSet: [],
          relationship: "patient_self",
          status: "active",
        });
      if (url.pathname === "/api/v1/portal/care-summary")
        return json({
          patient: { layLabel: "Sample Patient" },
          upcomingVisitsCount: 0,
          recentVisitsCount: 0,
          activeMedicationsCount: 2,
          unreadMessagesCount: 0,
          pendingDocumentSharesCount: 0,
        });
      return handler(url, request.method, request);
    },
  });
}
const defaultHandler: Handler = (url) => {
  if (url.pathname === "/api/v1/portal/medications/active")
    return json(medications);
  if (url.pathname === "/api/v1/portal/administrations/recent")
    return json({ items: [] });
  return json({ error: { code: "UNAVAILABLE" } }, 404);
};

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Record a dose given" }));
  return screen.getByRole("dialog", { name: "Record a dose given" });
}
function fillReport(dialog: HTMLElement) {
  fireEvent.change(
    within(dialog).getByRole("combobox", { name: "Medication" }),
    { target: { value: ORDER } },
  );
  fireEvent.change(
    within(dialog).getByRole("spinbutton", { name: "Amount actually given" }),
    { target: { value: "5" } },
  );
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Unit actually given" }),
    { target: { value: "mg" } },
  );
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Route used" }),
    { target: { value: "oral" } },
  );
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Caregiver attestation" }),
    { target: { value: "I personally witnessed this dose being given." } },
  );
}

describe("portal medications redesign", () => {
  beforeEach(() => {
    window.history.pushState({}, "", `/p/${PATIENT}/medications`);
    vi.restoreAllMocks();
  });

  it("displays medication cards, PRN distinction and a separate history empty state", async () => {
    render(<PortalApp client={clientFor(defaultHandler)} />);
    expect(
      await screen.findByRole("heading", { name: "Sample medication" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "As-needed medication" }),
    ).toBeTruthy();
    expect(screen.getByText("As needed (PRN)")).toBeTruthy();
    expect(screen.getByText("Every morning")).toBeTruthy();
    expect(screen.getByText("No recent administrations to show.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows useful empty states without enabling dose recording", async () => {
    render(
      <PortalApp
        client={clientFor((url) => {
          if (
            url.pathname.includes("/medications/active") ||
            url.pathname.includes("/administrations/recent")
          )
            return json({ items: [] });
          return json({}, 404);
        })}
      />,
    );
    expect(
      await screen.findByRole("heading", {
        name: "No active medications to show",
      }),
    ).toBeTruthy();
    expect(screen.getByText("No recent administrations to show.")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Record a dose given" }),
    ).toBeNull();
  });

  it("preserves medications on history failure and retries only history", async () => {
    let historyCalls = 0;
    let medCalls = 0;
    render(
      <PortalApp
        client={clientFor((url) => {
          if (url.pathname.endsWith("/medications/active")) {
            medCalls++;
            return json(medications);
          }
          if (url.pathname.endsWith("/administrations/recent"))
            return ++historyCalls === 1
              ? json({ error: {} }, 503)
              : json({
                  items: [
                    {
                      drugName: "Sample medication",
                      administeredAmount: 5,
                      administeredUnit: "mg",
                      administeredAt: "2026-10-10T09:00:00Z",
                    },
                  ],
                });
          return json({}, 404);
        })}
      />,
    );
    expect(
      await screen.findByRole("heading", {
        name: "Recent administrations unavailable",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Sample medication" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("list", { name: "Recent administrations" }),
        ).getByText("5 mg"),
      ).toBeTruthy(),
    );
    expect(historyCalls).toBe(2);
    expect(medCalls).toBe(1);
  });

  it("shows a medication error independently from the history", async () => {
    render(
      <PortalApp
        client={clientFor((url) => {
          if (url.pathname.endsWith("/medications/active"))
            return json({ error: {} }, 500);
          if (url.pathname.endsWith("/administrations/recent"))
            return json({
              items: [
                {
                  drugName: "Record B",
                  administeredAt: "2026-10-10T09:00:00Z",
                },
              ],
            });
          return json({}, 404);
        })}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Medications unavailable" }),
    ).toBeTruthy();
    expect(screen.getByText("Record B")).toBeTruthy();
  });

  it("requires valid amount, a real date, review and explicit confirmation before POST", async () => {
    let posts = 0;
    render(
      <PortalApp
        client={clientFor((url, method) => {
          if (method === "POST") {
            posts++;
            return json({
              administrationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            });
          }
          return defaultHandler(url, method, new Request(url));
        })}
      />,
    );
    await screen.findByRole("heading", { name: "Sample medication" });
    const dialog = openDialog();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Review administration",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fillReport(dialog);
    fireEvent.change(within(dialog).getByLabelText("Date and time given"), {
      target: { value: "2099-01-01T11:00" },
    });
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Review administration",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Date and time given"), {
      target: { value: "2026-01-08T11:00" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Review administration" }),
    );
    expect(
      within(dialog).getByText("Check these details before recording"),
    ).toBeTruthy();
    expect(posts).toBe(0);
    const confirmButton = within(dialog).getByRole("button", {
      name: "Confirm and record",
    });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: /I confirm/ }),
    );
    fireEvent.click(confirmButton);
    expect(
      await within(dialog).findByRole("heading", {
        name: "Administration recorded",
      }),
    ).toBeTruthy();
    expect(posts).toBe(1);
  });

  it("sends administered time, not submission time, and does not duplicate concurrent requests", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const sent: unknown[] = [];
    render(
      <PortalApp
        client={clientFor((url, method, request) => {
          if (method === "POST") {
            sent.push(request.clone().text());
            return pending;
          }
          return defaultHandler(url, method, request);
        })}
      />,
    );
    await screen.findByRole("heading", { name: "Sample medication" });
    const dialog = openDialog();
    fillReport(dialog);
    fireEvent.change(within(dialog).getByLabelText("Date and time given"), {
      target: { value: "2026-01-08T11:00" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Review administration" }),
    );
    fireEvent.click(within(dialog).getByRole("checkbox"));
    const button = within(dialog).getByRole("button", {
      name: "Confirm and record",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(sent).toHaveLength(1));
    const payload = JSON.parse(await (sent[0] as Promise<string>));
    expect(payload.medicationOrderId).toBe(ORDER);
    expect(payload.administeredAmount).toBe(5);
    expect(new Date(payload.administeredAt).getTime()).toBe(
      new Date("2026-01-08T11:00").getTime(),
    );
    await act(async () => {
      finish(json({ status: "recorded" }));
    });
    expect(
      await within(dialog).findByText("Administration recorded"),
    ).toBeTruthy();
  });

  it("explains access denial and preserves the report for editing", async () => {
    render(
      <PortalApp
        client={clientFor((url, method, request) =>
          method === "POST"
            ? json({ error: { code: "FORBIDDEN" } }, 403)
            : defaultHandler(url, method, request),
        )}
      />,
    );
    await screen.findByRole("heading", { name: "Sample medication" });
    const dialog = openDialog();
    fillReport(dialog);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Review administration" }),
    );
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Confirm and record" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "isn't authorized",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Edit details" }),
    );
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: "Caregiver attestation",
        }) as HTMLTextAreaElement
      ).value,
    ).toContain("personally witnessed");
  });

  it("drops obsolete patient responses when the route patient changes", async () => {
    let resolveFirst!: (value: Response) => void;
    let reads = 0;
    render(
      <PortalApp
        client={clientFor((url) => {
          if (url.pathname.endsWith("/medications/active")) {
            reads++;
            if (reads === 1)
              return new Promise<Response>((resolve) => {
                resolveFirst = resolve;
              });
            return json({
              items: [
                {
                  medicationOrderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                  drugName: "Current patient medicine",
                },
              ],
            });
          }
          if (url.pathname.endsWith("/administrations/recent"))
            return json({ items: [] });
          return json({}, 404);
        })}
      />,
    );
    await waitFor(() => expect(reads).toBe(1));
    await act(async () => {
      window.history.pushState({}, "", `/p/${OTHER_PATIENT}/medications`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(
      await screen.findByRole("heading", { name: "Current patient medicine" }),
    ).toBeTruthy();
    await act(async () =>
      resolveFirst(
        json({
          items: [
            { medicationOrderId: ORDER, drugName: "Previous patient medicine" },
          ],
        }),
      ),
    );
    expect(screen.queryByText("Previous patient medicine")).toBeNull();
  });
});
