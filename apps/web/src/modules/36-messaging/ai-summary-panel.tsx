// M36 WP 6.5 (ADR-0095) - the AI summary panel (UI spec 6.5): a complementary region beside the conversation. Every string from the model is
// rendered as TEXT (React escapes it; there is no dangerouslySetInnerHTML, link or image here). A citation is a button that jumps to a message
// ONLY when that message is in the loaded conversation; otherwise it is plain text. There is no send, task or order control in this panel: the
// only way text leaves it is "Copy to draft", which puts it in the composer for the person to edit and send themselves.
import type { MessagingAiSummaryDto } from "@chartwarden/types";
import { Glyph } from "@chartwarden/ui";
import { type JSX, useEffect, useRef } from "react";
import {
  AI_BACK_TO_SUMMARY,
  AI_CANCEL,
  AI_COPIED,
  AI_COPY_TO_DRAFT,
  AI_DRAFTS_TITLE,
  AI_DRAFT_REPLY,
  AI_GENERATING,
  AI_GENERIC_ERROR,
  AI_GUARDRAIL,
  AI_LIMITED_TEXT,
  AI_NOT_A_SUBSTITUTE,
  AI_NOT_FOR_CHANNEL_TEXT,
  AI_NOT_USEFUL,
  AI_NO_OPEN_QUESTIONS,
  AI_PANEL_TITLE,
  AI_REFUSED_TEXT,
  AI_REGENERATE,
  AI_TOO_LITTLE,
  AI_UNAVAILABLE_TEXT,
  AI_UNCERTAINTY_LEAD,
  CONFIDENCE_TEXT,
  basedOn,
  notIncluded,
} from "./ai-wording";
import type { AiProblem, AiView } from "./use-ai-assist";

const PROBLEM_TEXT: Readonly<Record<AiProblem, string>> = {
  unavailable: AI_UNAVAILABLE_TEXT,
  limited: AI_LIMITED_TEXT,
  refused: AI_REFUSED_TEXT,
  not_for_channel: AI_NOT_FOR_CHANNEL_TEXT,
  error: AI_GENERIC_ERROR,
};

export interface AiSummaryPanelProps {
  readonly view: AiView;
  /** Ids of the messages currently loaded in the conversation: only these citations are links. */
  readonly loadedMessageIds: ReadonlySet<string>;
  readonly onClose: () => void;
  readonly onCancel: () => void;
  readonly onRegenerate: () => void;
  readonly onNotUseful: () => void;
  readonly onDraftReply: () => void;
  readonly onBackToSummary: () => void;
  readonly onJump: (messageId: string) => void;
  /** Puts text in the composer. Called only from a click in this panel. */
  readonly onCopyToDraft: (text: string) => void;
  /** The text last copied, so the panel can say so politely. */
  readonly copiedText: string | null;
  /** False for an archived conversation: a draft reply is offered only where the person could post anyway. */
  readonly canDraft: boolean;
}

/** The summary as lines for the composer: the points, then what is unclear. Plain text. */
export function summaryAsDraftText(data: MessagingAiSummaryDto): string {
  const lines = data.points.map((p) => `- ${p.text}`);
  if (data.open_questions.length > 0) {
    lines.push(`${AI_UNCERTAINTY_LEAD} ${data.open_questions.join(" ")}`);
  }
  return lines.join("\n");
}

export function AiSummaryPanel(props: AiSummaryPanelProps): JSX.Element {
  const { view } = props;
  const closeRef = useRef<HTMLButtonElement>(null);
  // Opened by a click, so it takes focus; Escape closes it and the opener gets focus back.
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <aside
      className="wx-ai-panel"
      aria-label="AI summary"
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
      }}
    >
      <header>
        <h2 className="wx-ai-title">
          {view.phase === "drafts" ? AI_DRAFTS_TITLE : AI_PANEL_TITLE}
        </h2>
        <button ref={closeRef} type="button" onClick={props.onClose} aria-label="Close AI summary">
          <Glyph name="close" size={17} />
        </button>
      </header>
      <p className="wx-ai-guardrail">{AI_GUARDRAIL}</p>
      <div className="wx-ai-body">
        {view.phase === "generating" ? (
          <div className="wx-ai-generating">
            <p>
              <Glyph name="spinner" size={14} /> {AI_GENERATING}
            </p>
            <button type="button" onClick={props.onCancel}>
              {AI_CANCEL}
            </button>
          </div>
        ) : null}
        {view.phase === "problem" ? (
          <output className="wx-ai-problem">
            <Glyph name="info" size={14} /> {PROBLEM_TEXT[view.problem]}
          </output>
        ) : null}
        {view.phase === "summary" ? <SummaryBody {...props} data={view.data} /> : null}
        {view.phase === "drafts" ? (
          <DraftsBody
            {...props}
            drafts={view.data.drafts.map((d) => d.text)}
            included={view.data.included_count}
            withheld={view.data.withheld_count}
          />
        ) : null}
      </div>
    </aside>
  );
}

