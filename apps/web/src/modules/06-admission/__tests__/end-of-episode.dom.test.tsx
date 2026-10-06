import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { DeathPronouncement, validateDeath } from "../death-pronouncement";
import { DischargeCosign, validateCosign } from "../discharge-cosign";
import { localToday } from "../end-of-episode-ui";
import { TransferIn, validateTransfer } from "../transfer-in";

// The physician directory lookup is exercised in shell/entity-lookups.dom.test.tsx; here it is a plain
// input that reports the typed id as the chosen option.
vi.mock("../../../shell/entity-lookups", () => ({
  MdmEntityLookupField: (props: {
    label: string;
    value: string;
    error?: string;
    onChange: (v: string, o: { id: string; label: string; searchLabel: string } | null) => void;
  }) => (
    <label>
      {props.label}
      <input
        value={props.value}
        onChange={(e) =>
          props.onChange(e.target.value, {
            id: e.target.value,
            label: "Dr. Kim",
            searchLabel: "Dr. Kim",
          })
        }
      />
      {props.error ? <span>{props.error}</span> : null}
    </label>
  ),
}));

const ADM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHYS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Dr. Ana Reyes",
  permissions: ["admission.read", "discharge.death", "discharge.cosign_for_cause", "transfer.in"],
};

const ok = (data: unknown, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});
const fail = (status: number, code: string, field?: string) => ({
  data: undefined,
  error: { error: { code, message: code, ...(field ? { details: [{ field }] } : {}) } },
  response: new Response(null, { status }),
});

function admission(state: string, extra: Record<string, unknown> = {}) {
  return {
    id: ADM,
    state,
    version: 3,
    patientId: "p-1",
    admissionAt: "2026-08-01T12:00:00.000Z",
    hospicePhysicianId: PHYS,
    hospicePhysician: { id: PHYS, displayName: "Dr. Lee", npi: "1234567890" },
    ...extra,
  };
}

/** GET that answers the admission read and 404s everything else (banner identity, periods). */
function getFor(adm: ReturnType<typeof admission>) {
  return vi.fn(async (path: string) =>
    path === "/api/v1/admissions/{id}" ? ok(adm) : fail(404, "NOT_FOUND"),
  );
}

