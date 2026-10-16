// M25 milestone 6a - the fax adapter SHELL. UNBOUND. M25 cannot import M22's outbound-fax port (manifest dependsOn is
// [1, 23, 36]); 6b injects an OutboundFaxTransport-shaped dependency here from the composition root, only after a fax
// vendor BAA is executed and a per-tenant destination exists. Until then it reports `bound: false` and has no
// `transmit`, so nothing is faxed.
import { buildGuidedChecklist } from "../domain";
import type { FilingChannelAdapter } from "./channel-adapter";

export const FAX_ADAPTER_SHELL: FilingChannelAdapter = {
  kind: "fax",
  mode: "electronic",
  channels: ["fax"],
  availability: () => ({
    bound: false,
    reason: "Electronic fax submission is not configured. Use guided manual submission.",
  }),
  guide: (ctx) => buildGuidedChecklist(ctx),
};
