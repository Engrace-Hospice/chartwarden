// @chartwarden/messaging - the shape of one platform-default alert rule seed. Its own file so the seed data files
// (alert-rules.ts and the per-domain rule files it splices in) can all import it without an import cycle.
import type {
  AlertCategory,
  AlertRecipientResolver,
  AlertSeverity,
  NotificationChannel,
} from "../interfaces/kinds";
import type { ResolverArgs } from "../resolution";

/** One platform-default `alert_rule` (organization_id IS NULL). Typed against the §3.2 enum
 *  unions so `tsc` rejects an invalid category/severity/resolver/channel at authoring time. */
export interface PlatformAlertRuleSeed {
  readonly eventType: string;
  readonly category: AlertCategory;
  readonly severityFloor: AlertSeverity;
  readonly recipientResolver: AlertRecipientResolver;
  readonly resolverArgs: ResolverArgs;
  /** null ⇒ use recipient preferences (no channel override, §3.6). */
  readonly channelsOverride: readonly NotificationChannel[] | null;
  /** true ⇒ tenants cannot disable or loosen this rule (§7.4). */
  readonly systemLocked: boolean;
  readonly enabled: boolean;
}
