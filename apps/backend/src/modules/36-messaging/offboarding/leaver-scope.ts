// M36 WP 5.9 (ADR-0084) - run a statement under the DEPARTED user's id. delivery_endpoint and the owner-strict personal tables (scheduled sends,
// reminders, snoozes, drafts) are isolated by app.user_id, so the sweep must act as their owner; the organisation is bound too, and the audit
// row written by the service names the real actor (the officer).
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { Tx } from "../session-devices/session-device-types";
import type { StepContext } from "./offboarding-types";

export const asLeaver = <T>(
  db: DbClient,
  ctx: Pick<StepContext, "organizationId" | "leaverUserId">,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> =>
  withOrgContext(db, { organizationId: ctx.organizationId, userId: ctx.leaverUserId }, fn);
