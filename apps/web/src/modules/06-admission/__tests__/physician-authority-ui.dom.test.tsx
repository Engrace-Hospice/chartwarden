// @vitest-environment jsdom
// 42 CFR 418.25(a) admission recommendation + 42 CFR 418.26(b) discharge order UI.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  AdmissionRecommendationDrawer,
  AdmissionRecommendationSection,
} from "../admission-recommendation-ui";
import {
  DischargeOrderFields,
  DischargeOrderSection,
  dischargeOrderBody,
  dischargeOrderRequiredAtFiling,
  emptyDischargeOrder,
} from "../discharge-order-ui";

const ADM = "adm-1";
const MD = "10000000-0000-4000-8000-000000000001";
const IDG = "10000000-0000-4000-8000-000000000003";

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function clientFor(overrides: Record<string, unknown> = {}): ApiClient {
  return {
    GET: vi.fn(async (path: string) => {
      if (path in overrides) return ok(overrides[path]);
      if (path === "/api/v1/admissions/{id}/physician-signers") {
        return ok({
          items: [
            { userId: MD, name: "Dr. Director", capacities: ["medical_director"] },
            { userId: IDG, name: "Dr. Team", capacities: ["idg_physician_member"] },
          ],
        });
      }
      return ok({});
    }),
    POST: vi.fn(async () => ok({ id: ADM, state: "pending", version: 4 })),
  } as unknown as ApiClient;
}

const wrap = (client: ApiClient, node: JSX.Element) =>
  render(<ApiClientProvider client={client}>{node}</ApiClientProvider>);

describe("admission recommendation (418.25(a))", () => {
  it("advises recording when absent and offers the action", () => {
    const onRecord = vi.fn();
    wrap(
      clientFor(),
      <AdmissionRecommendationSection
        admissionId={ADM}
        recommendation={null}
        editable
        onRecord={onRecord}
      />,
    );
    expect(screen.getByText("Review advised")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record recommendation" }));
    expect(onRecord).toHaveBeenCalled();
  });

  it("shows a recorded recommendation locked, with the recommender's capacity", async () => {
    wrap(
      clientFor(),
      <AdmissionRecommendationSection
        admissionId={ADM}
        editable
        onRecord={() => undefined}
        recommendation={{
          recommendedByUserId: IDG,
          capacity: "idg_physician_member",
          recommendedAt: "2026-10-05T15:00:00Z",
          attendingConsulted: true,
          attendingConsultNote: null,
        }}
      />,
    );
    expect(screen.getByText("Recorded")).toBeTruthy();
    expect(screen.getByText("IDG physician member")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Dr. Team")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Record recommendation" })).toBeNull();
  });

  it("the drawer lists only eligible signers, requires a note when the attending wasn't consulted, and posts", async () => {
    const client = clientFor();
    const onSaved = vi.fn();
    wrap(
      client,
      <AdmissionRecommendationDrawer
        admissionId={ADM}
        version={3}
        hasAttending
        onClose={() => undefined}
        onSaved={onSaved}
      />,
    );
    const picker = (await screen.findByLabelText(/Recommending physician/)) as HTMLSelectElement;
    await waitFor(() => expect(picker.disabled).toBe(false));
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      "Select a physician",
      "Dr. Director — Medical director",
      "Dr. Team — IDG physician member",
    ]);
    fireEvent.change(picker, { target: { value: IDG } });
    fireEvent.change(screen.getByLabelText(/Attending physician consulted/), {
      target: { value: "no" },
    });
    const submit = screen.getByRole("button", {
      name: "Record recommendation",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Consultation note/), {
      target: { value: "Attending unreachable over the weekend." },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/admissions/{id}/admission-recommendation",
      expect.objectContaining({
        body: expect.objectContaining({
          recommendedByUserId: IDG,
          capacity: "idg_physician_member",
          attendingConsulted: false,
          attendingConsultNote: "Attending unreachable over the weekend.",
          ifVersion: 3,
        }),
      }),
    );
  });
});

describe("discharge order (418.26(b))", () => {
  it("is required at filing only for live discharges on/after 2026-10-01", () => {
    expect(dischargeOrderRequiredAtFiling("moved_out_of_service_area", "2026-10-01")).toBe(true);
    expect(dischargeOrderRequiredAtFiling("moved_out_of_service_area", "2026-09-30")).toBe(false);
    expect(dischargeOrderRequiredAtFiling("death", "2026-10-10")).toBe(false);
    expect(dischargeOrderRequiredAtFiling("for_cause", "2026-10-10")).toBe(false);
  });

  it("captures the signer + text into the route-39 body", async () => {
    function Harness(): JSX.Element {
      const [draft, setDraft] = useState(emptyDischargeOrder());
      return (
        <>
          <DischargeOrderFields
            admissionId={ADM}
            reason="no_longer_terminal"
            dischargeDate="2026-10-10"
            value={draft}
            onChange={setDraft}
          />
          <output data-testid="body">{JSON.stringify(dischargeOrderBody(draft) ?? null)}</output>
        </>
      );
    }
    wrap(clientFor(), <Harness />);
    expect(screen.getByText("Required")).toBeTruthy();
    const picker = (await screen.findByLabelText(/Ordering physician/)) as HTMLSelectElement;
    await waitFor(() => expect(picker.disabled).toBe(false));
    fireEvent.change(picker, { target: { value: MD } });
    fireEvent.change(screen.getByLabelText(/Order text/), {
      target: { value: "Discharge: no longer terminally ill." },
    });
    const body = JSON.parse(screen.getByTestId("body").textContent ?? "null");
    expect(body).toMatchObject({
      signedByUserId: MD,
      capacity: "medical_director",
      orderText: "Discharge: no longer terminally ill.",
    });
    expect(typeof body.signedAt).toBe("string");
  });

  it("renders nothing for a death discharge capture", () => {
    const { container } = wrap(
      clientFor(),
      <DischargeOrderFields
        admissionId={ADM}
        reason="death"
        dischargeDate="2026-10-10"
        value={emptyDischargeOrder()}
        onChange={() => undefined}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("shows the order and the persisted for-cause cosigner name/NPI on the admission", async () => {
    wrap(
      clientFor({
        "/api/v1/admissions/{id}/discharge-order": {
          discharge: {
            dischargeEventId: "de-1",
            reason: "for_cause",
            status: "completed",
            dischargeDate: "2026-10-04",
            orderRequired: true,
            order: {
              signedByUserId: MD,
              signedByName: "Dr. Director",
              capacity: "medical_director",
              signedAt: "2026-10-04T16:00:00Z",
              orderText: "Discharge for cause per policy.",
              orderReference: null,
            },
            cosigner: {
              name: "Dr. Director",
              npi: "1234567893",
              cosignedAt: "2026-10-04T16:00:00Z",
            },
          },
        },
      }),
      <DischargeOrderSection admissionId={ADM} />,
    );
    await waitFor(() => expect(screen.getByText("Order on file")).toBeTruthy());
    expect(screen.getByText("1234567893")).toBeTruthy();
    expect(screen.getByText("Medical director")).toBeTruthy();
    expect(screen.getByText("Discharge for cause per policy.")).toBeTruthy();
  });

  it("renders nothing until the admission has a discharge", async () => {
    const client = clientFor({ "/api/v1/admissions/{id}/discharge-order": { discharge: null } });
    const { container } = wrap(client, <DischargeOrderSection admissionId={ADM} />);
    await waitFor(() => expect(client.GET).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
