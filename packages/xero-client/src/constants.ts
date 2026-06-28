// @wardenx/xero-client — shared constants (split out so submodules reference the fail-closed sentinel
// without a cycle through ./index). Re-exported from ./index so the public name is unchanged.

/** Thrown (as an Error message) when a tenant has not connected Xero (no stored OAuth tokens). */
export const XERO_NOT_CONNECTED = "XERO_NOT_CONNECTED" as const;

/** Xero's documented per-tenant API base (raw transport target; no SDK import — see oauth.ts). */
export const XERO_API_BASE_URL = "https://api.xero.com" as const;

/** Reports endpoint for the Trial Balance report (`?date=` anchors the as-of close). */
export const XERO_TRIAL_BALANCE_PATH = "/api.xro/2.0/Reports/TrialBalance" as const;

/** Accounts endpoint for the chart of accounts. */
export const XERO_ACCOUNTS_PATH = "/api.xro/2.0/Accounts" as const;
