// @vitest-environment jsdom
// The census quick-summary panel prints its own "MRN" label, so the identifier beside it must not start with the label again
// (the patient service stores "MRN-" + 12 hex digits). The column in the list keeps the identifier as stored. Synthetic data only.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { PatientListCensus } from "./patient-list-census";

const STORED_MRN = "MRN-FB250B6C6A8A";

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const stubFetch: typeof fetch = async (input, init) => {
  const { pathname } = new URL(new Request(input as RequestInfo, init).url);
  if (pathname === "/api/v1/patients") {
    return json({
      items: [
        {
          id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
          organizationId: "org-1",
          mrn: STORED_MRN,
          lastName: "Charlotte",
          firstName: "Emma",
          dob: "1970-01-01",
          status: "active",
        },
      ],
      nextCursor: null,
    });
  }
  if (pathname.endsWith("/identifiers")) return json({ identifiers: [] });
  if (pathname.endsWith("/privacy-flags")) return json({ flags: [] });
  return json({});
};

afterEach(cleanup);

describe("patient census quick summary", () => {
  it("prints the MRN once beside its label", async () => {
    const user = userEvent.setup();
    const client = createApiClient({ baseUrl: "http://localhost", fetch: stubFetch });
    render(
      <ApiClientProvider client={client}>
        <MemoryRouter>
          <PatientListCensus />
        </MemoryRouter>
      </ApiClientProvider>,
    );

    await user.click(await screen.findByText(/Charlotte, Emma|Emma Charlotte/));

    // The panel's own label is a span; the list column's is a table header.
    await screen.findByRole("complementary");
    const label = screen.getAllByText("MRN").find((element) => element.tagName === "SPAN");
    expect(label?.parentElement?.textContent).toBe("MRNFB250B6C6A8A");
    // The list column still shows the identifier as stored.
    expect(screen.getByText(STORED_MRN)).toBeTruthy();
  });
});
