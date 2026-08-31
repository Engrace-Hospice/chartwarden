// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { AdmissionDetail } from "../admission-detail";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Sarah Miller",
  permissions: ["admission.read", "admission.update"],
};

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

interface ReadinessFixture {
  admissionId: string;
  status: string;
  canActivate: boolean;
  completed: number;
  blockingRemaining: number;
  requirements: Array<{
    code: string;
    label: string;
    status: string;
    blocking: boolean;
    message?: string;
    action?: string;
  }>;
}

function readiness(overrides?: Partial<ReadinessFixture>): ReadinessFixture {
  return { ...baseReadiness(), ...overrides };
}

function baseReadiness(): ReadinessFixture {
  return {
    admissionId,
    status: "action_required",
    canActivate: false,
    completed: 4,
    blockingRemaining: 2,
    requirements: [
      {
        code: "patient_identity",
        label: "Patient identity",
        status: "complete",
        blocking: true,
      },
      {
        code: "admission_details",
        label: "Admission details",
        status: "complete",
        blocking: true,
      },
      {
        code: "patient_privacy",
        label: "Patient privacy",
        status: "complete",
        blocking: true,
      },
      {
        code: "notice_of_rights",
        label: "Notice of Rights",
        status: "action_required",
        blocking: true,
        message: "Notice of Rights acknowledgment is required.",
        action: "ACKNOWLEDGE_NOR",
      },
      {
        code: "election_statement",
        label: "Election Statement",
        status: "action_required",
        blocking: true,
        message: "Election Statement must be signed.",
        action: "COMPLETE_ELECTION",
      },
      {
        code: "cti",
        label: "Certification of Terminal Illness",
        status: "complete",
        blocking: true,
      },
      { code: "f2f", label: "Face-to-Face", status: "not_applicable", blocking: false },
    ],
  };
}

function clientFor(readinessResponse = readiness()): ApiClient {
  return {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/admissions/{id}") {
        return ok({
          id: admissionId,
          state: "pending",
          status: "pending",
          version: 4,
          patientId: "patient-1",
          referralId: "referral-1",
          admissionAt: "2026-08-28T10:00:00.000Z",
          activatedAt: null,
          activationGate: { ready: false, missing: ["election_signed", "nor_acknowledged"] },
        });
      }
      if (path === "/api/v1/admissions/{id}/readiness") {
        return ok(readinessResponse);
      }
      if (path === "/api/v1/admissions/{admissionId}/hope") {
        return ok({
          admissionAssessment: {
            status: "completed",
            attention: { state: "none", severity: "none" },
          },
          huv1: { status: "open", attention: { state: "due_soon", severity: "warn" } },
          huv2: { status: "upcoming", attention: { state: "upcoming", severity: "info" } },
          dischargeAssessment: {
            status: "not_applicable",
            attention: { state: "none", severity: "none" },
          },
          sfvs: [{ status: "overdue", attention: { state: "overdue", severity: "critical" } }],
          summary: {
            actionableCount: 2,
            overdueCount: 1,
            dueSoonCount: 1,
            workflowIssueCount: 0,
            highestSeverity: "critical",
            nextDeadline: "2026-09-04T23:59:59.999Z",
          },
        });
      }
      if (path === "/api/v1/admissions/{id}/election-periods")
        return ok({ items: [{ id: "period-1", state: "active", version: 1 }], nextCursor: null });
      if (path === "/api/v1/patients/{patientId}/election-certification")
        return ok({
          admission: null,
          periods: [
            {
              id: "period-1",
              state: "pending",
              version: 1,
              sequenceNumber: 1,
              periodKind: "ninety_day",
              effectiveAt: null,
              scheduledEndAt: null,
              actualEndAt: null,
              electionStatement: null,
              cti: null,
            },
          ],
        });
      if (path === "/api/v1/admissions/{id}/compliance-windows")
        return ok({ items: [], nextCursor: null });
      return ok({ items: [], nextCursor: null });
    }),
    POST: vi.fn(async () => ok({ id: admissionId, state: "pending", version: 5 })),
    PATCH: vi.fn(async () => ok({ id: admissionId, state: "pending", version: 5 })),
  } as unknown as ApiClient;
}

function renderWithShell(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={[`/admissions/${admissionId}`]}>
      <ApiClientProvider client={client}>
        <SessionProvider session={session}>
          <Routes>
            <Route path="/admissions/:id" element={<AdmissionDetail />} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Admission intake workspace", () => {
  it("renders pending readiness from the server and keeps activation disabled", async () => {
    const client = clientFor();
    renderWithShell(client);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );
    expect(screen.getByText("4 of 7 items complete")).toBeTruthy();
    expect(
      screen.getAllByText("Notice of Rights acknowledgment is required.").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Election Statement must be signed.").length).toBeGreaterThan(0);
    expect(screen.getByText("HOPE Admission Assessment")).toBeTruthy();
    expect(screen.getAllByText("1 overdue or missed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Due soon").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Open HOPE" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Activate Admission" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/admissions/{id}/readiness",
      expect.objectContaining({ params: { path: { id: admissionId } } }),
    );
  });

  it("surfaces guided actions for admission details, election, and CTI blockers", async () => {
    const client = clientFor(
      readiness({
        completed: 3,
        blockingRemaining: 3,
        requirements: [
          {
            code: "admission_details",
            label: "Admission details",
            status: "action_required",
            blocking: true,
            message: "Missing admission date, terminal diagnosis, hospice medical director.",
            action: "COMPLETE_ADMISSION_DETAILS",
          },
          {
            code: "election_statement",
            label: "Election Statement",
            status: "action_required",
            blocking: true,
            message: "Election Statement is required.",
            action: "COMPLETE_ELECTION",
          },
          {
            code: "cti",
            label: "Certification of Terminal Illness",
            status: "action_required",
            blocking: true,
            message: "Certification of Terminal Illness is required.",
            action: "REVIEW_CTI",
          },
        ],
      }),
    );
    renderWithShell(client);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Intake" })).toBeTruthy(),
    );

    expect(
      screen.getAllByRole("button", { name: "Complete admission details" }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "Create Election Statement" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Create CTI" }).length).toBeGreaterThan(0);
  });
});
