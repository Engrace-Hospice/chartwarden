// The order editor must tell the user why a save failed, and must not offer a verbal order for a
// kind the server refuses to take verbally (§2.3: level-of-care change and recertification are
// written-only). Both failed silently before: the form POSTed a level-of-care change as a verbal
// order, the API answered `{ error: { message, details } }`, and the editor read `error.message`
// from the wrong level so every refusal read as the generic "could not save" text.
import { render, screen } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { OrderEditor, findings, message } from "./order-editor";
import { kindDefaults } from "./order-kind-fields";

const SESSION = {
  userId: "u",
  organizationId: "o",
  membershipId: "m",
  roles: ["rn_case_manager"],
  permissions: [],
  isAdmin: false,
};

function mount(verbal: boolean) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <OrderEditor open onClose={() => {}} patientId="p" verbal={verbal} onSaved={() => {}} />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

describe("order editor", () => {
  it("does not offer written-only kinds on a verbal order", () => {
    mount(true);
    const kinds = screen.getByLabelText("Order kind") as HTMLSelectElement;
    const labels = Array.from(kinds.options).map((o) => o.textContent);
    expect(labels).toContain("Lab");
    expect(labels).not.toContain("Level of care change");
    expect(labels).not.toContain("Recertification");
  });

  it("offers every kind on a written order", () => {
    mount(false);
    const kinds = screen.getByLabelText("Order kind") as HTMLSelectElement;
    expect(Array.from(kinds.options).map((o) => o.textContent)).toContain("Level of care change");
  });

  it("reads the API error envelope instead of the generic fallback", () => {
    const body = {
      error: {
        code: "VALIDATION_FAILED",
        message: "request failed validation",
        details: [
          { field: "data.clinicalJustification", message: "Must be at least 20 characters" },
        ],
      },
    };
    expect(message(body)).toBe("clinicalJustification: Must be at least 20 characters");
    expect(findings(body)).toEqual({ clinicalJustification: "Must be at least 20 characters" });
    expect(message({ error: { message: "Verbal orders are not allowed for this kind" } })).toBe(
      "Verbal orders are not allowed for this kind",
    );
    expect(message(undefined)).toMatch(/could not save/);
  });

  it("sends fastingRequired for a lab order even when the box is never touched", () => {
    expect(kindDefaults("lab")).toMatchObject({ fastingRequired: false, priority: "routine" });
  });

  it("seeds the select values the form displays", () => {
    expect(kindDefaults("level_of_care_change")).toEqual({ fromLevel: "rhc", toLevel: "irc" });
  });
});
