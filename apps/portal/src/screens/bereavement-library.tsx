import { Button, Glyph, useApiClient } from "@chartwarden/ui";
// M31 bereavement support — the grief library the hospice team published (ADR-0109 D10, PR 3). M16 decides what is published; this section
// lists it and, when the family chooses an item, asks for a short-lived link (`/url`) and opens it: a reading in a new tab, a video in a
// player on the page. A transcript link is offered when the item has one. The link is held in memory only and never stored.
// A route this account may not use shows nothing; a failure is said with a retry.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { SectionError, SectionLoading } from "./bereavement-section";
import { humanize, readError } from "./portal-format";

interface LibraryItem {
  itemId: string;
  title: string;
  summary: string | null;
  category: string;
  kind: "pdf" | "video" | "other";
  hasTranscript: boolean;
}
type Part = "document" | "transcript";
const CATEGORY_LABEL: Record<string, string> = {
  understanding_grief: "Understanding grief",
  coping: "Coping",
  children_and_teens: "Children and teens",
  holidays_and_anniversaries: "Holidays and anniversaries",
  practical_matters: "Practical matters",
  other: "Other",
};
type Loaded =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: LibraryItem[] };

/** A minted link is only ever https (loopback http is the local dev object store). */
function safeMintedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.href : null;
  } catch {
    return null;
  }
}

export function BereavementLibrarySection(): JSX.Element | null {
  const client = useApiClient();
  const [state, setState] = useState<Loaded>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    void attempt;
    let active = true;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const res = await client.GET("/api/v1/portal/bereavement/library", {});
        if (!active) return;
        const status = res.response?.status;
        if (res.error) {
          setState(
            status === 403 || status === 404
              ? { kind: "hidden" }
              : { kind: "error", message: readError(status) },
          );
          return;
        }
        const items = (res.data as { items?: unknown } | undefined)?.items;
        setState(
          Array.isArray(items)
            ? { kind: "ready", items: items as LibraryItem[] }
            : { kind: "error", message: readError(undefined) },
        );
      } catch {
        if (active) setState({ kind: "error", message: readError(undefined) });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, attempt]);

  if (state.kind === "hidden") return null;
  return (
    <section className="wx-bereavement-panel" aria-labelledby="bereavement-library-heading">
      <div className="wx-bereavement-panel__heading">
        <span className="wx-bereavement-panel__icon" aria-hidden="true">
          <Glyph name="folder" size={21} />
        </span>
        <div>
          <h2 id="bereavement-library-heading">Grief library</h2>
          <p>Readings and videos from your hospice team, for whenever you feel ready.</p>
        </div>
      </div>
      {state.kind === "loading" ? (
        <SectionLoading label="Loading the grief library" />
      ) : state.kind === "error" ? (
        <SectionError message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : state.items.length === 0 ? (
        <div className="wx-bereavement-empty">
          <Glyph name="folder" size={24} aria-hidden="true" />
          <strong>Nothing in the library yet</strong>
          <p>When your hospice team shares readings or videos, they will appear here.</p>
        </div>
      ) : (
        <ul className="wx-bereavement-resources">
          {state.items.map((item) => (
            <LibraryEntry key={item.itemId} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LibraryEntry({ item }: { item: LibraryItem }): JSX.Element {
  const client = useApiClient();
  const [opening, setOpening] = useState<Part | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ part: Part; url: string } | null>(null);
  const isVideo = item.kind === "video";

  async function open(part: Part): Promise<void> {
    if (opening) return;
    setOpening(part);
    setError(null);
    try {
      const res = await client.GET("/api/v1/portal/bereavement/library/{itemId}/url", {
        params: { path: { itemId: item.itemId }, query: { part } },
        cache: "no-store",
      });
      const url = res.data ? safeMintedUrl(res.data.url) : null;
      if (res.error || !url) {
        setError("We couldn't open this right now. Please try again in a moment.");
        return;
      }
      setLink({ part, url });
    } catch {
      setError("We couldn't open this right now. Please check your connection and try again.");
    } finally {
      setOpening(null);
    }
  }

  const label = item.title.trim() || "Library item";
  return (
    <li className="wx-bereavement-resource">
      <div className="wx-bereavement-resource__body">
        <span className="wx-bereavement-eyebrow">
          {CATEGORY_LABEL[item.category] ?? humanize(item.category)} ·{" "}
          {isVideo ? "Video" : item.kind === "pdf" ? "Reading" : "File"}
        </span>
        <h3>{label}</h3>
        {item.summary?.trim() ? <p>{item.summary}</p> : null}
        <div className="wx-bereavement-actions">
          <Button
            tone="secondary"
            loading={opening === "document"}
            disabled={opening !== null}
            onClick={() => void open("document")}
          >
            {isVideo ? `Watch ${label}` : `Open ${label}`}
          </Button>
          {item.hasTranscript ? (
            <Button
              tone="secondary"
              loading={opening === "transcript"}
              disabled={opening !== null}
              onClick={() => void open("transcript")}
            >
              Read the transcript
            </Button>
          ) : null}
        </div>
        {link && link.part === "document" && isVideo ? (
          // biome-ignore lint/a11y/useMediaCaption: captions are not part of the upload contract yet; the transcript is offered beside it
          <video controls src={link.url} aria-label={label} className="wx-bereavement-video" />
        ) : null}
        {link && !(link.part === "document" && isVideo) ? (
          <a
            className="wx-bereavement-resource__link"
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setLink(null)}
          >
            {link.part === "transcript" ? "Open the transcript" : `Open ${label}`} (new tab){" "}
            <Glyph name="arrow-right" size={16} aria-hidden="true" />
          </a>
        ) : null}
        {error ? (
          <div className="wx-bereavement-opt-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </li>
  );
}
