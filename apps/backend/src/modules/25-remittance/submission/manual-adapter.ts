// M25 milestone 6a - the guided manual adapter: always bound, never transmits. It supplies the checklist; the proof is
// whatever the user enters from the channel.
import { SUBMISSION_CHANNELS, buildGuidedChecklist } from "../domain";
import type { FilingChannelAdapter } from "./channel-adapter";

export const MANUAL_ADAPTER: FilingChannelAdapter = {
  kind: "manual",
  mode: "guided_manual",
  channels: SUBMISSION_CHANNELS,
  availability: () => ({ bound: true, reason: "Manual / guided submission is always available." }),
  guide: (ctx) => buildGuidedChecklist(ctx),
};
