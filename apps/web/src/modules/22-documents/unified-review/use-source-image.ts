// UR — the load machine of one source page image, shared by the field-task panel and the safeguard
// panel: loading, ready, or a refused / unavailable / expired page. An image error carries no status,
// so a HEAD probe (no body to download) tells a restricted page (403) and an ended session (401) from
// a failed one. Late answers never write: a new image, a retry or an unmount drops a probe in flight.
import { useRequestGuard } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { PlatformSupportAccess } from "../doclens-api";
import { pageImageUrl } from "../doclens-api";

export type SourceImageState = "loading" | "ready" | "unavailable" | "forbidden" | "expired";
type FailedState = Exclude<SourceImageState, "loading" | "ready">;

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

interface Settled {
  /** The image this answer belongs to; an answer for an earlier image is never shown. */
  readonly key: string;
  readonly state: "ready" | FailedState;
  readonly naturalWidth: number | null;
}

export interface SourceImageOptions {
  batchId: string;
  /** The page to show; null when there is none (nothing is requested). */
  page: number | null;
  access?: PlatformSupportAccess | null;
  /** Part 2 content is withheld: the image is never requested and the source reads as restricted. */
  withheld: boolean;
  /** What is on screen (a candidate id, a page number): a new value starts a new image load. */
  resetKey: string;
  /** Called with `unavailable` false once the page shows, true once it could not be shown. */
  onAvailabilityChange?: (page: number, unavailable: boolean) => void;
}

export interface SourceImage {
  readonly state: SourceImageState;
  /** The page's natural width in pixels once it has loaded; null before that or when unknown. */
  readonly naturalWidth: number | null;
  readonly imageRef: RefObject<HTMLImageElement>;
  /** The `key` of the `<img>`: a retry or a new page remounts the element so the browser loads it afresh. */
  readonly imageKey: string;
  readonly src: string | undefined;
  readonly onLoad: (event: { currentTarget: HTMLImageElement }) => void;
  readonly onError: () => void;
  readonly retry: () => void;
}

/** Why a page image that errored could not be shown. Never rejects. */
async function probeFailure(url: string): Promise<FailedState> {
  try {
    const { status } = await fetch(url, { method: "HEAD" });
    if (status === HTTP_FORBIDDEN) return "forbidden";
    return status === HTTP_UNAUTHORIZED ? "expired" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export function useSourceImage({
  batchId,
  page,
  access,
  withheld,
  resetKey,
  onAvailabilityChange,
}: SourceImageOptions): SourceImage {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);
  const imageKey = `${resetKey}:${attempt}`;
  const [shownKey, setShownKey] = useState(imageKey);
  const imageRef = useRef<HTMLImageElement>(null);
  const report = useRef(onAvailabilityChange);
  const guard = useRequestGuard();

  // A new image (another page, a retry) forgets the previous answer in the same render, so a page
  // seen earlier never reads as loaded while its replacement element is still loading.
  if (shownKey !== imageKey) {
    setShownKey(imageKey);
    setSettled(null);
  }

  useEffect(() => {
    report.current = onAvailabilityChange;
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new image or a retry must drop a probe still in flight.
  useEffect(() => {
    guard();
  }, [imageKey]);

  const markReady = useCallback(
    (image: HTMLImageElement): void => {
      setSettled({ key: imageKey, state: "ready", naturalWidth: image.naturalWidth || null });
      if (page !== null) report.current?.(page, false);
    },
    [imageKey, page],
  );

  // A cached image can fire `load` before React attaches its handler; read it once the element exists.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new image element needs the check.
  useEffect(() => {
    const image = imageRef.current;
    if (!withheld && image?.complete && image.naturalWidth > 0) markReady(image);
  }, [imageKey, withheld]);

  const onError = useCallback((): void => {
    if (page === null) return;
    const stillCurrent = guard();
    void probeFailure(pageImageUrl(batchId, page, access)).then((state) => {
      if (!stillCurrent()) return;
      setSettled({ key: imageKey, state, naturalWidth: null });
      report.current?.(page, true);
    });
  }, [access, batchId, guard, imageKey, page]);

  const current = settled?.key === imageKey ? settled : null;
  return {
    state: withheld ? "forbidden" : (current?.state ?? "loading"),
    naturalWidth: current?.naturalWidth ?? null,
    imageRef,
    imageKey,
    src: page === null ? undefined : pageImageUrl(batchId, page, access),
    onLoad: (event) => markReady(event.currentTarget),
    onError,
    retry: () => setAttempt((count) => count + 1),
  };
}
