// apps/backend/src/modules/36-messaging/sbar/sbar-write-check.ts - WP 3.3: the authoritative write-time SBAR checks,
// run INSIDE the send/edit transaction after the channel is loaded, so a refusal rolls the whole write back.
// A body without an sbar block is untouched (no policy read). The rules themselves are the pure `assertSbarWrite`
// (@wardenx/messaging), shared with the in-memory twin; the flag check is the route's (it needs no database).
import { assertSbarWrite, effectiveSbarPolicy, isSbarBody } from "@wardenx/messaging";
import { type RichBody, ChartWardenError } from "@wardenx/types";
import type { Tx } from "../messaging-write-core";
import { readSbarPolicyInTx } from "./sbar-policy-store-db";

export const sbarNotAvailable = (): ChartWardenError =>
  new ChartWardenError("SBAR_NOT_AVAILABLE", "SBAR messages are not available.", 422);

export async function assertSbarWritable(
  tx: Tx,
  orgId: string,
  richBody: RichBody | undefined,
  channelKind: string,
): Promise<void> {
  if (!isSbarBody(richBody)) return;
  assertSbarWrite(richBody, channelKind, effectiveSbarPolicy(await readSbarPolicyInTx(tx, orgId)));
}
