// @wardenx/messaging — resolution & fan-out engine (M36-T04, spec §2.1).
//
// The pure, DB-agnostic core dispatch path: recipient resolution (dynamic at emit time),
// per-recipient channel selection (routing map / quiet hours / vacation), the fan-out planner
// that turns an alert into `notification_delivery` rows, and the outcome roll-up. The DB-backed
// AlertEmitter/MessagingProvider seams (M36-T06) and BullMQ dispatchers (M36-T08) compose these
// over Drizzle + the source-of-truth seams; nothing here touches a DB, a clock, or a vendor.

export {
  FLOOR_CHANNEL,
  severityAtLeast,
  preferredOutOfBandChannels,
  isVacationActive,
  localWallClock,
  isWithinQuietHours,
  suppressedByQuietHours,
  type RoutingMap,
  type QuietHoursRange,
  type QuietHoursConfig,
  type RecipientPreferences,
} from "./preferences";

export {
  createRecipientResolverRegistry,
  resolveRecipients,
  UnknownRecipientResolverError,
  type ResolverArgs,
  type RecipientResolverFn,
  type RecipientSourcePorts,
} from "./recipients";

export {
  planFanOut,
  planFanOutDetailed,
  type AlertContext,
  type PlannedDelivery,
  type FanOutInput,
  type FanOutPolicy,
  type FanOutResult,
  type PolicyTrailEntry,
} from "./fan-out";

export {
  DESIGNATED_EVENT_TYPES,
  PLATFORM_CHANNEL_FLOOR,
  SNOOZABLE_EVENT_TYPES,
  isSnoozableEvent,
  decideChannels,
  designatedClassOf,
  type ChannelDecision,
  type PolicyAckClass,
  type PolicyInput,
  type PolicyReason,
  type ShiftState,
} from "./notification-policy";

export {
  computeOutcome,
  rollUpAlertOutcome,
  isTerminalDeliveryStatus,
  type DeliverySettlement,
  type DeliveryRollupRow,
} from "./outcome";
