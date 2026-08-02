// apps/backend/src/modules/31-portal/telehealth/state-matrix.ts — M31-T05 (§3.8 D9 two-party-recording matrix).
//
// The §3.8 two-party-recording-consent state matrix as a PURE lookup. In production the authoritative rows
// live in `m38_state_recording_rule` (an M38 reference table — M31 reads, never owns), so the route layer
// (M31-T07) reads the live rule via the M38 seam; this module holds the PLATFORM FLOOR of the same 14 states
// so the recording-consent gate has a fail-CLOSED default even before the M38 lookup resolves, and so the
// determinism tests have a fixed baseline. The matrix is platform-floor: a tenant in a one-party state may
// OPT IN to two-party (tighten), never opt OUT of two-party in a two-party state (loosen forbidden, §3.8).

/**
 * §3.8 — the 14 two-party (all-party) recording-consent states. Sourced verbatim from the spec matrix:
 * CA, CT, DE, FL, HI, IL, MA, MD, MI, MT, NH, NV, PA, WA. Everywhere else is one-party-consent default.
 */
export const TWO_PARTY_RECORDING_STATES: ReadonlySet<string> = new Set([
  "CA", // Cal. Penal Code §632
  "CT", // Conn. Gen. Stat. §52-570d
  "DE", // Del. Code Title 11 §1335 (de facto)
  "FL", // Fla. Stat. §934.03
  "HI", // Haw. Rev. Stat. §711-1111 (in private places)
  "IL", // 720 ILCS 5/14-2
  "MA", // Mass. Gen. Laws ch. 272 §99
  "MD", // Md. Code Cts. & Jud. Proc. §10-402
  "MI", // Mich. Comp. Laws §750.539c (interpreted)
  "MT", // Mont. Code §45-8-213
  "NH", // N.H. Rev. Stat. §570-A:2
  "NV", // Nev. Rev. Stat. §200.620
  "PA", // 18 Pa. Cons. Stat. §5704
  "WA", // Wash. Rev. Code §9.73.030
]);

/**
 * §3.8 — does `stateCode` require all-party recording consent? A tenant may pass `tenantOptInStates` to
 * TIGHTEN (add one-party states to the two-party set as a policy choice); it can never loosen — a state in the
 * platform floor is two-party regardless of tenant config. An unknown / empty state code fails CLOSED to
 * two-party (treated as requiring consent) so a missing residence never becomes a silent one-party recording.
 */
export function isTwoPartyRecordingState(
  stateCode: string | null | undefined,
  tenantOptInStates?: Iterable<string>,
): boolean {
  if (stateCode == null || stateCode.trim() === "") return true; // fail closed on an unknown residence
  const code = stateCode.trim().toUpperCase();
  if (TWO_PARTY_RECORDING_STATES.has(code)) return true;
  if (tenantOptInStates) {
    for (const s of tenantOptInStates) {
      if (s.trim().toUpperCase() === code) return true;
    }
  }
  return false;
}
