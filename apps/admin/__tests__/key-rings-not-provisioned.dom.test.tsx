// #596 F-045: a 404 from the key-ring read means no ring exists; the screen said only "Could not load".
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KeyRings } from "../src/modules/34-saas-platform/key-rings";

async function notFound(): Promise<Response> {
  return new Response(
    JSON.stringify({ error: { code: "NOT_FOUND", message: "none", correlationId: "c" } }),
    {
      status: 404,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("Key rings — tenant with no ring (#596)", () => {
  it("says no key ring has been provisioned, not a generic load failure", async () => {
    const client = createApiClient({ baseUrl: "http://localhost", fetch: notFound });
    render(
      <ApiClientProvider client={client}>
        <KeyRings />
      </ApiClientProvider>,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "chartwarden-demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(await screen.findByText(/No key ring has been provisioned/)).toBeTruthy();
  });
});
