import { Glyph, StatusPill } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import type { Candidate } from "../doclens-api";
import { pageImageUrl } from "../doclens-api";
import { PART2_WITHHELD_MESSAGE, fieldLabel } from "../doclens-model";

type ImageState = "loading" | "ready" | "unavailable" | "forbidden";

function detailPath(batchId: string, candidateId: string, returnTo: string | null): string {
  const query = new URLSearchParams({ mode: "detailed", from: "unified", candidate: candidateId });
  if (returnTo) query.set("returnTo", returnTo);
  return `/intake/${encodeURIComponent(batchId)}/review?${query.toString()}`;
}

export function ReviewSourcePanel({
  batchId,
  candidate,
  returnTo,
  onClose,
  onAvailabilityChange,
}: {
  batchId: string;
  candidate: Candidate;
  returnTo: string | null;
  onClose: () => void;
  onAvailabilityChange: (page: number, unavailable: boolean) => void;
}): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [imageState, setImageState] = useState<ImageState>("loading");

  // biome-ignore lint/correctness/useExhaustiveDependencies: a candidate change or explicit retry must reset the image attempt.
  useEffect(() => {
    setImageState(candidate.redacted ? "forbidden" : "loading");
  }, [candidate.id, candidate.redacted, attempt]);

  const unavailable = (state: "unavailable" | "forbidden"): void => {
    setImageState(state);
    onAvailabilityChange(candidate.page, true);
  };
  const onImageError = (): void => {
    fetch(pageImageUrl(batchId, candidate.page))
      .then((response) => unavailable(response.status === 403 ? "forbidden" : "unavailable"))
      .catch(() => unavailable("unavailable"));
  };

  return (
    <section className="wx-unified-source" aria-labelledby="unified-source-title">
      <header>
        <div>
          <span className="wx-unified-category">Source evidence · Page {candidate.page}</span>
          <h2 id="unified-source-title">{fieldLabel(candidate.fieldPath)}</h2>
        </div>
        <button type="button" className="wx-btn-secondary wx-btn-sm" onClick={onClose}>
          <Glyph name="close" size={15} /> Close
        </button>
      </header>
      <div className="wx-unified-source-stage">
        {imageState === "forbidden" ? (
          <div role="alert" className="wx-unified-source-failure">
            <Glyph name="shield" size={24} />
            <strong>Source access is restricted</strong>
            <p>{PART2_WITHHELD_MESSAGE}</p>
          </div>
        ) : imageState === "unavailable" ? (
          <div role="alert" className="wx-unified-source-failure">
            <Glyph name="alert" size={24} />
            <strong>Source page could not be loaded</strong>
            <p>This observation cannot be source-confirmed from this preview.</p>
            <button
              type="button"
              className="wx-btn-secondary"
              onClick={() => {
                setAttempt((current) => current + 1);
              }}
            >
              <Glyph name="rotate-ccw" size={16} /> Retry source
            </button>
          </div>
        ) : (
          <>
            {imageState === "loading" ? (
              <StatusPill label="Loading source" tone="progress" />
            ) : null}
            <img
              key={`${candidate.id}:${attempt}`}
              src={pageImageUrl(batchId, candidate.page)}
              alt={`Page ${candidate.page} of the source document for ${fieldLabel(candidate.fieldPath)}`}
              onLoad={() => {
                setImageState("ready");
                onAvailabilityChange(candidate.page, false);
              }}
              onError={onImageError}
            />
          </>
        )}
      </div>
      <footer>
        <p>
          Preview only. Opening this page does not confirm the source or record a clinical decision.
        </p>
        <Link className="wx-btn-primary" to={detailPath(batchId, candidate.id, returnTo)}>
          Open detailed review <Glyph name="arrow-right" size={16} />
        </Link>
      </footer>
    </section>
  );
}
