// M36 WP 3.2 - the chip for a clinicalLink node in a message body. READ-THROUGH: it resolves the link with one GET at the
// time the chip is visible and shows kind + status + "as of"; the message stores ids only. It is a LINK to the owning
// module's screen. It never edits, and nothing here issues a non-GET request. `unavailable` never says why (missing,
// forbidden, erased and failing sources are one answer); a 404 means the tenant flag is off and degrades to the plain
// placeholder the server projects for the same node.
import { CLINICAL_LINK_PLAIN_TEXT } from "@chartwarden/types";
import type { ClinicalLinkKind } from "@chartwarden/types";
import { useApiClient } from "@chartwarden/ui";
import { createContext, useContext, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { CLINICAL_LINK_KIND_LABEL } from "./clinical-link-kinds";
import { MEDICATION_LINK_NOTICE } from "./medication-question-wording";
import "./clinical-links.css";
import "./medication-question.css";

/** `${kind}:${entityId}` -> link_id, from the message's `clinicalLinks`. Provided by the message renderer. */
export const ClinicalLinkIdsContext = createContext<ReadonlyMap<string, string>>(new Map());
export const clinicalLinkKey = (kind: string, entityId: string): string => `${kind}:${entityId}`;

interface Resolved {
  readonly status: string;
  readonly asOf: string;
  readonly link: string;
}
type State =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly value: Resolved }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error" }
  | { readonly kind: "off" };

/** Only an in-app absolute path becomes an anchor; "//host" and anything else is dropped. */
export const isInAppPath = (link: string): boolean =>
  /^\/(?!\/)/.test(link) &&
  ![...link].some((c) => c === "\\" || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** True once the element has been on screen. Without IntersectionObserver (old browsers, jsdom) it is true at once. */
function useSeen(element: Element | null): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen || !element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen, element]);
  return seen;
}

/** "as of ..." or null when the server's timestamp does not parse. */
const asOfLabel = (iso: string): string | null => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : `as of ${date.toLocaleString()}`;
};
const statusLabel = (status: string): string => status.replaceAll("_", " ");

function useResolvedLink(linkId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the read after a Retry
  useEffect(() => {
    if (!linkId || !enabled) return;
    let stale = false;
    const controller = new AbortController();
    setState({ kind: "loading" });
    client
      .GET("/api/v1/messaging/clinical-links/{linkId}/resolve", {
        params: { path: { linkId } },
        signal: controller.signal,
      })
      .then(({ data, response }) => {
        if (stale) return;
        if (data?.state === "ok") {
          setState({
            kind: "ok",
            value: { status: data.status, asOf: data.as_of, link: data.link },
          });
        } else if (data) setState({ kind: "unavailable" });
        else setState({ kind: response?.status === 404 ? "off" : "error" });
      })
      .catch(() => {
        if (!stale) setState({ kind: "error" });
      });
    return () => {
      stale = true;
      controller.abort();
    };
  }, [client, linkId, enabled, attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}

export function ClinicalLinkChip({
  kind,
  entityId,
}: { kind: ClinicalLinkKind; entityId: string }): JSX.Element {
  const linkId = useContext(ClinicalLinkIdsContext).get(clinicalLinkKey(kind, entityId));
  // A state-held element (callback ref): the observer attaches whenever the chip mounts, even after the link id arrives.
  const [root, setRoot] = useState<HTMLSpanElement | null>(null);
  const seen = useSeen(root);
  const { state, retry } = useResolvedLink(linkId, seen);
  const kindLabel = CLINICAL_LINK_KIND_LABEL[kind];
  // H-04: a medication link always carries the fixed line, whatever state the chip is in. A link is never an order action.
  const notice =
    kind === "medication" ? (
      <small className="wx-clinical-link-banner">{MEDICATION_LINK_NOTICE}</small>
    ) : null;

  // No link id yet (an optimistic row before the server's copy arrives) or the feature is off: the plain placeholder.
  if (!linkId || state.kind === "off") {
    return (
      <span className="wx-clinical-link-wrap">
        <span className="wx-message-reference">{CLINICAL_LINK_PLAIN_TEXT}</span>
        {notice}
      </span>
    );
  }
  return (
    <span ref={setRoot} className="wx-clinical-link-wrap">
      {state.kind === "loading" ? (
        <output className="wx-clinical-link is-pending">
          Loading linked {kindLabel.toLowerCase()}…
        </output>
      ) : state.kind === "error" ? (
        <span className="wx-clinical-link is-error" role="alert">
          Linked {kindLabel.toLowerCase()} could not be loaded.{" "}
          <button type="button" onClick={retry}>
            Retry
          </button>
        </span>
      ) : state.kind === "unavailable" ? (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a chip must be reachable by keyboard to be read
        <span className="wx-clinical-link is-unavailable" tabIndex={0}>
          Record unavailable
        </span>
      ) : (
        <ResolvedChip kindLabel={kindLabel} value={state.value} />
      )}
      {notice}
    </span>
  );
}

function ResolvedChip({ kindLabel, value }: { kindLabel: string; value: Resolved }): JSX.Element {
  const summary = `${kindLabel}, ${statusLabel(value.status)}`;
  const asOf = asOfLabel(value.asOf);
  const body = (
    <>
      <strong>{kindLabel}</strong>
      <span>{statusLabel(value.status)}</span>
      {asOf ? <small>{asOf}</small> : null}
    </>
  );
  return isInAppPath(value.link) ? (
    <Link
      className="wx-clinical-link"
      to={value.link}
      aria-label={`Open linked ${summary}${asOf ? `, ${asOf}` : ""}`}
    >
      {body}
    </Link>
  ) : (
    <span
      className="wx-clinical-link"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: no safe destination, but the chip is still readable by keyboard
      tabIndex={0}
      aria-label={`Linked ${summary}${asOf ? `, ${asOf}` : ""}`}
    >
      {body}
    </span>
  );
}
