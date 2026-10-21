// @chartwarden/medicaid-adapters — structured adapter errors. The backend maps these to a 502/503 with ops
// guidance; they never leak PHI.
export type MedicaidAdapterErrorCode =
  | "ADAPTER_DENY_STUB" // a Phase-1 deny-stub state was invoked
  | "ADAPTER_NOT_WIRED" // a real adapter method whose live endpoint/creds are not configured yet
  | "UNSUPPORTED_STATE"; // no adapter registered for the claim's state

export class MedicaidAdapterError extends Error {
  readonly code: MedicaidAdapterErrorCode;
  readonly state: string;
  readonly opsHint: string;
  constructor(code: MedicaidAdapterErrorCode, state: string, message: string, opsHint: string) {
    super(message);
    this.name = "MedicaidAdapterError";
    this.code = code;
    this.state = state;
    this.opsHint = opsHint;
  }
}
