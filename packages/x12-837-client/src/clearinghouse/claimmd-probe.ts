// @chartwarden/x12-837-client — Claim.MD connection test (the cheapest call that proves an account key opens an account).
//
// `uploadlist` for a day long before any account could have uploaded something answers HTTP 200 and an empty list (observed
// 2026-11-05, contract doc "run 3"), and a bad key answers error 21 (observed 2026-11-04): so it proves the key without
// sending a claim, reading a response, or touching any patient data (a Filename is all `uploadlist` ever shows, and ours
// are PHI-free). Nothing here logs or returns the key or any vendor text.
import { hasList, postForm, vendorError } from "./claimmd-wire";

/** `ok`: the key opened the account. `credential_rejected`: Claim.MD refused the key. `unreachable`: inconclusive (a network or vendor fault, a rate block, an unreadable answer). */
export type ConnectionProbeOutcome = "ok" | "credential_rejected" | "unreachable";

/** A day before Claim.MD offered an API: no account has an upload on it, so the answer is an empty list. */
export const CLAIMMD_PROBE_DAY = "2020-01-01";

export async function probeClaimMdAccountKey(
  accountKey: string,
  opts: { readonly fetch?: typeof fetch } = {},
): Promise<ConnectionProbeOutcome> {
  const wire = await postForm(opts.fetch ?? fetch, "uploadlist", accountKey, {
    UploadDate: CLAIMMD_PROBE_DAY,
    Page: "1",
  });
  if (!wire.ok) return wire.status === 401 ? "credential_rejected" : "unreachable";
  const error = vendorError(wire.body);
  if (error) return error.credential ? "credential_rejected" : "unreachable";
  // Positive evidence only: an answer that does not even look like a (possibly empty) list is unknown, never a pass.
  return hasList(wire.body, "file") ? "ok" : "unreachable";
}
