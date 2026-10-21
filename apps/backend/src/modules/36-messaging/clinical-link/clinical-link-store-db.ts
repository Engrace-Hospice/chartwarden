// apps/backend/src/modules/36-messaging/clinical-link/clinical-link-store-db.ts - WP 3.2: the `clinical_link` rows.
//
// Writes run INSIDE the message write transaction (the caller passes its `tx`), so a link row and its message commit or
// roll back together. The table has no UPDATE grant: edits reconcile by deleting the dropped links and inserting the new
// ones. Every statement names the organization, on top of RLS.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { ClinicalLinkKind } from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";
import type { ValidatedClinicalLink } from "./clinical-link-service";

const CL = schema.clinicalLinks;
const MSG = schema.messages;

/** Make a message's links exactly `links`: delete the dropped ones, insert the new ones (idempotent on replay). */
export async function reconcileClinicalLinksInTx(
  tx: Tx,
  args: {
    orgId: string;
    messageId: string;
    authorUserId: string;
    links: readonly ValidatedClinicalLink[];
  },
): Promise<void> {
  const { orgId, messageId, authorUserId, links } = args;
  const existing = (await tx
    .select({ id: CL.id, kind: CL.linkKind, sourceId: CL.sourceId })
    .from(CL)
    .where(and(eq(CL.organizationId, orgId), eq(CL.messageId, messageId)))) as Array<{
    id: string;
    kind: string;
    sourceId: string;
  }>;
  const wanted = new Set(links.map((l) => `${l.kind}:${l.sourceId}`));
  const have = new Set(existing.map((l) => `${l.kind}:${l.sourceId}`));
  const dropped = existing.filter((l) => !wanted.has(`${l.kind}:${l.sourceId}`)).map((l) => l.id);
  if (dropped.length > 0) {
    await tx.delete(CL).where(and(eq(CL.organizationId, orgId), inArray(CL.id, dropped)));
  }
  const added = links.filter((l) => !have.has(`${l.kind}:${l.sourceId}`));
  if (added.length > 0) {
    await tx
      .insert(CL)
      .values(
        added.map((l) => ({
          organizationId: orgId,
          messageId,
          linkKind: l.kind,
          sourceId: l.sourceId,
          patientId: l.patientId,
          createdBy: authorUserId,
        })),
      )
      .onConflictDoNothing();
  }
}

/** What a message read carries per link: ids and kind only. The status/label come from `resolve`, per viewer. */
export interface ClinicalLinkView {
  readonly link_id: string;
  readonly kind: ClinicalLinkKind;
  readonly entity_id: string;
}

export async function loadClinicalLinkViews(
  tx: Tx,
  orgId: string,
  messageIds: readonly string[],
): Promise<Map<string, ClinicalLinkView[]>> {
  const out = new Map<string, ClinicalLinkView[]>();
  if (messageIds.length === 0) return out;
  const rows = (await tx
    .select({ id: CL.id, messageId: CL.messageId, kind: CL.linkKind, sourceId: CL.sourceId })
    .from(CL)
    .where(and(eq(CL.organizationId, orgId), inArray(CL.messageId, [...messageIds])))
    .orderBy(CL.createdAt, CL.id)) as Array<{
    id: string;
    messageId: string;
    kind: string;
    sourceId: string;
  }>;
  for (const r of rows) {
    const list = out.get(r.messageId) ?? [];
    list.push({ link_id: r.id, kind: r.kind as ClinicalLinkKind, entity_id: r.sourceId });
    out.set(r.messageId, list);
  }
  return out;
}

export interface StoredClinicalLink {
  readonly linkId: string;
  readonly kind: ClinicalLinkKind;
  readonly sourceId: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly messageDeleted: boolean;
}

/** The read the resolve route needs. */
export interface ClinicalLinkStore {
  findLink(
    organizationId: string,
    viewerUserId: string,
    linkId: string,
  ): Promise<StoredClinicalLink | null>;
}

export function createDbClinicalLinkStore(db: DbClient): ClinicalLinkStore {
  return {
    findLink: (organizationId, viewerUserId, linkId) =>
      withOrgContext(db, { organizationId, userId: viewerUserId }, async (tx) => {
        const [row] = await tx
          .select({
            linkId: CL.id,
            kind: CL.linkKind,
            sourceId: CL.sourceId,
            messageId: CL.messageId,
            channelId: MSG.channelId,
            status: MSG.status,
          })
          .from(CL)
          .innerJoin(MSG, and(eq(MSG.organizationId, CL.organizationId), eq(MSG.id, CL.messageId)))
          .where(and(eq(CL.organizationId, organizationId), eq(CL.id, linkId)))
          .limit(1);
        if (!row) return null;
        return {
          linkId: row.linkId,
          kind: row.kind as ClinicalLinkKind,
          sourceId: row.sourceId,
          messageId: row.messageId,
          channelId: row.channelId,
          messageDeleted: row.status === "deleted",
        };
      }),
  };
}
