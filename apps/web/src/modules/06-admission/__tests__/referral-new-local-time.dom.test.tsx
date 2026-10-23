// #595: New Referral defaulted "Received at" to the UTC wall clock; the field reads it as local, so the stored
// instant was off by the viewer's UTC offset.
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../../shell/session";
import { ReferralNew } from "../referral-new";

const ORIGINAL_TZ = process.env.TZ;

describe("New referral — Received at default (#595)", () => {
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T02:15:00Z")); // 19:15 PDT on the 22nd
  });
  afterAll(() => {
    vi.useRealTimers();
    if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
    else process.env.TZ = ORIGINAL_TZ;
  });

  it("pre-fills the viewer's local time", () => {
    const empty = () =>
      Promise.resolve({ data: undefined, error: undefined, response: new Response(null) });
    const client = { GET: vi.fn(empty), POST: vi.fn(empty) };
    const session = { userId: "u-1", organizationId: "org-1", permissions: [] } as unknown as Session;
    const { container } = render(
      <ApiClientProvider client={client as unknown as ApiClient}>
        <SessionProvider session={session}>
          <MemoryRouter>
            <ReferralNew />
          </MemoryRouter>
        </SessionProvider>
      </ApiClientProvider>,
    );
    const field = container.querySelector<HTMLInputElement>('input[type="datetime-local"]');
    expect(field?.value).toBe("2026-10-22T19:15");
  });
  it("refuses a cleared Received at instead of throwing RangeError (#621)", () => {
    const empty = () =>
      Promise.resolve({ data: undefined, error: undefined, response: new Response(null) });
    const client = { GET: vi.fn(empty), POST: vi.fn(empty) };
    const session = { userId: "u-1", organizationId: "org-1", permissions: [] } as unknown as Session;
    const { container } = render(
      <ApiClientProvider client={client as unknown as ApiClient}>
        <SessionProvider session={session}>
          <MemoryRouter>
            <ReferralNew />
          </MemoryRouter>
        </SessionProvider>
      </ApiClientProvider>,
    );
    const field = container.querySelector<HTMLInputElement>('input[type="datetime-local"]');
    fireEvent.change(field as HTMLInputElement, { target: { value: "" } });
    fireEvent.change(container.querySelector<HTMLInputElement>("input#patientNameAtReceipt") ?? container.querySelectorAll("input")[0], { target: { value: "Jane Doe" } });
    fireEvent.click(screen.getByRole("button", { name: /save|create|submit/i }));
    expect(screen.getByText(/date and time the referral was received/i)).toBeTruthy();
    expect(client.POST).not.toHaveBeenCalled();
  });
});