function mount(path: string, el: JSX.Element, routePath: string, client: object) {
  return render(
    <ApiClientProvider client={client as unknown as ApiClient}>
      <SessionProvider session={session}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={routePath} element={el} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

describe("validators", () => {
  const today = "2026-10-06";
  it("death: requires certifier, place of death, narrative ≥10, date within admission..today", () => {
    expect(
      validateDeath(
        {
          deathDate: "2026-10-07",
          placeOfDeath: "",
          certifierId: "",
          certifierLabel: "",
          narrative: "short",
        },
        "2026-08-01",
        today,
      ),
    ).toEqual({
      deathDate: expect.stringMatching(/future/),
      placeOfDeath: "Choose where the patient died.",
      certifierId: expect.any(String),
      narrative: expect.any(String),
    });
    expect(
      validateDeath(
        {
          deathDate: "2026-07-01",
          placeOfDeath: "home",
          certifierId: PHYS,
          certifierLabel: "",
          narrative: "x".repeat(10),
        },
        "2026-08-01",
        today,
      ),
    ).toEqual({ deathDate: expect.stringMatching(/before the admission/) });
  });
  it("cosign: name and 10-digit NPI", () => {
    expect(validateCosign("", "123")).toEqual({
      name: expect.any(String),
      npi: expect.any(String),
    });
    expect(validateCosign("Dr. A", "1234567890")).toEqual({});
  });
  it("transfer: CCN shape, period ≥1, start ≤ transfer date", () => {
    const e = validateTransfer(
      {
        otherHospiceName: "Sunrise",
        otherHospiceCcn: "12ab",
        effectiveDate: "2026-10-01",
        priorBenefitPeriodSequence: "0",
        priorElectionStartDate: "2026-10-02",
        hospiceMedicalDirectorId: PHYS,
        hospiceMedicalDirectorLabel: "",
        attendingPhysicianId: "",
        attendingPhysicianLabel: "",
        narrative: "Records received by fax",
      },
      today,
    );
    expect(Object.keys(e).sort()).toEqual([
      "otherHospiceCcn",
      "priorBenefitPeriodSequence",
      "priorElectionStartDate",
    ]);
  });
});

describe("DeathPronouncement", () => {
  it("blocks the form on a non-dischargeable admission", async () => {
    const client = { GET: getFor(admission("discharged")), POST: vi.fn() };
    mount(`/admissions/${ADM}/death`, <DeathPronouncement />, "/admissions/:id/death", client);
    expect(await screen.findByText(/can only be recorded on an active/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows field errors and does not post when the form is incomplete", async () => {
    const client = { GET: getFor(admission("active")), POST: vi.fn() };
    mount(`/admissions/${ADM}/death`, <DeathPronouncement />, "/admissions/:id/death", client);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(screen.getByText("Select the pronouncing physician.")).toBeTruthy();
    expect(screen.getByText("Choose where the patient died.")).toBeTruthy();
    // The place-of-death hint (claim patient status 40/41/42) stays visible beside the error.
    expect(screen.getByText(/death patient status on the final claim \(40 home/)).toBeTruthy();
    expect(screen.getAllByText(/at least 10 characters/).length).toBeGreaterThan(0);
    expect(client.POST).not.toHaveBeenCalled();
  });
});

describe("DeathPronouncement submit", () => {
  it("reviews, signs and posts reason=death with the certifier", async () => {
    const POST = vi.fn(async () => ok({ id: DE, state: "completed", version: 0 }, 201));
    const client = { GET: getFor(admission("active")), POST };
    mount(`/admissions/${ADM}/death`, <DeathPronouncement />, "/admissions/:id/death", client);
    fireEvent.change(await screen.findByLabelText(/Date of death/), {
      target: { value: "2026-09-30" },
    });
    fireEvent.change(screen.getByLabelText(/Place of death/), { target: { value: "facility" } });
    fireEvent.change(screen.getByLabelText(/Pronouncing physician/), { target: { value: PHYS } });
    fireEvent.change(screen.getByLabelText(/Pronouncement note/), {
      target: { value: "  Pronounced at 03:10, family present.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("Dr. Kim")).toBeTruthy();
    expect(screen.getByText("Facility (hospital, nursing home, inpatient unit)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign and record death" }));
    await screen.findByText("Death recorded");
    expect(POST).toHaveBeenCalledWith("/api/v1/admissions/{id}/discharge", {
      params: { path: { id: ADM } },
      body: {
        reason: "death",
        dischargeDate: "2026-09-30",
        narrative: "Pronounced at 03:10, family present.",
        deathCertifierId: PHYS,
        placeOfDeath: "facility",
      },
    });
  });

  it("after success shows every step Complete and re-reads the admission (rail shows Bereavement)", async () => {
    const POST = vi.fn(async () => ok({ id: DE, state: "completed", version: 0 }, 201));
    let recorded = false;
    const GET = vi.fn(async (path: string) =>
      path === "/api/v1/admissions/{id}"
        ? ok(admission(recorded ? "bereavement" : "active"))
        : fail(404, "NOT_FOUND"),
    );
    POST.mockImplementation(async () => {
      recorded = true;
      return ok({ id: DE, state: "completed", version: 0 }, 201);
    });
    mount(`/admissions/${ADM}/death`, <DeathPronouncement />, "/admissions/:id/death", {
      GET,
      POST,
    });
    fireEvent.change(await screen.findByLabelText(/Date of death/), {
      target: { value: "2026-09-30" },
    });
    fireEvent.change(screen.getByLabelText(/Place of death/), { target: { value: "home" } });
    fireEvent.change(screen.getByLabelText(/Pronouncing physician/), { target: { value: PHYS } });
    fireEvent.change(screen.getByLabelText(/Pronouncement note/), {
      target: { value: "Pronounced at 03:10, family present." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign and record death" }));
    await screen.findByText("Death recorded");

    const nav = screen.getByRole("navigation", { name: "Death workflow steps" });
    await waitFor(() => expect(nav.textContent).not.toMatch(/In progress/));
    expect(nav.textContent?.match(/Complete/g)).toHaveLength(3);
    await waitFor(() => expect(screen.getAllByText("Bereavement").length).toBeGreaterThan(0));
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("returns to the form on DEATH_CERTIFIER_INVALID", async () => {
    const POST = vi.fn(async () => fail(422, "DEATH_CERTIFIER_INVALID"));
    const client = { GET: getFor(admission("on_hold")), POST };
    mount(`/admissions/${ADM}/death`, <DeathPronouncement />, "/admissions/:id/death", client);
    fireEvent.change(await screen.findByLabelText(/Place of death/), {
      target: { value: "home" },
    });
    fireEvent.change(screen.getByLabelText(/Pronouncing physician/), {
      target: { value: PHYS },
    });
    fireEvent.change(screen.getByLabelText(/Pronouncement note/), {
      target: { value: "Pronounced by RN." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign and record death" }));
    expect(
      await screen.findAllByText("Select the physician who pronounced or certified the death."),
    ).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  });

  it("maps PLACE_OF_DEATH_REQUIRED back onto the place-of-death field", async () => {
    const POST = vi.fn(async () => fail(422, "PLACE_OF_DEATH_REQUIRED"));
    const client = { GET: getFor(admission("active")), POST };
    mount(`/admissions/${ADM}/death`, <DeathPronouncement />, "/admissions/:id/death", client);
    fireEvent.change(await screen.findByLabelText(/Place of death/), {
      target: { value: "unknown" },
    });
    fireEvent.change(screen.getByLabelText(/Pronouncing physician/), { target: { value: PHYS } });
    fireEvent.change(screen.getByLabelText(/Pronouncement note/), {
      target: { value: "Pronounced by hospice RN." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("Unknown")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign and record death" }));
    expect(await screen.findAllByText("Choose where the patient died.")).toHaveLength(2);
    expect(screen.getByLabelText(/Place of death/)).toBeTruthy();
  });
});

describe("DischargeCosign", () => {
  it("posts name, NPI and the ?version= lock, then shows the result", async () => {
    const POST = vi.fn(async () => ok({ id: DE, state: "completed", version: 1 }));
    mount(
      `/discharges/${DE}/cosign?version=2&admissionId=${ADM}`,
      <DischargeCosign />,
      "/discharges/:id/cosign",
      { GET: getFor(admission("active")), POST },
    );
    fireEvent.change(await screen.findByLabelText(/NPI/), { target: { value: "12345-67890" } });
    const submit = screen.getByRole("button", { name: "Cosign discharge" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(submit);
    await screen.findByText("Discharge cosigned");
    expect(POST).toHaveBeenCalledWith("/api/v1/discharges/{id}/cosign-for-cause", {
      params: { path: { id: DE } },
      body: { cosignerName: "Dr. Ana Reyes", cosignerNpi: "1234567890", ifVersion: 2 },
    });
  });

  it("maps a stale version and a non-pending discharge to clear messages", async () => {
    const POST = vi
      .fn()
      .mockResolvedValueOnce(fail(409, "VERSION_MISMATCH"))
      .mockResolvedValueOnce(fail(409, "INVALID_STATE"));
    mount(`/discharges/${DE}/cosign`, <DischargeCosign />, "/discharges/:id/cosign", {
      GET: vi.fn(),
      POST,
    });
    fireEvent.change(screen.getByLabelText(/NPI/), { target: { value: "1234567890" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Cosign discharge" }));
    expect(await screen.findByText(/changed since the link was created/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cosign discharge" }));
    expect(await screen.findByText(/not awaiting a medical-director cosign/)).toBeTruthy();
    expect((POST.mock.calls[0] as unknown[])[1]).toMatchObject({ body: { ifVersion: 0 } });
  });

  it("sends the clinician to step-up when the server asks for it", async () => {
    const POST = vi.fn(async () => fail(403, "STEP_UP_REQUIRED"));
    mount(`/discharges/${DE}/cosign`, <DischargeCosign />, "/discharges/:id/cosign", {
      GET: vi.fn(),
      POST,
    });
    fireEvent.change(screen.getByLabelText(/NPI/), { target: { value: "1234567890" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Cosign discharge" }));
    expect(await screen.findByText("elsewhere")).toBeTruthy();
  });
});

describe("TransferIn", () => {
  it("keeps a long admission status inside the rail card (wraps, full label as tooltip)", async () => {
    const client = { GET: getFor(admission("notice_of_rights_acknowledged")), POST: vi.fn() };
    mount(`/admissions/${ADM}/transfer-in`, <TransferIn />, "/admissions/:id/transfer-in", client);
    const label = await screen.findByText("Notice Of Rights Acknowledged");
    expect(label.style.whiteSpace).toBe("normal");
    const holder = label.closest(".wx-rail-status-pill") as HTMLElement;
    expect(holder.getAttribute("title")).toBe("Notice Of Rights Acknowledged");
    expect(holder.style.maxWidth).toBe("100%");
  });

  it("walks the steps, locks the CTI physician to the admission's, and posts the body", async () => {
    const POST = vi.fn(async () => ok({ id: "t-1", state: "created", version: 0 }, 201));
    const client = { GET: getFor(admission("pending")), POST };
    mount(`/admissions/${ADM}/transfer-in`, <TransferIn />, "/admissions/:id/transfer-in", client);

    fireEvent.change(await screen.findByLabelText(/Hospice name/), {
      target: { value: "Sunrise Hospice" },
    });
    fireEvent.change(screen.getByLabelText(/CMS Certification Number/), {
      target: { value: "1a2b3c" },
    });
    fireEvent.change(screen.getByLabelText(/Transfer date/), { target: { value: "2026-09-20" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

    fireEvent.change(await screen.findByLabelText(/Benefit period number/), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText(/Period start date/), {
      target: { value: "2026-08-15" },
    });
    expect((screen.getByLabelText(/Hospice physician \(CTI\)/) as HTMLInputElement).value).toBe(
      "Dr. Lee",
    );
    fireEvent.change(screen.getByLabelText(/Transfer note/), {
      target: { value: "Family relocated; records received." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Record transfer" }));

    await screen.findByText("Transfer recorded");
    expect(POST).toHaveBeenCalledWith("/api/v1/admissions/{id}/transfer-in", {
      params: { path: { id: ADM } },
      body: {
        direction: "in",
        effectiveDate: "2026-09-20",
        otherHospiceName: "Sunrise Hospice",
        otherHospiceCcn: "1A2B3C",
        priorBenefitPeriodSequence: 2,
        priorElectionStartDate: "2026-08-15",
        hospiceMedicalDirectorId: PHYS,
        narrative: "Family relocated; records received.",
      },
    });
  });

  it("maps TRANSFER_LIMIT_EXCEEDED", async () => {
    const POST = vi.fn(async () => fail(409, "TRANSFER_LIMIT_EXCEEDED"));
    const client = { GET: getFor(admission("pending")), POST };
    mount(`/admissions/${ADM}/transfer-in`, <TransferIn />, "/admissions/:id/transfer-in", client);
    fireEvent.change(await screen.findByLabelText(/Hospice name/), { target: { value: "S" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    fireEvent.change(await screen.findByLabelText(/Benefit period number/), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText(/Period start date/), {
      target: { value: localToday() },
    });
    fireEvent.change(screen.getByLabelText(/Transfer note/), {
      target: { value: "Transferring in today." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Record transfer" }));
    await waitFor(() =>
      expect(screen.getByText("Only one transfer is allowed per benefit period.")).toBeTruthy(),
    );
  });
});
