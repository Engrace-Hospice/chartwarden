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
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import type { MessageReference } from "./messaging-types";

// M36 WP 2.1 - the safe renderer for a structured message body.
//
// Builds React elements from the document AST, field by field. There is no dangerouslySetInnerHTML, no innerHTML,
// no markdown/HTML parsing here: every string reaches the DOM as a React text child (escaped by React), and the only
// attribute values derived from message content are a link's href (re-checked against the https/mailto allowlist
// at render time, not trusted from the server) and its title. The document is re-sanitised before it is walked, so a
// stale or hand-edited payload cannot widen what is rendered.

const LINK_REL = "noopener noreferrer";

function applyMarks(content: ReactNode, marks: readonly RichMark[], key: string): ReactNode {
  let node = content;
  for (const mark of marks) {
    if (mark.type === "code") node = <code>{node}</code>;
    else if (mark.type === "bold") node = <strong>{node}</strong>;
    else if (mark.type === "italic") node = <em>{node}</em>;
    else {
      const href = safeLinkHref(mark.href);
      // An unsafe target degrades to its visible text, never to an inert-looking-but-live anchor.
      if (href === null) continue;
      node = (
        <a
          key={`${key}-a`}
          href={href}
          target="_blank"
          rel={LINK_REL}
          // The visible text is whatever the author typed; the title always shows where the link really goes.
          title={`Opens ${linkTargetLabel(href)}`}
        >
          {node}
        </a>
      );
    }
  }
  return node;
}

function Inline({
  node,
  index,
  references,
}: {
  node: RichInline;
  index: number;
  references: readonly MessageReference[];
}): JSX.Element {
  const key = `i-${index}`;
  if (node.type === "hardBreak") return <br key={key} />;
  if (node.type === "text") {
    return <span key={key}>{applyMarks(node.text, node.marks ?? [], key)}</span>;
  }
  // The server's label (fresh from the directory) wins over the label frozen into the document.
  const reference = references.find(
    (candidate) => candidate.kind === node.kind && candidate.entityId === node.entityId,
  );
  const label = `@${reference?.displayLabel.trim() || node.label}`;
  if (node.kind === "patient" && reference?.navigable) {
    return (
      <Link key={key} className="wx-message-reference" to={`/patients/${node.entityId}`}>
        {label}
      </Link>
    );
  }
  return (
    <span key={key} className="wx-message-reference">
      {label}
    </span>
  );
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
        // biome-ignore lint/suspicious/noArrayIndexKey: the document is immutable; position is its identity
        <Inline key={index} node={child} index={index} references={references} />
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
}: {
  bodyDoc: RichBody | undefined;
  references: readonly MessageReference[];
  fallbackText: string;
}): JSX.Element {
  const checked = bodyDoc === undefined ? null : sanitizeRichBody(bodyDoc);
  if (!checked?.ok) return <>{fallbackText}</>;
  return (
    <div className="wx-rich-body">
      {checked.value.doc.content.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the document is immutable; position is its identity
        <Block key={index} node={block} references={references} />
      ))}
    </div>
  );
}
