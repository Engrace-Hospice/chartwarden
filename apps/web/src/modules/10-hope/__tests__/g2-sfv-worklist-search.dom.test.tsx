// @vitest-environment jsdom
// Group g2: the SFV queue's search matches the Triggered text the clinician SEES (the viewer's zone), not only the raw UTC instant.
// A US zone BEFORE any Date is built.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Chicago";

import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SfvWorklist } from "../sfv-worklist";

afterEach(cleanup);
afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Sep 11 23:59 in Chicago (CDT) is Sep 12 04:59 UTC.
const ROW = {
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  patientId: "22222222-bbbb-4bbb-8bbb-222222222222",
  admissionId: "adm-1",
  triggeringAssessmentId: "33333333-cccc-4ccc-8ccc-333333333333",
  status: "open",
  triggeredAt: "2026-09-12T04:59:00.000Z",
  dueAt: "2999-01-01T10:00:00.000Z",
};

async function mount(): Promise<HTMLInputElement> {
  const stubFetch = async (): Promise<Response> => json({ sfvs: [ROW] });
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter>
        <SfvWorklist />
      </MemoryRouter>
    </ApiClientProvider>,
  );
  await screen.findByText("2026-09-11 23:59");
  return screen.getByLabelText("Search symptom follow-up visits") as HTMLInputElement;
}

describe("searching the SFV queue by the Triggered time", () => {
  it("finds the row by the date and time the column shows", async () => {
    const search = await mount();

    fireEvent.change(search, { target: { value: "2026-09-11 23:59" } });

    expect(screen.getByText("2026-09-11 23:59")).toBeTruthy();
    expect(screen.queryByText("No SFVs")).toBeNull();
  });

  it("still finds the row by its raw instant", async () => {
    const search = await mount();

    fireEvent.change(search, { target: { value: "2026-09-12t04:59" } });

    expect(screen.getByText("2026-09-11 23:59")).toBeTruthy();
  });

  it("finds nothing for a time that is neither shown nor stored", async () => {
    const search = await mount();

    fireEvent.change(search, { target: { value: "2026-09-12 04:59" } });

    expect(screen.getByText("No SFVs")).toBeTruthy();
  });
});
