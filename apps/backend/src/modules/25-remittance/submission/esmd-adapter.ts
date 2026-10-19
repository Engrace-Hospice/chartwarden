// M25 milestone 6a - the esMD adapter SHELL. UNBOUND: there is no esMD code in the repo, no gateway, no credentials and
// no verified specification, so this reports `bound: false` for every org and has no `transmit` / `poll`. 6b replaces
// it once the SME and vendor facts exist (it stays unbound until a complete per-tenant config does, the DoseSpot
// posture). It must never invent a gateway, endpoint or payload shape.
import { buildGuidedChecklist } from "../domain";
import type { FilingChannelAdapter } from "./channel-adapter";

export const ESMD_ADAPTER_SHELL: FilingChannelAdapter = {
  kind: "esmd",
  mode: "electronic",
  channels: ["esmd"],
  availability: () => ({
    bound: false,
    reason: "Electronic esMD submission is not configured. Use guided manual submission.",
  }),
  guide: (ctx) => buildGuidedChecklist(ctx),
};
