// @chartwarden/gusto-client — shared constants (split out so submodules reference the fail-closed sentinel
// without a cycle through ./index). Re-exported from ./index so the public name is unchanged.

/** Thrown (as an Error message) when a tenant has not connected Gusto (no stored OAuth tokens). */
export const GUSTO_NOT_CONNECTED = "GUSTO_NOT_CONNECTED" as const;

/** Gusto's documented API base (raw transport target; no SDK import — see oauth.ts). */
export const GUSTO_API_BASE_URL = "https://api.gusto.com" as const;

/** Per-company payroll endpoint feeding Worksheet S-3 Part II paid-hours/salary-by-discipline. */
export const GUSTO_PAYROLLS_PATH = "/v1/companies/{companyId}/payrolls" as const;
