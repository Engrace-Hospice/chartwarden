import { Button, Glyph, linkLifetimeMs, safeMintedUrl, useApiClient } from "@chartwarden/ui";
// M31 bereavement support — the grief library the hospice team published (ADR-0109 D10, PR 3). M16 decides what is published; this section
// lists it and, when the family chooses an item, asks for a short-lived link (`/url`) and opens it: a reading in a new tab, a video in a
// player on the page. A transcript link is offered when the item has one. The link is held in memory only, never stored, and dropped when
// it expires (and the family is told so); a video whose link fails mid-way (a network or source error, not a decode error) is renewed
// and seeks back to where it was. Focus moves to the new link or player; a renewal leaves focus where it is.
// A route this account may not use shows nothing; a failure is said with a retry.
import { useEffect, useRef, useState } from "react";
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

/** A video whose link keeps failing right after a renewal is broken, not expired: stop renewing after this many tries in a row. */
const MAX_RENEWALS = 2;
/** MediaError codes an expired or unreachable link produces (MEDIA_ERR_NETWORK, MEDIA_ERR_SRC_NOT_SUPPORTED): a fresh link may cure them.
 * A decode error (3) is the file itself, which a new link does not change. */
const RENEWABLE_MEDIA_ERRORS: ReadonlySet<number> = new Set([2, 4]);
const LINK_EXPIRED = "That link has expired. Choose Open again.";
const CANNOT_PLAY = "This video can't be played right now. Please try again later.";

interface MintedLink {
  part: Part;
  url: string;
  expiresAt: string;
  /** Where a renewed video picks up (seconds), or null to start at the beginning. */
  resumeAt: number | null;
  /** The family asked for it: focus moves to the new link or player. A renewal behind the scenes keeps focus where it is. */
  focus: boolean;
}

function LibraryEntry({ item }: { item: LibraryItem }): JSX.Element {
  const client = useApiClient();
  const [opening, setOpening] = useState<Part | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [link, setLink] = useState<MintedLink | null>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const playerRef = useRef<HTMLVideoElement>(null);
  const renewals = useRef(0);
  const isVideo = item.kind === "video";
  const playsHere = link !== null && link.part === "document" && isVideo;

  useEffect(() => {
    if (link === null) return;
    if (link.focus) (playsHere ? playerRef.current : linkRef.current)?.focus();
    // A link to open is a credential: it is dropped when it expires, and the next Open mints a fresh one. The player keeps its source
    // (it may be mid-way through); an expired source surfaces as an error, which renews it.
    if (playsHere) return;
    const timer = setTimeout(
      () => {
        setLink(null);
        setNotice(LINK_EXPIRED);
      },
      linkLifetimeMs(link.expiresAt, Date.now()),
    );
    return () => clearTimeout(timer);
  }, [link, playsHere]);

  /** Mint a short-lived link. `resumeAt` set: a video renewal, which keeps focus where it is. */
  async function open(part: Part, resumeAt: number | null = null): Promise<boolean> {
    if (opening) return false;
    setOpening(part);
    setError(null);
    if (resumeAt === null) setNotice("");
    try {
      const res = await client.GET("/api/v1/portal/bereavement/library/{itemId}/url", {
        params: { path: { itemId: item.itemId }, query: { part } },
        cache: "no-store",
      });
      const url = res.data ? safeMintedUrl(res.data.url) : null;
      if (res.error || !res.data || !url) {
        setNotice("");
        setError("We couldn't open this right now. Please try again in a moment.");
        return false;
      }
      setLink({ part, url, expiresAt: res.data.expiresAt, resumeAt, focus: resumeAt === null });
      return true;
    } catch {
      setNotice("");
      setError("We couldn't open this right now. Please check your connection and try again.");
      return false;
    } finally {
      setOpening(null);
    }
  }

  async function renewVideo(code: number | undefined, at: number): Promise<void> {
    if (
      code === undefined ||
      !RENEWABLE_MEDIA_ERRORS.has(code) ||
      renewals.current >= MAX_RENEWALS
    ) {
      setNotice("");
      setError(CANNOT_PLAY);
      return;
    }
    renewals.current += 1;
    if (await open("document", at)) setNotice("We refreshed the video link.");
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
            onClick={() => {
              renewals.current = 0;
              void open("document");
            }}
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
        {playsHere ? (
          // biome-ignore lint/a11y/useMediaCaption: captions are not part of the upload contract yet; the transcript is offered beside it
          <video
            ref={playerRef}
            // focusable everywhere (some engines do not focus a <video> programmatically), and still in the tab order
            tabIndex={0}
            controls
            src={link.url}
            aria-label={label}
            className="wx-bereavement-video"
            onLoadedMetadata={(e) => {
              if (link.resumeAt !== null) e.currentTarget.currentTime = link.resumeAt;
            }}
            onPlaying={() => {
              renewals.current = 0;
            }}
            onError={(e) =>
              void renewVideo(
                e.currentTarget.error?.code,
                e.currentTarget.currentTime || (link.resumeAt ?? 0),
              )
            }
          />
        ) : null}
        {link && !playsHere ? (
          <a
            ref={linkRef}
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
        {/* biome-ignore lint/a11y/useSemanticElements: the region stays mounted so a renewal is announced */}
        <div role="status">{notice}</div>
        {error ? (
          <div className="wx-bereavement-opt-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </li>
  );
}