function Footer(props: { included: number; withheld: number }): JSX.Element {
  return (
    <p className="wx-ai-footer">
      {basedOn(props.included)}
      {props.withheld > 0 ? ` · ${notIncluded(props.withheld)}` : ""}
    </p>
  );
}

function SummaryBody(props: AiSummaryPanelProps & { data: MessagingAiSummaryDto }): JSX.Element {
  const { data } = props;
  if (data.status === "insufficient_context") {
    return (
      <>
        <output>{AI_TOO_LITTLE}</output>
        <Footer included={data.included_count} withheld={data.withheld_count} />
      </>
    );
  }
  const copyText = summaryAsDraftText(data);
  return (
    <>
      <ul className="wx-ai-points">
        {data.points.map((point) => (
          <li key={`${point.text}|${point.sources.map((s) => s.message_id).join(",")}`}>
            <span>{point.text}</span>{" "}
            <span className="wx-ai-confidence">({CONFIDENCE_TEXT[point.confidence]})</span>{" "}
            {point.sources.map((source) =>
              props.loadedMessageIds.has(source.message_id) ? (
                <button
                  key={source.message_id}
                  type="button"
                  className="wx-ai-cite"
                  aria-label={`[${source.n}] source message`}
                  onClick={() => props.onJump(source.message_id)}
                >
                  [{source.n}]
                </button>
              ) : (
                <span key={source.message_id} className="wx-ai-cite-plain">
                  [{source.n}]
                </span>
              ),
            )}
          </li>
        ))}
      </ul>
      <p className="wx-ai-uncertainty">
        <Glyph name="alert" size={14} />{" "}
        {data.open_questions.length > 0
          ? `${AI_UNCERTAINTY_LEAD} ${data.open_questions.join(" ")}`
          : AI_NO_OPEN_QUESTIONS}
      </p>
      <p className="wx-ai-note">{AI_NOT_A_SUBSTITUTE}</p>
      <div className="wx-ai-actions">
        {props.canDraft ? (
          <>
            <button type="button" onClick={() => props.onCopyToDraft(copyText)}>
              {AI_COPY_TO_DRAFT}
            </button>
            <button type="button" onClick={props.onDraftReply}>
              {AI_DRAFT_REPLY}
            </button>
          </>
        ) : null}
        <button type="button" onClick={props.onRegenerate}>
          {AI_REGENERATE}
        </button>
        <button type="button" onClick={props.onNotUseful}>
          {AI_NOT_USEFUL}
        </button>
      </div>
      {props.copiedText === copyText ? <output>{AI_COPIED}</output> : null}
      <Footer included={data.included_count} withheld={data.withheld_count} />
    </>
  );
}

function DraftsBody(
  props: AiSummaryPanelProps & { drafts: readonly string[]; included: number; withheld: number },
): JSX.Element {
  return (
    <>
      <ol className="wx-ai-drafts">
        {props.drafts.map((text, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static list of at most two drafts, identical texts are possible
          <li key={`${index}|${text}`}>
            <p>{text}</p>
            {props.canDraft ? (
              <button type="button" onClick={() => props.onCopyToDraft(text)}>
                {AI_COPY_TO_DRAFT}
                <span className="wx-visually-hidden"> {index + 1}</span>
              </button>
            ) : null}
            {props.copiedText === text ? <output> {AI_COPIED}</output> : null}
          </li>
        ))}
      </ol>
      <div className="wx-ai-actions">
        <button type="button" onClick={props.onBackToSummary}>
          {AI_BACK_TO_SUMMARY}
        </button>
        <button type="button" onClick={props.onNotUseful}>
          {AI_NOT_USEFUL}
        </button>
      </div>
      <Footer included={props.included} withheld={props.withheld} />
    </>
  );
}
