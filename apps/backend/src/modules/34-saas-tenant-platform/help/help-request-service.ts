// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-service.ts — the help-request service (slice 7, piece 7B).
//
// Any ACTIVE member of the tenant's organization may ask ChartWarden for help; its org_admin or compliance officer may consent to it
// (approve creates a non-PHI `assist` consent grant through the injected `SupportGrantOperations`, in the SAME transaction as the
// status change); the member who asked, or an org_admin or compliance officer, may end it; an operator may resolve it with a
// tenant-visible note. A request is a SIGNAL: it authorizes nothing, and every rule below is judged here, not only in the routes
// (RLS cannot tell an operator from a member, and a custom tenant role carries no permission key the routes could check).
//
// The state machine (`tenant_help_request.status`, also a CHECK and a guard trigger in migration 1482):
//   open -> approved -> resolved      approve (consent), then End help / the operator's Resolve / the grant's expiry
//   open -> cancelled                 the member's End help, or the 14-day sweep
//   open -> resolved                  an operator answered it without needing consent
// One request per tenant account is live (open or approved) at a time: the partial unique index, answered 409 HELP_REQUEST_ALREADY_OPEN.
//
// Nothing here, nor any error, outbox payload or log line, carries the member's message or the operator's note: they are stored in
// their own columns, screened for patient identifiers (422 EVIDENCE_LOOKS_LIKE_PHI), and shown only to the two parties.
import type { DbClient } from "@chartwarden/db";
import { classifyDatabaseError, schema } from "@chartwarden/db";
import type { SupportGrantOperations } from "@chartwarden/saas-tenant-platform";
import type { WriteActor } from "@chartwarden/shared/route-kit";
import { ForbiddenError, NotFoundError, ValidationError } from "@chartwarden/types";
import { isPlatformStaffMember } from "../onboarding/wizard-core";
import {
  HELP_APPROVE_HOURS_DEFAULT,
  HELP_APPROVE_HOURS_MAX,
  HELP_APPROVE_HOURS_MIN,
  HELP_MESSAGE_MAX,
  HELP_MESSAGE_MIN,
  HELP_NOTE_MAX,
  HELP_NOTE_MIN,
} from "../routes/help-request-typebox";
import {
  type CursorPage,
  PLATFORM_CURSOR_SCOPE,
  decodeKeyset,
  encodeKeyset,
  pageSizeOf,
} from "../routes/keyset-page";
import type {
  ApproveHelpRequestInput,
  FileHelpRequestInput,
  HelpRequestService,
  HelpRequestView,
  PlatformHelpRequestFilter,
  PlatformHelpRequestView,
  ResolveHelpRequestInput,
  TenantHelpRequestListView,
} from "./help-request-contract";
import { HELP_REQUEST_ID_DETAIL_FIELD, HelpRequestError } from "./help-request-errors";
import type {
  HelpPageAfter,
  HelpRequestRow,
  HelpRequestRunner,
  HelpRequestStore,
} from "./help-request-store";
import { normalizeHelpText } from "./help-request-text";
import { toPlatformView, toTenantView } from "./help-request-view";

/** The outbox event a filed request emits; M36 routes it to the operators (`tenant.help_requested`). Ids and codes only. */
export const HELP_REQUEST_REQUESTED_EVENT = "m34.help_request.requested";
const HELP_REQUEST_AGGREGATE = "tenant_help_request";

/** The roles that may consent to help and end anyone's request: the organization's administrator and its compliance officer. */
const APPROVER_ROLE_KEYS: ReadonlySet<string> = new Set(["org_admin", "compliance_officer"]);

/** The in-transaction, catalog-validating outbox publish the composition root binds (`m34OutboxPublisher`). */
export interface HelpOutboxPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface HelpRequestServiceDeps {
  readonly runner: HelpRequestRunner;
  /** 7S's bundle: `issueAssistGrant`, `revokeGrantAndCloseSessions`, `sessionSummaryForGrant` (and the deps builder they take). */
  readonly grants: SupportGrantOperations;
  readonly outbox: HelpOutboxPort;
  readonly now: () => Date;
}

