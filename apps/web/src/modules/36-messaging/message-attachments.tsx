import { Glyph, useApiClient } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { displayFileName, formatBytes, isSafeAccessUrl } from "./attachment-utils";
import type { MessageAttachment } from "./messaging-types";

type OpenState = "idle" | "opening" | "unavailable" | "popup-blocked";

const OPEN_FAILURE_TEXT: Readonly<Record<OpenState, string>> = {
  idle: "",
  opening: "Opening…",
  unavailable: "File unavailable",
  "popup-blocked": "Allow pop-ups to open files",
};

function AttachmentRow({ attachment }: { attachment: MessageAttachment }): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState<OpenState>("idle");
  const mountedRef = useRef(true);
  const openingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The tab is opened inside the click (Safari/iOS block a window.open that follows an await), then pointed at a
  // fresh signed URL (it lives 120 s): fetched, used once, never stored, rendered or logged.
  async function open(): Promise<void> {
    if (openingRef.current) return;
    // "noopener" in the features string would make window.open return null, so detach the opener by hand.
    // A blocked popup is treated as a failure to open (no same-tab navigation: that would leave the thread).
    const tab = window.open("", "_blank");
    if (!tab) {
      setState("popup-blocked");
      return;
    }
    openingRef.current = true;
    setState("opening");
    let url: string | null = null;
    try {
      tab.opener = null;
      const { data } = await client.GET("/api/v1/messaging/attachments/{id}/access", {
        params: { path: { id: attachment.attachmentId } },
      });
      url = data?.url && isSafeAccessUrl(data.url) ? data.url : null;
    } catch {
      url = null;
    } finally {
      openingRef.current = false;
    }
    let navigated = false;
    if (url && mountedRef.current) {
      try {
        tab.location.replace(url);
        navigated = true;
      } catch {
        navigated = false;
      }
    }
    if (!navigated) {
      try {
        tab.close();
      } catch {
        // Nothing left to clean up; the failure is shown below.
      }
    }
    // Every failure reads the same: the server answers one 404 for all of them, and so do we.
    if (mountedRef.current) setState(navigated ? "idle" : "unavailable");
  }

  const name = displayFileName(attachment.fileName);
  const meta = `${attachment.mimeType === "application/pdf" ? "PDF" : "File"} · ${formatBytes(attachment.byteSize)}`;
  return (
    <li className="wx-message-attachment">
      <Glyph name="file-text" size={18} />
      <span className="wx-attachment-name" title={name}>
        {name}
      </span>
      <span className="wx-attachment-size">{meta}</span>
      {attachment.availability === "available" ? (
        <button
          type="button"
          className="wx-attachment-open"
          aria-disabled={state === "opening"}
          aria-label={`Open ${name} in a new tab`}
          onClick={() => void open()}
        >
          Open
        </button>
      ) : (
        <output className="wx-attachment-state">Scanning…</output>
      )}
      {/* Mounted up front on openable rows so assistive tech announces text filled in later. */}
      {attachment.availability === "available" ? (
        <output className="wx-attachment-unavailable">{OPEN_FAILURE_TEXT[state]}</output>
      ) : null}
    </li>
  );
}

export function MessageAttachments({
  attachments,
}: {
  attachments: readonly MessageAttachment[] | undefined;
}): JSX.Element | null {
  if (!attachments || attachments.length === 0) return null;
  return (
    <ul className="wx-message-attachments" aria-label="Attachments">
      {attachments.map((attachment) => (
        <AttachmentRow key={attachment.attachmentId} attachment={attachment} />
      ))}
    </ul>
  );
}
