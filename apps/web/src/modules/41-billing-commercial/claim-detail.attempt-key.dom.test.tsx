// The commercial claim detail's writes and the Idempotency-Key they carry. Mark ready, void, submit, the corrected draft and a validation
// override each create or change a record: one key per intent, so a retry after a lost reply replays instead of writing twice and any
// answer renews it. Re-validate only recomputes the rules against the claim as it is now: every click is a new request with its own key.
// Synthetic data only.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { clearAllDrafts } from "../../shell/ceremony-drafts";
import { CommercialClaimDetail } from "./claim-detail";
import {
  CLAIM_ID,
  type Call,
  PATIENT_ID,
  PAYER_ID,
  type Responder,
  claimDetailView,
  mountScreen,
  patientRoute,
  payerNameRoute,
} from "./commercial-test-harness";

const BASE = `/api/v1/billing/commercial/claims/${CLAIM_ID}`;
const REASON = "The payer confirmed by telephone that no authorization is required.";

/** What one attempt got: nothing at all (a dropped connection), a gateway page, or an HTTP answer from the API. */
type Reply = "no answer" | "gateway" | "refused" | "ok";

const BLOCKED = { error: { code: "COMMERCIAL_CLAIM_BLOCKED", message: "Blocked: fix it first." } };

/** A route that answers from `replies` in turn (then ok). */
function scripted(replies: Reply[], okBody: unknown, okStatus = 200): Responder {
  return () => {
    const next = replies.shift() ?? "ok";
    if (next === "no answer") throw new TypeError("Failed to fetch");
    if (next === "gateway") return { status: 502, body: {} };
    if (next === "refused") return { status: 409, body: BLOCKED };
    return { status: okStatus, body: okBody };
  };
}

interface Site {
  readonly name: string;
  readonly path: string;
  readonly okBody: unknown;
  readonly okStatus?: number;
  /** A success leaves this claim's screen, so there is no second press to compare. */
  readonly endsScreenOnSuccess?: true;
  readonly permissions: string[];
  readonly claim?: Record<string, unknown>;
  readonly extra?: Record<string, Responder>;
  /** Everything up to, and including, the click that sends the write. */
  readonly press: () => Promise<void>;
}

const grants = ["commercial_billing.read", "commercial_billing.write"];

const SITES: readonly Site[] = [
  {
    name: "mark ready",
    path: `${BASE}/ready`,
    okBody: { claimId: CLAIM_ID, state: "ready" },
    permissions: grants,
    press: async () => fireEvent.click(await screen.findByRole("button", { name: "Mark ready" })),
  },
  {
    name: "void",
    path: `${BASE}/void`,
    okBody: { claimId: CLAIM_ID, state: "void" },
    permissions: grants,
    press: async () => {
      const confirm = screen.queryByRole("button", { name: "Confirm void" });
      fireEvent.click(confirm ?? (await screen.findByRole("button", { name: "Void claim" })));
      if (!confirm) fireEvent.click(await screen.findByRole("button", { name: "Confirm void" }));
    },
  },
  {
    name: "submit",
    path: `${BASE}/submit`,
    okBody: { submissionId: "s-1", claimId: CLAIM_ID, status: "queued" },
    okStatus: 202,
    permissions: ["commercial_billing.read", "commercial_billing.submit"],
    claim: { claim: { ...(claimDetailView().claim as object), state: "ready" } },
    extra: {
      [`GET ${BASE}/send-gate`]: () => ({
        body: {
          claimId: CLAIM_ID,
          state: "ready",
          patientId: PATIENT_ID,
          canSubmit: true,
          clearinghouseKey: "synthetic-ch",
          reasons: [],
        },
      }),
    },
    press: async () => {
      if (!screen.queryByRole("button", { name: "Confirm and queue submission" }))
        fireEvent.click(await screen.findByRole("button", { name: "Review submission checks" }));
      fireEvent.click(await screen.findByRole("button", { name: "Confirm and queue submission" }));
    },
  },
  {
    name: "corrected draft",
    path: `${BASE}/corrections/clearinghouse-rejection`,
    okBody: { claimId: "corrected-id", parentClaimId: CLAIM_ID, replayed: false },
    okStatus: 201,
    endsScreenOnSuccess: true,
    permissions: grants,
    claim: {
      claim: { ...(claimDetailView().claim as object), state: "rejected" },
      correction: {
        correctionOfClaimId: null,
        correctionKind: null,
        correctionReasonCode: null,
        relatedClaims: [],
        rejectedCorrection: { eligible: true, reasonCode: "VERIFIED_CLEARINGHOUSE_REJECTION" },
      },
    },
    press: async () =>
      fireEvent.click(await screen.findByRole("button", { name: "Create corrected draft" })),
  },
  {
    name: "validation override",
    path: `${BASE}/validation-results/r-1/override`,
    okBody: { overrideId: "o-1", auditEventId: "e-1", ruleKey: "authorization_on_file" },
    okStatus: 201,
    permissions: [...grants, "commercial_billing.override_validation"],
    press: async () => {
      if (!screen.queryByLabelText(/Reason to override Authorization On File/))
        fireEvent.click(
          await screen.findByRole("button", { name: "Override Authorization On File" }),
        );
      fireEvent.change(await screen.findByLabelText(/Reason to override Authorization On File/), {
        target: { value: REASON },
      });
      fireEvent.click(await screen.findByRole("button", { name: "Record override" }));
    },
  },
];

