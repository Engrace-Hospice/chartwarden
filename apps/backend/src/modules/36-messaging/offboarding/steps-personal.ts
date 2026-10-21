// M36 WP 5.9 (ADR-0084) - the PERSONAL leftovers of an offboarding. A departed person's scheduled sends are cancelled (nothing is ever sent as
// them), their reminders and snoozes are removed, their drafts are KEPT (never sent, never shown to anyone; retention is an open human decision),
// and the on-call roster is M19's: M36 cannot read it, so it is surfaced as advisory.
import { type DbClient, schema } from "@chartwarden/db";
import { and, count, eq } from "drizzle-orm";
import { asLeaver } from "./leaver-scope";
import type { OffboardingStep } from "./offboarding-types";

const SM = schema.scheduledMessages;
const REM = schema.messageReminders;
const SNZ = schema.messageSnoozes;
const DRAFT = schema.messageDrafts;

export function scheduledSendsStep(input: { readonly db: DbClient }): OffboardingStep {
  return {
    key: "scheduled_sends",
    kind: "sweep",
    inspect: async (ctx) => ({
      auto: await asLeaver(input.db, ctx, async (tx) => {
        const [row] = await tx
          .select({ n: count() })
          .from(SM)
          .where(and(eq(SM.organizationId, ctx.organizationId), eq(SM.userId, ctx.leaverUserId)));
        return row?.n ?? 0;
      }),
      human: 0,
    }),
    // The same operation as the owner's own cancel (a delete); the sealed body goes with the row.
    run: (ctx) =>
      asLeaver(
        input.db,
        ctx,
        async (tx) =>
          (
            await tx
              .delete(SM)
              .where(
                and(eq(SM.organizationId, ctx.organizationId), eq(SM.userId, ctx.leaverUserId)),
              )
              .returning({ id: SM.id })
          ).length,
      ),
  };
}

export function remindersSnoozesStep(input: { readonly db: DbClient }): OffboardingStep {
  return {
    key: "reminders_snoozes",
    kind: "sweep",
    inspect: async (ctx) => ({
      auto: await asLeaver(input.db, ctx, async (tx) => {
        const [reminders] = await tx
          .select({ n: count() })
          .from(REM)
          .where(and(eq(REM.organizationId, ctx.organizationId), eq(REM.userId, ctx.leaverUserId)));
        const [snoozes] = await tx
          .select({ n: count() })
          .from(SNZ)
          .where(and(eq(SNZ.organizationId, ctx.organizationId), eq(SNZ.userId, ctx.leaverUserId)));
        return (reminders?.n ?? 0) + (snoozes?.n ?? 0);
      }),
      human: 0,
    }),
    run: (ctx) =>
      asLeaver(input.db, ctx, async (tx) => {
        const reminders = await tx
          .delete(REM)
          .where(and(eq(REM.organizationId, ctx.organizationId), eq(REM.userId, ctx.leaverUserId)))
          .returning({ id: REM.id });
        const snoozes = await tx
          .delete(SNZ)
          .where(and(eq(SNZ.organizationId, ctx.organizationId), eq(SNZ.userId, ctx.leaverUserId)))
          .returning({ id: SNZ.id });
        return reminders.length + snoozes.length;
      }),
  };
}

export function draftsStep(input: { readonly db: DbClient }): OffboardingStep {
  return {
    key: "drafts",
    kind: "kept",
    inspect: async (ctx) => ({
      auto: 0,
      human: await asLeaver(input.db, ctx, async (tx) => {
        const [row] = await tx
          .select({ n: count() })
          .from(DRAFT)
          .where(
            and(eq(DRAFT.organizationId, ctx.organizationId), eq(DRAFT.userId, ctx.leaverUserId)),
          );
        return row?.n ?? 0;
      }),
    }),
  };
}

/** M19 owns the roster and M36 has no reader for it (the escalation router seam is a deny-stub today): always surfaced, never claimed done. */
export function onCallSeatsStep(): OffboardingStep {
  return { key: "oncall_seats", kind: "advisory", inspect: async () => ({ auto: 0, human: 0 }) };
}
