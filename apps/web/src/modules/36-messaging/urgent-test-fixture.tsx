// Shared by the WP 4.1 urgent tests: an options answer, an SBAR policy answer, a client double and a mount helper.
import { render } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

export const RN = { user_id: "u-rn", display_name: "Rita Nurse" };
export const MD = { user_id: "u-md", display_name: "Mo Doctor" };

export const OPTIONS_PATH = "/api/v1/messaging/channels/{id}/urgent-messages/options";
export const SEND_PATH = "/api/v1/messaging/channels/{id}/urgent-messages";
export const POLICY_PATH = "/api/v1/messaging/sbar/policy";

export const optionsAnswer = (overrides: Record<string, unknown> = {}) => ({
  data: {
    enabled: true,
    patient_linked: true,
    patient_id: "p1",
    recipients: [RN, MD],
    ...overrides,
  },
});

export const policyAnswer = {
  data: {
    minChars: { situation: 3, background: 3, assessment: 3, recommendation: 3 },
    maxChars: 2000,
    requirePatientChannel: false,
    hints: {},
    customized: false,
  },
  response: { status: 200 },
};

export const sentAnswer = (overrides: Record<string, unknown> = {}) => ({
  data: {
    message_id: "m1",
    channel_id: "c1",
    patient_id: "p1",
    recipient_user_id: RN.user_id,
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

/** A fresh client per test. `get` answers the options and policy routes. */
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
          : path === POLICY_PATH
            ? policyAnswer
            : { error: {}, response: { status: 404 } },
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