const keyOf = (call: Call | undefined): string => call?.headers.get("Idempotency-Key") ?? "";

/** Mount the claim detail, press the site's control once per reply, and return the keys its write was sent with. */
async function pressWith(site: Site, replies: Reply[]): Promise<string[]> {
  const calls: Call[] = [];
  const writes = () => calls.filter((c) => c.method === "POST" && c.path === site.path);
  mountScreen({
    routes: {
      [`GET ${BASE}`]: () => ({ body: claimDetailView(site.claim) }),
      [`GET /api/v1/patients/${PATIENT_ID}`]: patientRoute,
      [`GET /api/v1/mdm/payer/${PAYER_ID}`]: payerNameRoute,
      [`POST ${site.path}`]: scripted(replies, site.okBody, site.okStatus),
      ...site.extra,
    },
    calls,
    element: <CommercialClaimDetail />,
    routePath: "/commercial/billing/claims/:claimId",
    entry: `/commercial/billing/claims/${CLAIM_ID}`,
    permissions: site.permissions,
  });
  for (const sent of [1, 2]) {
    await site.press();
    await waitFor(() => expect(writes()).toHaveLength(sent));
    await waitFor(() => expect(screen.queryByText(/…$/)).toBeNull());
  }
  return writes().map(keyOf);
}

afterEach(() => {
  cleanup();
  clearAllDrafts();
});

describe("CommercialClaimDetail: one Idempotency-Key per write intent", () => {
  describe.each(SITES)("$name", (site) => {
    it("retries a request that got no answer under the same key", async () => {
      const [first, second] = await pressWith(site, ["no answer"]);

      expect(first).toBeTruthy();
      expect(second).toBe(first);
    });

    it("retries after a gateway page under the same key", async () => {
      const [first, second] = await pressWith(site, ["gateway"]);

      expect(first).toBeTruthy();
      expect(second).toBe(first);
    });

    it("sends a new key after the API's refusal", async () => {
      const [first, second] = await pressWith(site, ["refused"]);

      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
    });
  });

  describe.each(SITES.filter((site) => !site.endsScreenOnSuccess))("$name", (site) => {
    it("sends a new key after a success", async () => {
      const [first, second] = await pressWith(site, ["ok"]);

      expect(first).toBeTruthy();
      expect(second).not.toBe(first);
    });
  });

  it("re-validate sends a new key on every click, even after a request that got no answer", async () => {
    const calls: Call[] = [];
    mountScreen({
      routes: {
        [`GET ${BASE}`]: () => ({ body: claimDetailView() }),
        [`GET /api/v1/patients/${PATIENT_ID}`]: patientRoute,
        [`GET /api/v1/mdm/payer/${PAYER_ID}`]: payerNameRoute,
        [`POST ${BASE}/validate`]: scripted(["no answer"], {
          runId: "r",
          outcome: "all_pass",
          results: [],
        }),
      },
      calls,
      element: <CommercialClaimDetail />,
      routePath: "/commercial/billing/claims/:claimId",
      entry: `/commercial/billing/claims/${CLAIM_ID}`,
      permissions: grants,
    });
    const validations = () =>
      calls.filter((c) => c.method === "POST" && c.path === `${BASE}/validate`);

    for (const sent of [1, 2]) {
      fireEvent.click(await screen.findByRole("button", { name: "Re-validate" }));
      await waitFor(() => expect(validations()).toHaveLength(sent));
      await waitFor(() => expect(screen.queryByText(/…$/)).toBeNull());
    }

    const [first, second] = validations().map(keyOf);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});
