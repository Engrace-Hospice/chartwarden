// apps/backend/src/modules/31-portal/provisioning/preferences.ts — GAP-092. The portal notification preferences:
// one `portal_notification_preference` row per (account, channel), a channel with no row reading as its default.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";

const PREF = schema.portalNotificationPreferences;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The channels a caregiver can toggle (CHECK-constrained in migration 0422). */
export const PORTAL_NOTIFICATION_CHANNELS = ["email", "sms", "push"] as const;
export type PortalNotificationChannel = (typeof PORTAL_NOTIFICATION_CHANNELS)[number];

/** A channel nobody has toggled: email on (the invitation's own channel), the rest off until opted into. */
export const DEFAULT_CHANNEL_ENABLED: Readonly<Record<PortalNotificationChannel, boolean>> = {
  email: true,
  sms: false,
  push: false,
};

export interface PreferencesView {
  readonly channels: ReadonlyArray<{
    readonly id?: string;
    readonly channel: string;
    readonly enabled: boolean;
  }>;
  readonly quietHours?: { readonly startHour: number; readonly endHour: number };
}

export interface PreferenceUpdate {
  readonly enabled: boolean;
  readonly quietHoursStartHour?: number;
  readonly quietHoursEndHour?: number;
}

const isChannel = (value: string): value is PortalNotificationChannel =>
  (PORTAL_NOTIFICATION_CHANNELS as readonly string[]).includes(value);

/** Pure: the GET projection from the account's stored rows. */
export function toPreferencesView(rows: ReadonlyArray<typeof PREF.$inferSelect>): PreferencesView {
  const byChannel = new Map(rows.map((r) => [r.channel, r]));
  const channels = PORTAL_NOTIFICATION_CHANNELS.map((channel) => {
    const row = byChannel.get(channel);
    return row
      ? { id: row.id, channel, enabled: row.enabled }
      : { channel, enabled: DEFAULT_CHANNEL_ENABLED[channel] };
  });
  const withQuiet = rows.find(
    (r) => r.quietHoursStartHour !== null && r.quietHoursEndHour !== null,
  );
  return withQuiet
    ? {
        channels,
        quietHours: {
          startHour: withQuiet.quietHoursStartHour as number,
          endHour: withQuiet.quietHoursEndHour as number,
        },
      }
    : { channels };
}

export interface PortalPreferences {
  list(organizationId: string, portalAccountId: string): Promise<PreferencesView>;
  /** `idOrChannel` is a preference row id or a bare channel name (a channel with no row has no id yet). */
  update(input: {
    readonly organizationId: string;
    readonly actingUserId: string;
    readonly portalAccountId: string;
    readonly idOrChannel: string;
    readonly update: PreferenceUpdate;
  }): Promise<PreferencesView>;
}

export function createPortalPreferences(db: DbClient): PortalPreferences {
  const scope = (organizationId: string, userId = "") => ({ organizationId, userId });
  const rowsOf = (tx: Tx, portalAccountId: string) =>
    tx.select().from(PREF).where(eq(PREF.portalAccountId, portalAccountId));

  return {
    async list(organizationId, portalAccountId) {
      return withOrgContext(db, scope(organizationId), async (tx) =>
        toPreferencesView(await rowsOf(tx as Tx, portalAccountId)),
      );
    },

    async update({ organizationId, actingUserId, portalAccountId, idOrChannel, update }) {
      const hasStart = update.quietHoursStartHour !== undefined;
      const hasEnd = update.quietHoursEndHour !== undefined;
      if (hasStart !== hasEnd) {
        throw new ChartWardenError(
          "VALIDATION_FAILED",
          "quiet hours need both a start and an end hour",
          422,
        );
      }
      return withOrgContext(db, scope(organizationId, actingUserId), async (scoped) => {
        const tx = scoped as Tx;
        let channel: PortalNotificationChannel;
        if (isChannel(idOrChannel)) {
          channel = idOrChannel;
        } else {
          const [row] = await tx
            .select()
            .from(PREF)
            .where(and(eq(PREF.id, idOrChannel), eq(PREF.portalAccountId, portalAccountId)))
            .limit(1);
          if (!row || !isChannel(row.channel)) throw new NotFoundError("notification preference");
          channel = row.channel;
        }
        const quiet = hasStart
          ? {
              quietHoursStartHour: update.quietHoursStartHour as number,
              quietHoursEndHour: update.quietHoursEndHour as number,
            }
          : {};
        const now = new Date();
        const [existing] = await tx
          .select()
          .from(PREF)
          .where(and(eq(PREF.portalAccountId, portalAccountId), eq(PREF.channel, channel)))
          .limit(1);
        if (existing) {
          await tx
            .update(PREF)
            .set({
              enabled: update.enabled,
              ...quiet,
              version: existing.version + 1,
              updatedAt: now,
            })
            .where(eq(PREF.id, existing.id));
        } else {
          await tx.insert(PREF).values({
            organizationId,
            portalAccountId,
            channel,
            enabled: update.enabled,
            ...quiet,
          });
        }
        return toPreferencesView(await rowsOf(tx, portalAccountId));
      });
    },
  };
}
