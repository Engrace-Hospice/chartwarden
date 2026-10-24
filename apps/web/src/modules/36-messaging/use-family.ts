// M36 WP 6.7 (ADR-0099, PROPOSED) - reads and writes against /api/v1/messaging/family for the staff Family lane. Same structural view of the shared client as
// use-partners (same auth, CSRF and idempotency middleware), typed against the DTOs in @chartwarden/types. The invitation token and the code come back ONCE
// from create and are held only in the screen's state; they are never logged, stored or put in a URL. Message text, ids and secrets are never logged.
import {
  type CreateFamilyInvitationRequest,
  type CreatedFamilyInvitationDto,
  FAMILY_SETTINGS_MISSING_CODE,
  type FamilyContactSummaryDto,
  type FamilyEligibleCaregiverDto,
  type FamilySettingsDto,
  type FamilyStaffMessageDto,
  type FamilyStaffThreadDto,
} from "@chartwarden/types";
import type { ApiClient } from "@chartwarden/ui";
import { useCallback, useMemo } from "react";
import { type ExportResult, classify } from "./use-export";
import { useOptionalApiClient } from "./use-handoffs-enabled";
import { type Fetcher, type LoadView, type Reply, errorCode, useRead } from "./use-retention";

export type { LoadView } from "./use-retention";

const BASE = "/api/v1/messaging/family";

interface Init {
  readonly params?: { readonly path: Readonly<Record<string, string>> };
  readonly body?: unknown;
}
interface LooseClient {
  GET: (path: string, init?: Init) => Promise<Reply<unknown>>;
  POST: (path: string, init?: Init) => Promise<Reply<unknown>>;
  PUT: (path: string, init?: Init) => Promise<Reply<unknown>>;
  DELETE: (path: string, init?: Init) => Promise<Reply<unknown>>;
}
const loose = (client: ApiClient): LooseClient => client as unknown as LooseClient;
const typed = <T>(reply: Reply<unknown>): Reply<T> => reply as Reply<T>;
const byContact = (contactId: string): Init => ({ params: { path: { contactId } } });

/** A 409 carries the backend's own plain sentence (for example the second-person unblock rule); nothing else from a body is ever shown. */
const messageOf = (error: unknown): string | undefined => {
  const inner = (error as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof inner === "string" && inner.length > 0 && inner.length <= 300 ? inner : undefined;
};

export type FamilyResult<T> =
  | Exclude<ExportResult<T>, { readonly kind: "conflict" }>
  | {
      readonly kind: "conflict";
      readonly code: string | undefined;
      readonly message: string | undefined;
      /** The creating screen's cue: set the 24-hour number first. */
      readonly settingsMissing: boolean;
    };

function classifyFamily<T>(reply: Reply<unknown>): FamilyResult<T> {
  const result = classify(typed<T>(reply));
  if (result.kind !== "conflict") return result;
  return {
    kind: "conflict",
    code: result.code,
    message: messageOf(reply.error),
    settingsMissing:
      result.code === FAMILY_SETTINGS_MISSING_CODE ||
      errorCode(reply.error) === FAMILY_SETTINGS_MISSING_CODE,
  };
}

interface ContactList {
  contacts?: FamilyContactSummaryDto[];
}

export function useFamilyContacts(): {
  view: LoadView<readonly FamilyContactSummaryDto[]>;
  reload: () => void;
  refreshFailed: boolean;
} {
  const fetcher = useCallback<Fetcher<ContactList>>(
    async (c) => typed<ContactList>(await loose(c).GET(`${BASE}/contacts`)),
    [],
  );
  const { view, reload, refreshFailed } = useRead(fetcher);
  const mapped = useMemo<LoadView<readonly FamilyContactSummaryDto[]>>(
    () => (view.status === "ready" ? { status: "ready", data: view.data.contacts ?? [] } : view),
    [view],
  );
  return { view: mapped, reload, refreshFailed };
}

export function useFamilyThread(contactId: string): {
  view: LoadView<FamilyStaffThreadDto>;
  reload: () => void;
} {
  const fetcher = useCallback<Fetcher<FamilyStaffThreadDto>>(
    async (c) =>
      typed<FamilyStaffThreadDto>(
        await loose(c).GET(`${BASE}/contacts/{contactId}/thread`, byContact(contactId)),
      ),
    [contactId],
  );
  const { view, reload } = useRead(fetcher);
  return { view, reload };
}

export function useFamilySettings(): { view: LoadView<FamilySettingsDto>; reload: () => void } {
  const fetcher = useCallback<Fetcher<FamilySettingsDto>>(
    async (c) => typed<FamilySettingsDto>(await loose(c).GET(`${BASE}/settings`)),
    [],
  );
  const { view, reload } = useRead(fetcher);
  return { view, reload };
}

export interface FamilyActions {
  readonly reply: (contactId: string, body: string) => Promise<FamilyResult<FamilyStaffMessageDto>>;
  readonly caregivers: (
    patientId: string,
  ) => Promise<FamilyResult<{ caregivers: FamilyEligibleCaregiverDto[] }>>;
  readonly invite: (
    body: CreateFamilyInvitationRequest,
  ) => Promise<FamilyResult<CreatedFamilyInvitationDto>>;
  readonly revoke: (contactId: string) => Promise<FamilyResult<FamilyContactSummaryDto>>;
  readonly setClosed: (
    contactId: string,
    closed: boolean,
  ) => Promise<FamilyResult<FamilyContactSummaryDto>>;
  readonly setBlocked: (
    contactId: string,
    blocked: boolean,
  ) => Promise<FamilyResult<FamilyContactSummaryDto>>;
  readonly saveSettings: (body: FamilySettingsDto) => Promise<FamilyResult<FamilySettingsDto>>;
}

export function useFamilyActions(): FamilyActions {
  const client = useOptionalApiClient();
  return useMemo<FamilyActions>(() => {
    const run = async <T>(
      call: (c: LooseClient) => Promise<Reply<unknown>>,
    ): Promise<FamilyResult<T>> => {
      if (!client) return { kind: "failed" };
      try {
        return classifyFamily<T>(await call(loose(client)));
      } catch {
        return { kind: "failed" };
      }
    };
    return {
      reply: (contactId, body) =>
        run((c) =>
          c.POST(`${BASE}/contacts/{contactId}/reply`, { ...byContact(contactId), body: { body } }),
        ),
      caregivers: (patientId) =>
        run((c) =>
          c.GET(`${BASE}/patients/{patientId}/caregivers`, { params: { path: { patientId } } }),
        ),
      invite: (body) => run((c) => c.POST(`${BASE}/invitations`, { body })),
      revoke: (contactId) =>
        run((c) => c.DELETE(`${BASE}/contacts/{contactId}/invitation`, byContact(contactId))),
      setClosed: (contactId, closed) =>
        run((c) =>
          c.POST(
            `${BASE}/contacts/{contactId}/${closed ? "close" : "reopen"}`,
            byContact(contactId),
          ),
        ),
      setBlocked: (contactId, blocked) =>
        run((c) =>
          c.POST(
            `${BASE}/contacts/{contactId}/${blocked ? "block" : "unblock"}`,
            byContact(contactId),
          ),
        ),
      saveSettings: (body) => run((c) => c.PUT(`${BASE}/settings`, { body })),
    };
  }, [client]);
}
