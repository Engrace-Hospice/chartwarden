// apps/web/src/modules/16-bereavement — the GRIEF LIBRARY (ADR-0109 D10, routes 77-81): what the bereaved family portal shows, curated by
// oversight. `bereavement.library.read` lists and previews; `bereavement.library.manage` uploads, edits and publishes / archives.
//
// A preview URL is a short-lived credential: it is minted on click, held only in this page's memory as an "Open preview" link (https only),
// and dropped when clicked or when it expires. A 403 renders nothing; any other failure is announced; a status change is confirmed in an
// alertdialog and carries `If-Match`. A video is published only with its transcript (the server refuses one without: 422).
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  linkLifetimeMs,
  safeMintedUrl,
  useApiClient,
  useAttemptKey,
} from "@chartwarden/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import { errorMessage, isStaleVersion, isStaleWrite } from "./bereavement-api";
import { dateTime, humanize, toneOf } from "./bereavement-status";
import {
  ErrorText,
  FilterRow,
  Modal,
  SelectField,
  columnStyle,
  dangerButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
  useActionStatus,
} from "./bereavement-ui";
import { LibraryEditModal } from "./library-edit-modal";
import { LibraryUploadModal } from "./library-upload-modal";
import { useLoaded } from "./mailing-load";
import {
  LIBRARY_MANAGE_PERMISSION,
  LIBRARY_STATUS_TONE,
  categoryLabel,
  holds,
  libraryNextStatuses,
} from "./program-status";
import {
  type LibraryItem,
  type LibraryPart,
  type LibraryStatus,
  libraryUrl,
  listLibrary,
  setLibraryStatus,
} from "./programs-api";

const LOAD_FAILED = "The grief library could not be loaded.";
const ALL = "";
const STATUS_ACTION: Record<LibraryStatus, string> = {
  draft: "Move to draft",
  published: "Publish",
  archived: "Archive",
};

const STATUS_CONFIRM: Record<LibraryStatus, string> = {
  draft: "The item goes back to draft and is no longer shown to families.",
  published: "Families see the item in the portal's grief library as soon as it is published.",
  archived: "Families no longer see the item. It stays here and can be republished.",
};
const TRANSCRIPT_NEEDED = "Add a transcript before publishing this video.";
/** A video is published only with its transcript (the server refuses one without). */
const needsTranscript = (item: LibraryItem, next: LibraryStatus): boolean =>
  next === "published" && item.kind === "video" && !item.transcriptDocumentId;

interface Preview {
  readonly itemId: string;
  readonly title: string;
  readonly part: LibraryPart;
  readonly url: string;
  readonly expiresAt: string;
}

