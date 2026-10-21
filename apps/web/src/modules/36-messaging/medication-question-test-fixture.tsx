// Shared by the WP 3.10 medication-question tests: an options answer, a client double and a mount helper.
import { render } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

export const NURSE = { user_id: "u-nurse", display_name: "Nora Nurse" };
export const COLLEAGUE = { user_id: "u-col", display_name: "Cal Colleague" };

export const optionsAnswer = (overrides: Record<string, unknown> = {}) => ({
  data: {
    enabled: true,
    patient_linked: true,
    patient_id: "p1",
    nurse: NURSE,
    colleagues: [COLLEAGUE],
    links_enabled: true,
    ...overrides,
  },
});

export const OPTIONS_PATH = "/api/v1/messaging/channels/{id}/medication-questions/options";
export const ASK_PATH = "/api/v1/messaging/channels/{id}/medication-questions";

export const sentAnswer = (overrides: Record<string, unknown> = {}) => ({
  data: {
    message_id: "m1",
    channel_id: "c1",
    patient_id: "p1",
    routed: true,
    task: null,
    created: true,
    ...overrides,
  },
  response: { status: 201 },
});

export const refusal = (status: number, code: string) => ({
  error: { error: { code } },
  response: { status },
});

type Handler = (path: string) => unknown;

/** A fresh client per test. `get` answers the options route, `medications` the medication list. */
export function mountWithClient(
  ui: ReactNode,
  options: { get?: Handler; post?: ReturnType<typeof vi.fn> } = {},
) {
  const GET = vi.fn((path: string) =>
    Promise.resolve(
      options.get
        ? options.get(path)
        : path === OPTIONS_PATH
          ? optionsAnswer()
          : {
              data: {
                orders: [{ id: "med1", drugName: "Morphine", strength: "5 mg", status: "active" }],
              },
            },
    ),
  );
  const POST = options.post ?? vi.fn().mockResolvedValue(sentAnswer());
  const client = { GET, POST } as unknown as ApiClient;
  const view = render(
    <MemoryRouter>
      <ApiClientProvider client={client}>{ui}</ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST, client, ...view };
}
