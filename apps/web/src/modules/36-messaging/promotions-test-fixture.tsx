// Shared by the WP 3.7 chart-proposal tests: one proposal in the API's shape, a client double and a mount helper.
import { render } from "@testing-library/react";
import type { ChartPromotionDto } from "@wardenx/types";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { SessionProvider } from "../../shell/session";

export const PROMOTION_FIXTURE: ChartPromotionDto = {
  id: "pr1",
  message_id: "m1",
  channel_id: "c1",
  patient_id: "p1",
  target_module: "m8",
  target_kind: "encounter_addendum",
  suggested_target_ref: null,
  status: "proposed",
  requested_by: "u1",
  requested_by_display_name: "Alex Nurse",
  requested_at: "2026-10-14T08:00:00.000Z",
  source_author_user_id: "u2",
  source_author_display_name: "Sam Lead",
  source_sent_at: "2026-10-14T07:00:00.000Z",
  result_ref: null,
  decided_by: null,
  decided_at: null,
  reason_code: null,
  allowed_actions: ["withdraw"],
};

export const listAnswer = (promotions: unknown[], enabled = true) => ({
  data: { enabled, promotions },
});

/** A fresh client object per test: the enabled read is cached per client. */
export function mountWithClient(
  ui: ReactNode,
  options: {
    list?: unknown;
    post?: unknown;
    permissions?: string[];
  } = {},
) {
  const GET = vi.fn().mockResolvedValue(options.list ?? listAnswer([]));
  const POST = (options.post as ReturnType<typeof vi.fn> | undefined) ?? vi.fn();
  const client = { GET, POST } as unknown as ApiClient;
  const session = {
    userId: "u1",
    organizationId: "o1",
    permissions: options.permissions ?? ["messaging.promote"],
  };
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <SessionProvider session={session}>{ui}</SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST };
}
