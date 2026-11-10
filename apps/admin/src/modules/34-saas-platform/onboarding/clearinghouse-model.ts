// apps/admin/src/modules/34-saas-platform/onboarding — step 7, Billing: clearinghouse, as pure functions of the server's masked view:
// which facts hold, and which actions to OFFER. The server owns every rule (verify before activate, the BAA gate, the vendor lock);
// this only keeps the operator from being handed a button the server is certain to refuse.
import type { Fact, operations } from "@chartwarden/ui";

export type ClearinghouseView =
  operations["getApiV1PlatformTenantsByOrgSlugClearinghouse"]["responses"][200]["content"]["application/json"];
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
export const isTransmitting = (view: ClearinghouseView): boolean =>
  view.vendor === "stedi" || view.vendor === "claimmd";

/** This tenant's own choice is on record (not the deployment's shared fallback, not nothing). */
const isChosen = (view: ClearinghouseView): boolean =>
  view.vendor !== null && view.source === "tenant";

/**
 * Whether the server will ask for a credential with this choice: a first choice, and whenever the vendor or the mode changes
 * (a change starts the new key at draft). Billing outside takes none.
 */
export function needsSecret(
  current: ClearinghouseView,
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

export function clearinghouseFacts(view: ClearinghouseView): Fact[] {
  if (!isChosen(view)) {
    return [
      {
        key: "chosen",
        label: "A clearinghouse is chosen",
        state: "pending",
        ...(view.source === "platform_env"
          ? {
              detail:
                "Only the deployment's shared setting names one; none is recorded for this tenant.",
            }
          : {}),
      },
    ];
  }
  if (!isTransmitting(view)) {
    return [
      {
        key: "chosen",
        label: "Billing outside ChartWarden",
        state: "ok",
        detail:
          "ChartWarden transmits nothing for this tenant: no credential, BAA or activation is needed.",
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
      label: "The tenant recorded its vendor BAA",
      state: view.baa ? "ok" : "pending",
      detail: view.baa
        ? `${view.baa.documentRef}, effective ${view.baa.effectiveDate}`
        : "The tenant records this itself, in its own settings.",
    },
    {
      key: "baa-verified",
      label: view.baa?.revoked ? "The vendor BAA was revoked" : "An operator verified the vendor BAA",
      state: view.baa?.revoked ? "blocked" : view.baa?.verified ? "ok" : "pending",
      ...(view.baa?.revoked
        ? {
            detail: `Revoked ${when(view.baa.revokedAt ?? view.baa.recordedAt)}${view.baa.revokedReasonCode ? ` (${view.baa.revokedReasonCode.replaceAll("_", " ")})` : ""}.`,
          }
        : view.baa?.verified
          ? { detail: `Verified ${when(view.baa.verified.at)}` }
          : {}),
    },
    ...(view.baa?.previousRevocation
      ? [
          {
            key: "baa-previous-revocation",
            label: "A previous vendor BAA was revoked",
            state: "pending" as const,
            detail: `${when(view.baa.previousRevocation.at)}${view.baa.previousRevocation.sameDocument ? "; this record points to the same document and verification needs an explicit acknowledgement" : ""}.`,
          },
        ]
      : []),
    {
      key: "connection",
      label: "The connection is verified",
      state: connected ? "ok" : "pending",
      ...(!connected && lastTest
        ? {
            detail: `Last test ${when(lastTest.at)}: ${OUTCOME_TEXT[lastTest.outcome] ?? lastTest.outcome}.`,
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

export function clearinghouseActions(view: ClearinghouseView): ClearinghouseActions {
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
