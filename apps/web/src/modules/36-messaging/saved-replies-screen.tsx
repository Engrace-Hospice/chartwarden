// M36 WP 2.8 - "Saved replies": every sender manages their own personal replies; a template manager
// (messaging.template.manage) also authors the organization's shared templates and customizes the platform ones.
// The management section appears when the administration read succeeds; a 403 simply leaves it out. The server decides
// everything - this screen never infers a permission.
import { ErrorState, InlineAlert, LoadingSpinner, PageHeader, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { PlatformReplyPanel } from "./platform-reply-panel";
import {
  type PlatformReplyAdmin,
  type ReplyDraft,
  type SavedReply,
  savedReplyErrorText,
} from "./saved-replies-types";
import { SavedReplySection } from "./saved-reply-section";
import type { ReplyWrites } from "./saved-reply-section";
import { useSavedReplies } from "./use-saved-replies";
import "./saved-replies.css";

interface AdminView {
  readonly platform: readonly PlatformReplyAdmin[];
  readonly shared: readonly SavedReply[];
}

type Failure = { error?: unknown } | undefined;
const outcome = (result: Failure, fallback: string): string | null =>
  result?.error ? savedReplyErrorText(result.error, fallback) : null;

/**
 * One write's answer as text-or-null. A request that gets no answer at all rejects: the CALLERS (the form, the delete
 * dialog, the platform panel) catch that, because only they know whether a retry may reuse the Idempotency-Key.
 */
async function attempt(work: () => Promise<Failure>, fallback: string): Promise<string | null> {
  return outcome(await work(), fallback);
}

export function SavedReplies(): JSX.Element {
  const client = useApiClient();
  const mine = useSavedReplies(true);
  const [admin, setAdmin] = useState<AdminView | null>(null);
  const [adminTick, setAdminTick] = useState(0);
  const [adminError, setAdminError] = useState<string | null>(null);

  useEffect(() => {
    void adminTick;
    let current = true;
    void client.GET("/api/v1/messaging/template-admin").then(({ data, error, response }) => {
      if (!current) return;
      if (data) {
        setAdmin(data as unknown as AdminView);
        setAdminError(null);
      } else if (response?.status === 403) {
        setAdmin(null); // not a template manager: the management sections are simply absent
      } else if (error) {
        setAdminError(savedReplyErrorText(error, "Template administration could not be loaded."));
      }
    });
    return () => {
      current = false;
    };
  }, [client, adminTick]);

  const refresh = useCallback(() => {
    mine.reload();
    setAdminTick((value) => value + 1);
  }, [mine.reload]);

  const personalWrites = useMemo<ReplyWrites>(
    () => ({
      create: async (draft: ReplyDraft, idempotencyKey: string) => {
        const failure = await attempt(
          () =>
            client.POST("/api/v1/messaging/templates/personal", {
              params: { header: { "Idempotency-Key": idempotencyKey } },
              body: draft,
            }),
          "Could not save this reply.",
        );
        if (!failure) refresh();
        return failure;
      },
      update: async (id, draft) => {
        const failure = await attempt(
          () =>
            client.PATCH("/api/v1/messaging/templates/personal/{id}", {
              params: { path: { id } },
              body: draft,
            }),
          "Could not save this reply.",
        );
        if (!failure) refresh();
        return failure;
      },
      remove: async (id) => {
        const failure = await attempt(
          () =>
            client.DELETE("/api/v1/messaging/templates/personal/{id}", {
              params: { path: { id } },
            }),
          "Could not delete this reply.",
        );
        if (!failure) refresh();
        return failure;
      },
    }),
    [client, refresh],
  );

  const sharedWrites = useMemo<ReplyWrites>(
    () => ({
      create: async (draft: ReplyDraft, idempotencyKey: string) => {
        const failure = await attempt(
          () =>
            client.POST("/api/v1/messaging/template-admin/shared", {
              params: { header: { "Idempotency-Key": idempotencyKey } },
              body: draft,
            }),
          "Could not save this template.",
        );
        if (!failure) refresh();
        return failure;
      },
      update: async (id, draft) => {
        const failure = await attempt(
          () =>
            client.PATCH("/api/v1/messaging/template-admin/shared/{id}", {
              params: { path: { id } },
              body: draft,
            }),
          "Could not save this template.",
        );
        if (!failure) refresh();
        return failure;
      },
      remove: async (id) => {
        const failure = await attempt(
          () =>
            client.DELETE("/api/v1/messaging/template-admin/shared/{id}", {
              params: { path: { id } },
            }),
          "Could not delete this template.",
        );
        if (!failure) refresh();
        return failure;
      },
    }),
    [client, refresh],
  );

  const overlayWrites = useMemo(
    () => ({
      save: async (
        id: string,
        overlay: { title: string | null; body: string | null; isEnabled: boolean },
      ) => {
        const failure = await attempt(
          () =>
            client.PUT("/api/v1/messaging/template-admin/platform/{id}/overlay", {
              params: { path: { id } },
              body: overlay,
            }),
          "Could not save this customization.",
        );
        if (!failure) refresh();
        return failure;
      },
      reset: async (id: string) => {
        const failure = await attempt(
          () =>
            client.DELETE("/api/v1/messaging/template-admin/platform/{id}/overlay", {
              params: { path: { id } },
            }),
          "Could not remove this customization.",
        );
        if (!failure) refresh();
        return failure;
      },
    }),
    [client, refresh],
  );

  const personal = mine.items.filter((item) => item.scope === "personal");

  return (
    <div className="wx-saved-replies">
      <PageHeader title="Saved replies" breadcrumb="General / Messaging" />
      <InlineAlert tone="info">
        A saved reply is text you can drop into a message from the composer. You can edit it before
        sending, and what you send is an ordinary message. Saved replies must not contain patient
        identifiers.
      </InlineAlert>
      {mine.status === "error" && mine.items.length === 0 ? (
        <ErrorState title="Saved replies could not be loaded" onRetry={mine.reload} />
      ) : mine.status !== "ready" && mine.items.length === 0 ? (
        <LoadingSpinner label="Loading saved replies" />
      ) : (
        <SavedReplySection
          title="My saved replies"
          description="Only you can see and use these."
          emptyText="Add a reply you send often."
          items={personal}
          writes={personalWrites}
        />
      )}
      {adminError ? <InlineAlert tone="error">{adminError}</InlineAlert> : null}
      {admin ? (
        <>
          <SavedReplySection
            title="Organization templates"
            description="Shared with everyone who can send messages in this organization."
            emptyText="Add a reply the whole team should have."
            items={admin.shared}
            writes={sharedWrites}
          />
          <PlatformReplyPanel items={admin.platform} writes={overlayWrites} />
        </>
      ) : null}
    </div>
  );
}
