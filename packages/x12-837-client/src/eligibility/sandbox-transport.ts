// @wardenx/x12-837-client — the fixture-backed SANDBOX HETS transport (dev / test ONLY).
//
// Answers every 270 with a synthetic 271 from ./fixtures, never touching a network. It exists so local dev
// and tests can exercise the full 270 → 271 → parse → persist path. The backend refuses to bind it when
// NODE_ENV=production (see the M23 HETS config); this module additionally stamps every synthetic 271 with
// ISA15 = `T` (test) so a sandbox answer can never be mistaken for a production one.
//
// Scenario selection: a fixed scenario from config, else a keyword in the 270's subscriber last name
// (e.g. a dev patient named "Openelection") — else `active_with_history`.
import { type Hets271Scenario, type SyntheticHospicePeriod, synthetic271 } from "./fixtures";
import type { HetsTransport } from "./transport";
import { X12FormatError, tokenizeInterchange } from "./x12-envelope";

const KEYWORD_SCENARIOS: readonly (readonly [string, Hets271Scenario])[] = [
  ["OPENELECTION", "open_election"],
  ["NOHOSPICE", "no_hospice_history"],
  ["INACTIVE", "inactive_part_a"],
  ["NOTFOUND", "mbi_not_found"],
  ["HETSDOWN", "system_unavailable"],
  ["REJECT999", "rejected_999"],
];

export interface SandboxHetsTransportOptions {
  /** Answer every request with this scenario (otherwise keyword-selected by subscriber last name). */
  readonly scenario?: Hets271Scenario;
  /** Replace the canned hospice history `active_with_history` answers with (dev / test fixtures). */
  readonly hospiceHistory?: readonly SyntheticHospicePeriod[];
}

/** Create the sandbox transport. Throws (content-free) if the 270 it receives is not a HETS 270. */
export function createSandboxHetsTransport(
  options: SandboxHetsTransportOptions = {},
): HetsTransport {
  return {
    kind: "sandbox",
    async exchange(request) {
      const { segments } = tokenizeInterchange(request.x12);
      const find = (id: string, q?: string) =>
        segments.find((s) => s[0] === id && (q === undefined || s[1] === q));
      const st = find("ST");
      const subscriber = find("NM1", "IL");
      const receiver = find("NM1", "1P");
      const trn = find("TRN", "1");
      const gs = find("GS");
      if (st?.[1] !== "270" || !subscriber || !receiver || !trn || !gs) {
        throw new X12FormatError("sandbox HETS received a payload that is not a HETS 270");
      }
      const lastName = subscriber[3] ?? "";
      const scenario =
        options.scenario ??
        KEYWORD_SCENARIOS.find(([kw]) => lastName.replace(/[^A-Z0-9]/g, "").includes(kw))?.[1] ??
        "active_with_history";
      return {
        x12: synthetic271(
          scenario,
          {
            traceNumber: trn[2] ?? "",
            submitterId: gs[2] ?? "",
            providerNpi: receiver[9] ?? "",
            mbi: subscriber[9] ?? "",
            lastName,
            firstName: subscriber[4] ?? "",
          },
          options.hospiceHistory,
        ),
      };
    },
  };
}
