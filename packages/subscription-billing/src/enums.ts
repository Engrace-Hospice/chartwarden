// @chartwarden/subscription-billing — §3.3 enum value tuples (M35-T01).
//
// These `as const` tuples are the RUNTIME source of truth for M35's enumerations: the T02 Drizzle
// `pgEnum(...)` definitions (in `packages/db/src/schema/subscription-billing/enums.ts`) seed from these
// exact arrays, and the §2 domain kernels iterate/validate against them. The TYPE mirrors live in the
// leaf `@chartwarden/types` (edge-free for cross-module consumers); each tuple is `satisfies`-pinned to its
// leaf union here so drift between the two definition sites is a compile error, not a silent lie
// (the M30 "wire enum as Type.String()" precedent).

import type { DunningStage, SubscriptionStatus } from "@chartwarden/types";

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "at_risk",
  "suspended",
  "canceled",
  "paused",
] as const satisfies readonly SubscriptionStatus[];

export const DUNNING_STAGES = [
  "none",
  "day_1",
  "day_7",
  "day_14",
  "day_21",
  "day_28_suspend",
  "day_60_cancel",
  "resolved",
] as const satisfies readonly DunningStage[];