const memberContext = (actor: WriteActor) => ({
  organizationId: actor.organizationId,
  userId: actor.userId,
});

/** The session may use help at all: a human on a `staff` session (never an AI principal, an auditor or a family member). */
function assertMemberSession(actor: WriteActor): void {
  if (actor.actorKind.startsWith("ai_")) {
    throw new ForbiddenError("AI principals cannot use help requests");
  }
  if (actor.sessionClass !== "staff") {
    throw new ForbiddenError("help requests are for the organization's own staff");
  }
}

/** ChartWarden staff are active members of every tenant, so "is a member" cannot mean "belongs to the customer". */
async function assertNotPlatformStaff(store: HelpRequestStore, actor: WriteActor): Promise<void> {
  const staff = await isPlatformStaffMember(store, { userId: actor.userId, roleKeys: actor.roles });
  if (staff) {
    throw new ForbiddenError("ChartWarden staff answer help requests from the operators' console");
  }
}

const holdsApproverRole = (actor: WriteActor): boolean =>
  actor.roles.some((role) => APPROVER_ROLE_KEYS.has(role));

const alreadyOpen = (liveId: string | null): HelpRequestError =>
  new HelpRequestError(
    "HELP_REQUEST_ALREADY_OPEN",
    "this organization already has a help request that is open or approved",
    liveId === null
      ? undefined
      : [
          {
            field: HELP_REQUEST_ID_DETAIL_FIELD,
            code: "HELP_REQUEST_ALREADY_OPEN",
            message: liveId,
          },
        ],
  );

const afterOf = (key: { createdAt: string; id: string } | null): HelpPageAfter | null =>
  key ? { cursorTs: key.createdAt, id: key.id } : null;

const isLiveRequestRace = (error: unknown): boolean =>
  classifyDatabaseError(error)?.constraint === schema.TENANT_HELP_REQUEST_LIVE_IDX;

