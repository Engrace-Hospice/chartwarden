// packages/ui/src/web/clearinghouse — step 7, Billing: clearinghouse, as pure functions of the server's masked view: which facts hold,
// and which actions to OFFER. The server owns every rule (verify before activate, the BAA gate, the vendor lock); this only keeps the
// person from being handed a button the server is certain to refuse. Hoisted from the admin onboarding wizard: the view schema is the
// same on the platform and the tenant lane.
import type { operations } from "../../core/api";
import type { Fact } from "../components/fact-list";

export type ClearinghouseView =
  operations["getApiV1PlatformTenantsByOrgSlugClearinghouse"]["responses"][200]["content"]["application/json"];
/**
 * The view the shared model and form read: the platform view minus `hasContract`. The tenant's view has no such field (a tenant cannot
 * change its billing service mode), and nothing here reads it, so both lanes' views fit.
 */
export type ClearinghouseSharedView = Omit<ClearinghouseView, "hasContract">;
export type ClearinghouseVendor = "stedi" | "claimmd" | "outside";
export type ClearinghouseMode = "test" | "production";

export const VENDOR_LABEL: Readonly<Record<string, string>> = {
  stedi: "Stedi",
  claimmd: "Claim.MD",
  outside: "Billing outside ChartWarden",
  direct_mac: "Direct to the MAC",
  in_memory: "In-memory test double",
};
export const MODE_LABEL: Readonly<Record<ClearinghouseMode, string>> = {
  test: "Test",
  production: "Production",
};

/** A vendor ChartWarden sends claims through with the tenant's own sealed credential (not `outside`, not nothing). */
export const isTransmitting = (view: ClearinghouseSharedView): boolean =>
  view.vendor === "stedi" || view.vendor === "claimmd";

/** This tenant's own choice is on record (not the deployment's shared fallback, not nothing). */
export const isChosen = (view: ClearinghouseSharedView): boolean =>
  view.vendor !== null && view.source === "tenant";

/**
 * Whether the server will ask for a credential with this choice: a first choice, and whenever the vendor or the mode changes
 * (a change starts the new key at draft). Billing outside takes none.
 */
export function needsSecret(
  current: ClearinghouseSharedView,
  choice: { vendor: ClearinghouseVendor; mode: ClearinghouseMode },
): boolean {
  if (choice.vendor === "outside") return false;
  if (!isChosen(current)) return true;
  return current.vendor !== choice.vendor || current.mode !== choice.mode;
}

const OUTCOME_TEXT: Record<string, string> = {
  ok: "the connection answered",
  credential_rejected: "the vendor rejected the credential",
  unreachable: "the vendor could not be reached",
};

const when = (iso: string): string => new Date(iso).toLocaleString();

/** The words a lane gives the facts: an operator reads about "the tenant", the tenant about "your organization". */
export interface ClearinghouseWording {
  /** Detail on "A clearinghouse is chosen" while only the deployment's shared setting names one. */
  readonly platformEnvDetail: string;
  /** Detail on "Billing outside ChartWarden". */
  readonly outsideDetail: string;
  readonly baaRecordedLabel: string;
  /** Detail on the BAA fact while none is recorded. */
  readonly baaNotRecordedDetail: string;
  readonly baaVerifiedLabel: string;
}

export const OPERATOR_WORDING: ClearinghouseWording = {
  platformEnvDetail:
    "Only the deployment's shared setting names one; none is recorded for this tenant.",
  outsideDetail:
    "ChartWarden transmits nothing for this tenant: no credential, BAA or activation is needed.",
  baaRecordedLabel: "The tenant recorded its vendor BAA",
  baaNotRecordedDetail: "The tenant records this itself, in its own settings.",
  baaVerifiedLabel: "An operator verified the vendor BAA",
};

/** The text a connection test's outcome reads as ("the vendor rejected the credential"). */
export const testOutcomeText = (outcome: string): string => OUTCOME_TEXT[outcome] ?? outcome;

export function clearinghouseFacts(
  view: ClearinghouseSharedView,
  wording: ClearinghouseWording = OPERATOR_WORDING,
): Fact[] {
  if (!isChosen(view)) {
    return [
      {
        key: "chosen",
        label: "A clearinghouse is chosen",
        state: "pending",
        ...(view.source === "platform_env" ? { detail: wording.platformEnvDetail } : {}),
      },
    ];
  }
  if (!isTransmitting(view)) {
    return [
      {
        key: "chosen",
        label: "Billing outside ChartWarden",
        state: "ok",
        detail: wording.outsideDetail,
      },
    ];
  }
  const label = VENDOR_LABEL[view.vendor ?? ""] ?? "The vendor";
  const lastTest = view.lastTest;
  const connected = view.status === "verified" || view.status === "active";
  return [
    {
      key: "chosen",
      label: "A clearinghouse is chosen",
      state: "ok",
      detail: `${label}${view.mode ? `, ${MODE_LABEL[view.mode].toLowerCase()} mode` : ""}`,
    },
    {
      key: "secret",
      label: "The vendor credential is on file",
      state: view.hasSecret ? "ok" : "pending",
    },
    {
      key: "baa-recorded",
      label: wording.baaRecordedLabel,
      state: view.baa ? "ok" : "pending",
      detail: view.baa
        ? `${view.baa.documentRef}, effective ${view.baa.effectiveDate}`
        : wording.baaNotRecordedDetail,
    },
    {
      key: "baa-verified",
      label: wording.baaVerifiedLabel,
      state: view.baa?.verified ? "ok" : "pending",
      ...(view.baa?.verified ? { detail: `Verified ${when(view.baa.verified.at)}` } : {}),
    },
    {
      key: "connection",
      label: "The connection is verified",
      state: connected ? "ok" : "pending",
      ...(!connected && lastTest
        ? {
            detail: `Last test ${when(lastTest.at)}: ${testOutcomeText(lastTest.outcome)}.`,
          }
        : {}),
    },
    {
      key: "active",
      label: "The clearinghouse is active",
      state: view.status === "active" ? "ok" : "pending",
    },
  ];
}

export interface ClearinghouseActions {
  readonly canVerifyBaa: boolean;
  readonly canRevokeBaa: boolean;
  readonly canVerifyConnection: boolean;
  /**
   * What to say where an Activate button used to be: only the tenant's own billing administrator activates its clearinghouse
   * (CW-AC-17: the platform lane has no activate route), so the operator is told who does, and what is still missing first. Null
   * when there is nothing to say yet (the connection is not verified).
   */
  readonly tenantActivationNote: string | null;
}

const NO_ACTIONS: ClearinghouseActions = {
  canVerifyBaa: false,
  canRevokeBaa: false,
  canVerifyConnection: false,
  tenantActivationNote: null,
};

export function clearinghouseActions(view: ClearinghouseSharedView): ClearinghouseActions {
  if (!isChosen(view) || !isTransmitting(view)) return NO_ACTIONS;
  const baaVerified = view.baa?.verified != null;
  const connectionVerified = view.status === "verified";
  return {
    canVerifyBaa: view.baaRequired && view.baa !== null && !view.baa.revoked && !baaVerified,
    canRevokeBaa: view.baaRequired && view.baa !== null && !view.baa.revoked,
    canVerifyConnection: view.status === "draft" && view.hasSecret,
    tenantActivationNote: !connectionVerified
      ? null
      : view.baaRequired && !baaVerified
        ? "Verify the vendor BAA first: the tenant records it, then an operator verifies it. The tenant's own billing administrator then activates the clearinghouse."
        : "The tenant's own billing administrator activates the clearinghouse from their own settings; this step settles when they do.",
  };
}
