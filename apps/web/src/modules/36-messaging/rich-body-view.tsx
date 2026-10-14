import {
  type RichBlock,
  type RichBody,
  type RichInline,
  type RichList,
  type RichMark,
  type RichParagraph,
  linkTargetLabel,
  safeLinkHref,
  sanitizeRichBody,
} from "@wardenx/types";
import { useMemo } from "react";
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ClinicalLinkChip, ClinicalLinkIdsContext, clinicalLinkKey } from "./clinical-link-chip";
import { needsDestinationSuffix } from "./link-destination";
import type { MessageReference } from "./messaging-types";

// M36 WP 2.1 - the safe renderer for a structured message body.
//
// Builds React elements from the document AST, field by field. There is no dangerouslySetInnerHTML, no innerHTML,
// no markdown/HTML parsing here: every string reaches the DOM as a React text child (escaped by React), and the only
// attribute values derived from message content are a link's href (re-checked against the https/mailto allowlist
// at render time, not trusted from the server) and its title. The document is re-sanitised before it is walked, so a
// stale or hand-edited payload cannot widen what is rendered.

const LINK_REL = "noopener noreferrer";

function applyMarks(
  content: ReactNode,
  marks: readonly RichMark[],
  visibleText: string,
): ReactNode {
  let node = content;
  for (const mark of marks) {
    if (mark.type === "code") node = <code>{node}</code>;
    else if (mark.type === "bold") node = <strong>{node}</strong>;
    else if (mark.type === "italic") node = <em>{node}</em>;
    else {
      const href = safeLinkHref(mark.href);
      // An unsafe target degrades to its visible text, never to an inert-looking-but-live anchor.
      if (href === null) continue;
      // The canonical host as the URL parser spells it: an internationalised host is punycode (xn--...), and a
      // destination like that always gets the inline suffix, so the tell is never hidden by identical-looking text.
      const destination = linkTargetLabel(href);
      const external = href.startsWith("https:");
      node = (
        <a
          href={href}
          {...(external ? { target: "_blank" } : {})}
          rel={LINK_REL}
          // The visible text is whatever the author typed; the title also shows where the link really goes.
          title={`Opens ${destination}`}
        >
          {node}
          {needsDestinationSuffix(visibleText, href) ? (
            <span className="wx-link-destination"> ({destination})</span>
          ) : null}
          {external ? <span className="sr-only"> (opens in new tab)</span> : null}
        </a>
      );
    }
  }
  return node;
}

function Inline({
  node,
  references,
}: {
  node: RichInline;
  references: readonly MessageReference[];
}): JSX.Element {
  if (node.type === "hardBreak") return <br />;
  if (node.type === "text") {
    return <span>{applyMarks(node.text, node.marks ?? [], node.text)}</span>;
  }
  if (node.type === "clinicalLink") {
    return <ClinicalLinkChip kind={node.kind} entityId={node.entityId} />;
  }
  // The server's label (fresh from the directory) wins over the label frozen into the document.
  const reference = references.find(
    (candidate) => candidate.kind === node.kind && candidate.entityId === node.entityId,
  );
  const label = `@${reference?.displayLabel.trim() || node.label}`;
  if (node.kind === "patient" && reference?.navigable) {
    return (
      <Link className="wx-message-reference" to={`/patients/${node.entityId}`}>
        {label}
      </Link>
    );
  }
  return <span className="wx-message-reference">{label}</span>;
}

function Paragraph({
  node,
  references,
}: {
  node: RichParagraph;
  references: readonly MessageReference[];
}): JSX.Element {
  return (
    <p className="wx-rich-p">
      {node.content.map((child, index) => (
        <Inline
          // biome-ignore lint/suspicious/noArrayIndexKey: the document is immutable; position is its identity
          key={index}
          node={child}
          references={references}
        />
      ))}
    </p>
  );
}

function List({
  node,
  references,
}: {
  node: RichList;
  references: readonly MessageReference[];
}): JSX.Element {
  const Tag = node.type === "orderedList" ? "ol" : "ul";
  return (
    <Tag className="wx-rich-list">
      {node.content.map((item, itemIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the document is immutable; position is its identity
        <li key={itemIndex}>
          {item.content.map((child, childIndex) =>
            child.type === "paragraph" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: immutable document
              <Paragraph key={childIndex} node={child} references={references} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: immutable document
              <List key={childIndex} node={child} references={references} />
            ),
          )}
        </li>
      ))}
    </Tag>
  );
}

function Block({
  node,
  references,
}: {
  node: RichBlock;
  references: readonly MessageReference[];
}): JSX.Element {
  if (node.type === "paragraph") return <Paragraph node={node} references={references} />;
  if (node.type === "codeBlock") {
    return (
      <pre className="wx-rich-code">
        <code>{node.text}</code>
      </pre>
    );
  }
  return <List node={node} references={references} />;
}

/**
 * Render a message's structured body. Falls back to `fallbackText` (the server's plain-text projection) when the
 * document does not pass the shared sanitiser, so a bad payload shows readable text and never raw structure.
 */
export function RichBodyView({
  bodyDoc,
  references,
  fallbackText,
  clinicalLinks,
}: {
  bodyDoc: RichBody | undefined;
  references: readonly MessageReference[];
  fallbackText: string;
  /** WP 3.2: the message's link ids; a chip with no entry here shows the plain placeholder. */
  clinicalLinks?: readonly { link_id: string; kind: string; entity_id: string }[];
}): JSX.Element {
  const linkIds = useMemo(
    () =>
      new Map((clinicalLinks ?? []).map((l) => [clinicalLinkKey(l.kind, l.entity_id), l.link_id])),
    [clinicalLinks],
  );
  // Sanitised once per document, not once per render: typing in the composer re-renders the thread.
  const checked = useMemo(
    () => (bodyDoc === undefined ? null : sanitizeRichBody(bodyDoc)),
    [bodyDoc],
  );
  if (!checked?.ok) return <span className="wx-rich-fallback">{fallbackText}</span>;
  return (
    <ClinicalLinkIdsContext.Provider value={linkIds}>
      <div className="wx-rich-body">
        {checked.value.doc.content.map((block, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the document is immutable; position is its identity
          <Block key={index} node={block} references={references} />
        ))}
      </div>
    </ClinicalLinkIdsContext.Provider>
  );
}