export function createHelpRequestService(deps: HelpRequestServiceDeps): HelpRequestService {
  const { runner, grants, outbox, now } = deps;

  /** The grants and the session summaries behind some rows, read once per request on the open transaction. */
  async function factsFor(store: HelpRequestStore, rows: readonly HelpRequestRow[]) {
    const grantIds = [
      ...new Set(rows.flatMap((r) => (r.supportConsentGrantId ? [r.supportConsentGrantId] : []))),
    ];
    const grantRows = await store.grantsById(grantIds);
    // ponytail: one summary read per grant (the contract's unit); a page is at most the page size and a tenant has one live request.
    const sessions = new Map<string, Awaited<ReturnType<typeof grants.sessionSummaryForGrant>>>();
    for (const id of grantIds) sessions.set(id, await grants.sessionSummaryForGrant(store.tx, id));
    const at = now();
    return (row: HelpRequestRow) => ({
      grant: row.supportConsentGrantId ? (grantRows.get(row.supportConsentGrantId) ?? null) : null,
      session: row.supportConsentGrantId ? (sessions.get(row.supportConsentGrantId) ?? null) : null,
      now: at,
    });
  }

  async function tenantViewOf(
    store: HelpRequestStore,
    row: HelpRequestRow,
    viewerUserId: string,
  ): Promise<HelpRequestView> {
    const facts = await factsFor(store, [row]);
    return toTenantView(row, facts(row), viewerUserId);
  }

  async function platformViewOf(
    store: HelpRequestStore,
    id: string,
  ): Promise<PlatformHelpRequestView> {
    const row = await store.findForPlatform(id);
    if (!row) throw new NotFoundError("help request", id);
    const facts = await factsFor(store, [row]);
    return toPlatformView(row, facts(row));
  }

  /** The tenant account's live request id (a fresh read, for the 409 that lost the unique-index race). */
  async function liveRequestId(actor: WriteActor): Promise<string | null> {
    return runner.asMember(memberContext(actor), async (store) => {
      const tenantAccountId = await store.tenantAccountIdOf(actor.organizationId);
      return tenantAccountId ? ((await store.findLive(tenantAccountId))?.id ?? null) : null;
    });
  }

  async function fileInTransaction(
    actor: WriteActor,
    message: string,
    stepKey: string | null,
  ): Promise<HelpRequestView> {
    return runner.asMember(memberContext(actor), async (store) => {
      await assertNotPlatformStaff(store, actor);
      if (stepKey !== null && !(await store.stepKeyExists(stepKey))) {
        throw new HelpRequestError(
          "HELP_REQUEST_STEP_UNKNOWN",
          "stepKey names no onboarding step",
          [
            {
              field: "stepKey",
              code: "HELP_REQUEST_STEP_UNKNOWN",
              message: "unknown onboarding step",
            },
          ],
        );
      }
      const tenantAccountId = await store.tenantAccountIdOf(actor.organizationId);
      if (!tenantAccountId) throw new NotFoundError("tenant account");
      const live = await store.findLive(tenantAccountId);
      if (live) throw alreadyOpen(live.id);
      const row = await store.insert({
        organizationId: actor.organizationId,
        tenantAccountId,
        stepKey,
        message,
        requestedByMembershipId: actor.membershipId,
        requestedByUserId: actor.userId,
      });
      await outbox.publish(store.tx, {
        eventName: HELP_REQUEST_REQUESTED_EVENT,
        // Ids and codes only: never the message.
        payload: {
          helpRequestId: row.id,
          tenantAccountId,
          orgId: actor.organizationId,
          stepKey,
          requestedAt: row.requestedAt.toISOString(),
        },
        organizationId: actor.organizationId,
        aggregateKind: HELP_REQUEST_AGGREGATE,
        aggregateId: row.id,
      });
      return tenantViewOf(store, row, actor.userId);
    });
  }

  async function approveInTransaction(
    actor: WriteActor,
    helpRequestId: string,
    hours: number,
  ): Promise<HelpRequestView> {
    return runner.asMember(memberContext(actor), async (store) => {
      await assertNotPlatformStaff(store, actor);
      const row = await store.findForUpdate(helpRequestId);
      if (!row) throw new NotFoundError("help request", helpRequestId);
      if (row.status !== "open") {
        throw new HelpRequestError(
          "HELP_REQUEST_NOT_OPEN",
          "only an open help request can be approved",
        );
      }
      // The consent: the grant is created (and its event and alert emitted) on THIS transaction, so a failure below undoes it.
      const grant = await grants.issueAssistGrant(grants.depsFor(store.tx), {
        organizationId: row.organizationId,
        tenantAccountId: row.tenantAccountId,
        grantorMembershipId: actor.membershipId,
        grantorRoles: actor.roles,
        hours,
        reason: `help request ${row.id}`,
      });
      if (grant.afterCommit) store.afterCommit(grant.afterCommit);
      const approvedAt = now();
      const approved = await store.markApproved(row.id, {
        grantId: grant.grantId,
        approvedByMembershipId: actor.membershipId,
        approvedAt,
      });
      if (!approved) {
        throw new HelpRequestError(
          "HELP_REQUEST_NOT_OPEN",
          "only an open help request can be approved",
        );
      }
      return toTenantView(
        approved,
        {
          grant: { id: grant.grantId, expiresAt: grant.expiresAt, revokedAt: null },
          session: null,
          now: approvedAt,
        },
        actor.userId,
      );
    });
  }

  /**
   * End an approved request: revoke its grant and close its sessions through 7S's cascade, which resolves the linked request through
   * the port bound to this transaction. If the cascade left the request approved (a grant that was already revoked, say), resolve it
   * here: the request must not outlive the consent it stood on.
   */
  async function endApprovedRequest(
    store: HelpRequestStore,
    row: HelpRequestRow,
    ending: {
      readonly revokedByMembershipId: string;
      readonly source: "tenant" | "platform_ops";
      readonly reason: string;
      readonly closing: Omit<Parameters<HelpRequestStore["markClosed"]>[1], "from" | "to">;
      readonly defaults: { readonly closedByUserId: string; readonly note: string | null };
    },
  ): Promise<void> {
    if (!row.supportConsentGrantId) {
      throw new HelpRequestError("HELP_REQUEST_NOT_OPEN", "an approved help request has no grant");
    }
    const revoked = await grants.revokeGrantAndCloseSessions(
      {
        ...grants.depsFor(store.tx),
        linkedHelpRequests: store.linkedRequests(ending.defaults),
      },
      {
        grantId: row.supportConsentGrantId,
        organizationId: row.organizationId,
        revokedByMembershipId: ending.revokedByMembershipId,
        reason: ending.reason,
        source: ending.source,
      },
    );
    if (revoked.afterCommit) store.afterCommit(revoked.afterCommit);
    const after = await store.findForUpdate(row.id);
    if (after?.status === "approved") {
      await store.markClosed(row.id, { ...ending.closing, from: "approved", to: "resolved" });
    }
  }

  return {
    async listForTenant(actor, cursor, limit) {
      assertMemberSession(actor);
      // judged before any transaction opens: a bad cursor reaches no database
      const after = afterOf(decodeKeyset(actor.organizationId, cursor));
      const size = pageSizeOf(limit);
      return runner.asMember(
        memberContext(actor),
        async (store): Promise<TenantHelpRequestListView> => {
          await assertNotPlatformStaff(store, actor);
          const tenantAccountId = await store.tenantAccountIdOf(actor.organizationId);
          if (!tenantAccountId) throw new NotFoundError("tenant account");
          const live = await store.findLive(tenantAccountId);
          // limit + 1 so `hasMore` is answered by the read itself
          const ended = await store.listEnded(tenantAccountId, after, size + 1);
          const hasMore = ended.length > size;
          const page = hasMore ? ended.slice(0, size) : ended;
          const facts = await factsFor(store, live ? [live, ...page] : page);
          const last = page[page.length - 1];
          return {
            current: live ? toTenantView(live, facts(live), actor.userId) : null,
            items: page.map((r) => toTenantView(r, facts(r), actor.userId)),
            nextCursor:
              hasMore && last
                ? encodeKeyset(actor.organizationId, { createdAt: last.cursorTs, id: last.id })
                : null,
            hasMore,
          };
        },
      );
    },

    async file(actor, input: FileHelpRequestInput) {
      assertMemberSession(actor);
      const message = normalizeHelpText(input.message, {
        field: "message",
        min: HELP_MESSAGE_MIN,
        max: HELP_MESSAGE_MAX,
      });
      const stepKey = input.stepKey === undefined ? null : input.stepKey.trim();
      if (stepKey === "") {
        throw new HelpRequestError(
          "HELP_REQUEST_STEP_UNKNOWN",
          "stepKey names no onboarding step",
          [
            {
              field: "stepKey",
              code: "HELP_REQUEST_STEP_UNKNOWN",
              message: "unknown onboarding step",
            },
          ],
        );
      }
      try {
        return await fileInTransaction(actor, message, stepKey);
      } catch (error) {
        // Two members filing at once: the unique index let one through. The loser is told which request is live.
        if (isLiveRequestRace(error)) throw alreadyOpen(await liveRequestId(actor));
        throw error;
      }
    },

    async approve(actor, helpRequestId, input: ApproveHelpRequestInput) {
      assertMemberSession(actor);
      if (!holdsApproverRole(actor)) {
        throw new ForbiddenError(
          "only an organization administrator or the compliance officer can consent to help",
        );
      }
      const hours = input.hours ?? HELP_APPROVE_HOURS_DEFAULT;
      if (
        !Number.isInteger(hours) ||
        hours < HELP_APPROVE_HOURS_MIN ||
        hours > HELP_APPROVE_HOURS_MAX
      ) {
        throw new ValidationError("hours is out of range", [
          {
            field: "hours",
            code: "HELP_APPROVE_HOURS_RANGE",
            message: `hours must be a whole number from ${HELP_APPROVE_HOURS_MIN} to ${HELP_APPROVE_HOURS_MAX}`,
          },
        ]);
      }
      return approveInTransaction(actor, helpRequestId, hours);
    },

    async close(actor, helpRequestId) {
      assertMemberSession(actor);
      return runner.asMember(memberContext(actor), async (store) => {
        await assertNotPlatformStaff(store, actor);
        const row = await store.findForUpdate(helpRequestId);
        if (!row) throw new NotFoundError("help request", helpRequestId);
        if (row.requestedByUserId !== actor.userId && !holdsApproverRole(actor)) {
          throw new ForbiddenError(
            "only the member who asked, an organization administrator or the compliance officer can end help",
          );
        }
        // Ending twice is the same wish twice (a double click): the ended request is the answer.
        if (row.status === "resolved" || row.status === "cancelled") {
          return tenantViewOf(store, row, actor.userId);
        }
        const closedAt = now();
        const ending = {
          closedByActorKind: "tenant",
          closedByUserId: actor.userId,
          closedAt,
          closeNote: null,
        } as const;
        if (row.status === "open") {
          const cancelled = await store.markClosed(row.id, {
            ...ending,
            from: "open",
            to: "cancelled",
          });
          return tenantViewOf(store, cancelled ?? row, actor.userId);
        }
        await endApprovedRequest(store, row, {
          revokedByMembershipId: actor.membershipId,
          source: "tenant",
          reason: `help request ${row.id} ended by the organization`,
          closing: ending,
          defaults: { closedByUserId: actor.userId, note: null },
        });
        const after = await store.findForUpdate(row.id);
        return tenantViewOf(store, after ?? row, actor.userId);
      });
    },

    async listForPlatform(actor, filter: PlatformHelpRequestFilter, cursor, limit) {
      // judged before the platform transaction (a cross-tenant bypass that writes an audit row) opens
      const after = afterOf(decodeKeyset(PLATFORM_CURSOR_SCOPE, cursor));
      const size = pageSizeOf(limit);
      return runner.asPlatform(
        { userId: actor.userId, reason: "m34 help request inbox" },
        async (store): Promise<CursorPage<PlatformHelpRequestView>> => {
          // limit + 1 so `hasMore` is answered by the read itself
          const rows = await store.listForPlatform(filter, after, size + 1);
          const hasMore = rows.length > size;
          const page = hasMore ? rows.slice(0, size) : rows;
          const facts = await factsFor(store, page);
          const last = page[page.length - 1];
          return {
            items: page.map((r) => toPlatformView(r, facts(r))),
            nextCursor:
              hasMore && last
                ? encodeKeyset(PLATFORM_CURSOR_SCOPE, { createdAt: last.cursorTs, id: last.id })
                : null,
            hasMore,
          };
        },
      );
    },

    async resolve(actor, helpRequestId, input: ResolveHelpRequestInput) {
      if (actor.actorKind.startsWith("ai_")) {
        throw new ForbiddenError("AI principals cannot resolve help requests");
      }
      const note = normalizeHelpText(input.note, {
        field: "note",
        min: HELP_NOTE_MIN,
        max: HELP_NOTE_MAX,
      });
      return runner.asPlatform(
        { userId: actor.userId, reason: "m34 help request resolve" },
        async (store) => {
          const row = await store.findForUpdate(helpRequestId);
          if (!row) throw new NotFoundError("help request", helpRequestId);
          if (row.status === "resolved" || row.status === "cancelled") {
            throw new HelpRequestError("HELP_REQUEST_ENDED", "this help request has already ended");
          }
          const ending = {
            closedByActorKind: "platform_ops",
            closedByUserId: actor.userId,
            closedAt: now(),
            closeNote: note,
          } as const;
          if (row.status === "open") {
            await store.markClosed(row.id, { ...ending, from: "open", to: "resolved" });
          } else {
            await endApprovedRequest(store, row, {
              revokedByMembershipId: actor.membershipId,
              source: "platform_ops",
              reason: `help request ${row.id} resolved by ChartWarden operations`,
              closing: ending,
              defaults: { closedByUserId: actor.userId, note },
            });
          }
          return platformViewOf(store, row.id);
        },
      );
    },
  };
}