export function GriefLibrary(): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const mayManage = holds(session?.permissions, LIBRARY_MANAGE_PERMISSION);
  const [status, setStatus] = useState<LibraryStatus | typeof ALL>(ALL);
  const fetchItems = useCallback(
    () => listLibrary(client, status === ALL ? {} : { status }),
    [client, status],
  );
  const { state, reload, patch } = useLoaded<LibraryItem[]>(fetchItems, LOAD_FAILED);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<LibraryItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirming, setConfirming] = useState<{ item: LibraryItem; next: LibraryStatus } | null>(
    null,
  );
  const confirmDescId = useId();
  const reasonIdBase = useId();
  const previewRef = useRef<HTMLAnchorElement>(null);
  const inFlight = useRef(false);
  const keys = useAttemptKey();
  const { announce, region } = useActionStatus();

  useEffect(() => {
    if (preview === null) return;
    previewRef.current?.focus();
    const timer = setTimeout(() => setPreview(null), linkLifetimeMs(preview.expiresAt, Date.now()));
    return () => clearTimeout(timer);
  }, [preview]);

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading the grief library" />;

  /** One request at a time: a preview mint or a status change. */
  const guarded = async (itemId: string, run: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusyId(itemId);
    setActionError(null);
    await run();
    inFlight.current = false;
    setBusyId(null);
  };

  const mintPreview = (item: LibraryItem, part: LibraryPart) =>
    guarded(item.itemId, async () => {
      const res = await libraryUrl(client, item.itemId, part);
      if (res.error || !res.data) {
        setActionError(errorMessage(res.error, "The preview could not be opened."));
        return;
      }
      if (safeMintedUrl(res.data.url) === null) {
        setActionError("The preview link was refused: it is not a secure (https) link.");
        return;
      }
      setPreview({ title: item.title, part, ...res.data });
      announce("The preview link is ready. Use Open preview to open it.", { focus: false });
    });

  const changeStatus = (item: LibraryItem, next: LibraryStatus) =>
    guarded(item.itemId, async () => {
      const res = await setLibraryStatus(
        client,
        item.itemId,
        item.version,
        next,
        keys.keyFor(`${item.itemId}:${item.version}:${next}`),
      );
      keys.settle(res.status, res.error);
      if (res.error || !res.data) {
        const message = errorMessage(res.error, "The item's status could not be changed.");
        if (isStaleWrite(res.status)) {
          void reload();
          setConfirming(null);
          announce(
            isStaleVersion(res.status, res.error)
              ? "This item changed while you were working on it. The library has been refreshed: check it and try again."
              : message,
          );
          return;
        }
        setActionError(message);
        return;
      }
      const saved = res.data;
      setConfirming(null);
      // Under a status filter the changed row no longer belongs to the list: re-read it rather than patch it in place.
      if (status === ALL) patch((rows) => rows.map((r) => (r.itemId === saved.itemId ? saved : r)));
      else void reload();
      announce(`${saved.title} is now ${humanize(saved.status).toLowerCase()}.`);
    });

  const rows = state.kind === "ready" ? state.data : [];
  const failure = state.kind === "error" ? state.message : state.notice;
  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Grief library</span>}
        actions={mayManage ? <Button onClick={() => setUploading(true)}>Upload item</Button> : null}
      />
      <span style={mutedStyle}>
        Reading and viewing material for bereaved families. Only published items appear in the
        family portal.
      </span>
      {region}
      <FilterRow>
        <SelectField
          label="Status"
          value={status}
          onChange={(next) => setStatus(next as LibraryStatus | typeof ALL)}
          options={[
            { value: ALL, label: "All statuses" },
            { value: "draft", label: "Draft" },
            { value: "published", label: "Published" },
            { value: "archived", label: "Archived" },
          ]}
        />
      </FilterRow>
      {failure ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{failure}</ErrorText>
          <Button size="sm" tone="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : null}
      {state.kind === "ready" && rows.length === 0 ? (
        <EmptyState
          title="No library items"
          description={
            status === ALL
              ? "Upload a PDF or image to start the library."
              : "No item has this status. Choose another status."
          }
        />
      ) : null}
      {preview ? (
        <span>
          <a
            ref={previewRef}
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              setPreview(null);
              announce("The preview link was used and removed from this page.");
            }}
          >
            Open preview
          </a>{" "}
          <span style={mutedStyle}>
            ({preview.part === "transcript" ? "transcript of " : ""}
            {preview.title}; the file downloads, and the link expires at{" "}
            {dateTime(preview.expiresAt)})
          </span>
        </span>
      ) : null}
      {actionError && confirming === null ? <ErrorText>{actionError}</ErrorText> : null}
      {rows.length > 0 ? (
        <table
          style={tableStyle}
          aria-label="Grief library"
          aria-busy={state.kind === "ready" && state.refreshing}
        >
          <thead>
            <tr>
              <th style={th}>Title</th>
              <th style={th}>Category</th>
              <th style={th}>Kind</th>
              <th style={th}>Status</th>
              <th style={thNum}>Sort order</th>
              <th style={th}>Published</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={item.itemId} style={rowLine}>
                <td style={td}>{item.title}</td>
                <td style={td}>{categoryLabel(item.category)}</td>
                <td style={td}>{item.kind === "pdf" ? "PDF" : humanize(item.kind)}</td>
                <td style={td}>
                  <StatusPill
                    label={humanize(item.status)}
                    tone={toneOf(LIBRARY_STATUS_TONE, item.status)}
                  />
                </td>
                <td style={tdNum}>{item.sortOrder}</td>
                <td style={td}>{dateTime(item.publishedAt)}</td>
                <td style={td}>
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                    <Button
                      size="sm"
                      tone="secondary"
                      disabled={busyId !== null}
                      aria-label={`Preview ${item.title}`}
                      onClick={() => void mintPreview(item, "document")}
                    >
                      Preview
                    </Button>
                    {item.transcriptDocumentId ? (
                      <Button
                        size="sm"
                        tone="secondary"
                        disabled={busyId !== null}
                        aria-label={`Transcript of ${item.title}`}
                        onClick={() => void mintPreview(item, "transcript")}
                      >
                        Transcript
                      </Button>
                    ) : null}
                    {mayManage ? (
                      <>
                        <Button
                          size="sm"
                          tone="secondary"
                          disabled={busyId !== null}
                          aria-label={`Edit ${item.title}`}
                          onClick={() => {
                            setActionError(null);
                            setEditing(item);
                          }}
                        >
                          Edit
                        </Button>
                        {libraryNextStatuses(item.status).map((next) => {
                          const label =
                            item.status === "archived" && next === "published"
                              ? "Republish"
                              : STATUS_ACTION[next];
                          const blocked = needsTranscript(item, next);
                          const reasonId = `${reasonIdBase}-${item.itemId}`;
                          return (
                            <span key={next} style={{ display: "inline-flex", gap: "0.4rem" }}>
                              <Button
                                size="sm"
                                disabled={busyId !== null || blocked}
                                aria-label={`${label} ${item.title}`}
                                {...(blocked ? { "aria-describedby": reasonId } : {})}
                                onClick={() => {
                                  setActionError(null);
                                  setConfirming({ item, next });
                                }}
                              >
                                {label}
                              </Button>
                              {blocked ? (
                                <span id={reasonId} style={mutedStyle}>
                                  {TRANSCRIPT_NEEDED}
                                </span>
                              ) : null}
                            </span>
                          );
                        })}
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {uploading ? (
        <LibraryUploadModal
          onClose={() => setUploading(false)}
          onRegistered={(item) => {
            setUploading(false);
            void reload();
            announce(`${item.title} was added to the library as a draft.`);
          }}
        />
      ) : null}
      {editing ? (
        <LibraryEditModal
          item={editing}
          onClose={() => setEditing(null)}
          onStale={(message) => {
            setEditing(null);
            announce(message);
            void reload();
          }}
          onSaved={(saved) => {
            setEditing(null);
            patch((rows) => rows.map((r) => (r.itemId === saved.itemId ? saved : r)));
            announce(`${saved.title} was saved.`);
          }}
        />
      ) : null}
      {confirming ? (
        <Modal
          title={`${
            confirming.item.status === "archived" && confirming.next === "published"
              ? "Republish"
              : STATUS_ACTION[confirming.next]
          } ${confirming.item.title}`}
          onClose={() => {
            setConfirming(null);
            setActionError(null);
          }}
          busy={busyId !== null}
          role="alertdialog"
          describedBy={confirmDescId}
          cancelLabel="Go back"
          footer={
            <button
              type="button"
              style={confirming.next === "archived" ? dangerButtonStyle : primaryButtonStyle}
              disabled={busyId !== null}
              onClick={() => void changeStatus(confirming.item, confirming.next)}
            >
              {busyId !== null
                ? "Saving…"
                : confirming.next === "archived"
                  ? "Yes, archive it"
                  : confirming.next === "published"
                    ? "Yes, publish it"
                    : "Yes, move it to draft"}
            </button>
          }
        >
          <span id={confirmDescId} style={mutedStyle}>
            {STATUS_CONFIRM[confirming.next]}
          </span>
          {actionError ? <ErrorText>{actionError}</ErrorText> : null}
        </Modal>
      ) : null}
    </div>
  );
}
