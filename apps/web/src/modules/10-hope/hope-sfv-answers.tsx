// apps/web/src/modules/10-hope — the J2053 reassessment questions of the SFV completion dialog: one question at a
// time with a step bar, or "Show all" (the same preference the workspace uses).
import type { JSX, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  secondaryButton,
  sfvAnswerNumber,
  sfvProgressBadge,
  sfvProgressTrack,
  sfvProgressValue,
  sfvQuestionText,
  sfvSection,
  sfvSectionDescription,
  sfvSectionHeader,
  sfvSectionTitle,
  srOnly,
} from "./hope-dialog-styles";
import { readNavMode } from "./hope-nav-storage";
import type { SfvDialogItem } from "./hope-sfv-form";
import { CmsCode } from "./hope-workspace-ui";

interface SfvChoice {
  readonly value: string;
  readonly label: string;
}

/**
 * CMS J2053A-H as HOPE v1.00.1 defines them (`itm_val`): how far a symptom affects the patient, and 9 for a symptom the patient
 * is not experiencing. The server accepts every one, and "None" for a symptom that is absent is a different answer from 9, so
 * 9 has to be offered. Stands in only for an item that carries no options of its own.
 */
const J2053_CHOICES: readonly SfvChoice[] = [
  { value: "0", label: "Not at all" },
  { value: "1", label: "Slight" },
  { value: "2", label: "Moderate" },
  { value: "3", label: "Severe" },
  { value: "9", label: "Not applicable" },
];

/** CMS's blank for a skipped item (skip pattern): the form's own to record, never a clinician's answer. */
const SKIP_PATTERN_BLANK = "^";

/** The choices for one question: the workspace item's own CMS options in their order, else the J2053 set. */
export function choicesFor(item: SfvDialogItem): readonly SfvChoice[] {
  const own = [...(item.options ?? [])]
    .filter((option) => option.valueCode !== SKIP_PATTERN_BLANK)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((option) => ({ value: option.valueCode, label: option.label }));
  return own.length > 0 ? own : J2053_CHOICES;
}

/** How long a chosen answer stays on screen before the guided mode moves to the next question. */
const STEP_PAUSE_MS = 250;

const NO_QUESTIONS_MESSAGE = "No reassessment questions are available for this record.";

interface SfvAnswersSectionProps {
  readonly questions: readonly SfvDialogItem[];
  readonly answers: Readonly<Record<string, string>>;
  readonly answeredCount: number;
  readonly onAnswer: (itemCode: string, value: string) => void;
  readonly disabled: boolean;
}

/**
 * Guided mode's current question. A manual step (Next, Previous, the step bar) cancels a pending automatic move, so a
 * late timer can never pull the clinician back; the timer is also dropped when the section goes away.
 */
function useGuidedSteps(count: number) {
  const [step, setStep] = useState(0);
  const timer = useRef<number | null>(null);
  const cancelPending = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancelPending, [cancelPending]);

  const goTo = useCallback(
    (next: number) => {
      cancelPending();
      setStep(Math.min(Math.max(0, next), count - 1));
    },
    [cancelPending, count],
  );
  /** After an answer: a brief pause so the choice is seen, then move to the next question. */
  const advanceFrom = useCallback(
    (index: number) => {
      cancelPending();
      if (index >= count - 1) return;
      timer.current = window.setTimeout(() => setStep(index + 1), STEP_PAUSE_MS);
    },
    [cancelPending, count],
  );
  return { step, goTo, advanceFrom, cancelPending };
}

/**
 * Guided mode replaces the question fieldset, which takes the focused radio with it: put focus on the new question
 * instead of letting it fall to the page (and the next Tab on to the first field). A step the clinician took with a
 * button leaves focus on that button.
 *
 * An unanswered question takes focus on its fieldset (named by its legend, so a screen reader says the question), NOT on its
 * first radio: Enter chooses the radio it is pressed on, so landing on the first choice would let a clinician who is pressing Enter
 * to get through the form record the first answer for every symptom without ever choosing one. Tab then enters the choices. An
 * answered question lands on the answer already chosen.
 */
function useFocusNewQuestion(step: number) {
  const listRef = useRef<HTMLDivElement>(null);
  const seenStep = useRef(step);
  // The step focus was moved to, so the live region can stay quiet about it: focus already says it.
  const [focusedStep, setFocusedStep] = useState<number | null>(null);
  useEffect(() => {
    if (seenStep.current === step) return;
    seenStep.current = step;
    const active = document.activeElement;
    if (active && active !== document.body && !listRef.current?.contains(active)) {
      // A button took the step, so focus stays there and the region must say the new question: forget the earlier move,
      // or revisiting that question (Previous, then Next) would be silent while focus sits on the button.
      setFocusedStep(null);
      return;
    }
    const target =
      listRef.current?.querySelector<HTMLElement>("input[type=radio]:checked") ??
      listRef.current?.querySelector<HTMLElement>("fieldset");
    target?.focus();
    // Quiet only if focus really arrived (a disabled fieldset, while saving, cannot take it).
    setFocusedStep(target && document.activeElement === target ? step : null);
  }, [step]);
  return { listRef, focusMovedHere: focusedStep === step };
}

function ProgressBar({ fraction }: { fraction: number }): JSX.Element {
  return (
    <div style={sfvProgressTrack}>
      <div style={{ ...sfvProgressValue, width: `${fraction * 100}%` }} />
    </div>
  );
}

export function SfvAnswersSection(props: SfvAnswersSectionProps): JSX.Element {
  const { questions, answeredCount } = props;
  // Local to the dialog: it starts from the workspace's preference but never rewrites it.
  const [showAll, setShowAll] = useState(() => readNavMode() === "all");
  const { step, goTo, advanceFrom, cancelPending } = useGuidedSteps(questions.length);
  const { listRef, focusMovedHere } = useFocusNewQuestion(step);

  return (
    <section style={sfvSection}>
      <AnswersHeader count={questions.length} answered={answeredCount} />
      {questions.length === 0 ? (
        <p style={sfvSectionDescription}>{NO_QUESTIONS_MESSAGE}</p>
      ) : (
        <>
          <ProgressBar fraction={answeredCount / questions.length} />
          <QuestionToolbar
            questions={questions}
            answers={props.answers}
            showAll={showAll}
            step={step}
            onStep={goTo}
            onShowAll={(next) => {
              cancelPending();
              setShowAll(next);
            }}
          />
          <QuestionList
            listRef={listRef}
            questions={questions}
            answers={props.answers}
            showAll={showAll}
            step={step}
            disabled={props.disabled}
            onAnswer={(itemCode, value, index, advance) => {
              props.onAnswer(itemCode, value);
              if (!showAll && advance) advanceFrom(index);
            }}
          />
          {showAll ? null : (
            <StepNav questions={questions} step={step} onStep={goTo} quiet={focusMovedHere} />
          )}
        </>
      )}
    </section>
  );
}

function AnswersHeader(props: { count: number; answered: number }): JSX.Element {
  return (
    <div style={sfvSectionHeader}>
      <div>
        <h3 style={sfvSectionTitle}>Symptom impact reassessment</h3>
        <p style={sfvSectionDescription}>
          Complete each required J2053 item based on the follow-up visit.
        </p>
      </div>
      {props.count > 0 ? (
        <span style={sfvProgressBadge}>
          {props.answered}/{props.count} completed
        </span>
      ) : null}
    </div>
  );
}

function QuestionToolbar(props: {
  questions: readonly SfvDialogItem[];
  answers: Readonly<Record<string, string>>;
  showAll: boolean;
  step: number;
  onStep: (step: number) => void;
  onShowAll: (showAll: boolean) => void;
}): JSX.Element {
  return (
    <div className="wx-sfv-toolbar">
      {!props.showAll ? (
        <ol className="wx-sfv-steps" aria-label="Reassessment questions">
          {props.questions.map((item, index) => {
            const done = Boolean(props.answers[item.itemCode]);
            const isActive = index === props.step;
            return (
              <li key={item.itemCode}>
                <button
                  type="button"
                  className={isActive ? "active" : done ? "done" : undefined}
                  aria-current={isActive ? "step" : undefined}
                  aria-label={`${item.itemCode}${done ? " — answered" : ""}`}
                  onClick={() => props.onStep(index)}
                >
                  {done && !isActive ? "✓" : index + 1}
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <span />
      )}
      <label className="wx-hope-mode-toggle">
        <input
          type="checkbox"
          checked={props.showAll}
          onChange={(event) => props.onShowAll(event.currentTarget.checked)}
        />
        <span className="wx-hope-mode-track" aria-hidden />
        Show all
      </label>
    </div>
  );
}

function QuestionList(props: {
  listRef: RefObject<HTMLDivElement>;
  questions: readonly SfvDialogItem[];
  answers: Readonly<Record<string, string>>;
  showAll: boolean;
  step: number;
  disabled: boolean;
  /** `advance`: whether this answer should move guided mode on (a choice made, not an arrow key passing over one). */
  onAnswer: (itemCode: string, value: string, index: number, advance: boolean) => void;
}): JSX.Element {
  // An arrow key moves through a radio group and selects as it goes: that is browsing the choices, not choosing one,
  // so it must not carry the clinician on to the next question (WCAG 3.2.2). A click, Space or Enter is a choice.
  const viaArrow = useRef(false);
  const current = props.questions[props.step];
  const visible = props.showAll
    ? props.questions.map((item, index) => ({ item, index }))
    : current
      ? [{ item: current, index: props.step }]
      : [];
  return (
    <div
      ref={props.listRef}
      className={props.showAll ? "wx-sfv-questions all" : "wx-sfv-questions"}
    >
      {visible.map(({ item, index }) => {
        const value = props.answers[item.itemCode] ?? "";
        return (
          <fieldset
            key={item.itemCode}
            tabIndex={-1}
            className={value ? "wx-sfv-question answered" : "wx-sfv-question"}
            disabled={props.disabled}
          >
            <legend>
              <span style={sfvAnswerNumber}>{index + 1}</span>
              <strong style={sfvQuestionText}>{item.label}</strong>
              <CmsCode code={item.itemCode} />
            </legend>
            <div className="wx-sfv-severity">
              {choicesFor(item).map((option) => (
                <label
                  key={option.value}
                  className={value === option.value ? "wx-option-row checked" : "wx-option-row"}
                >
                  <input
                    type="radio"
                    name={`sfv-${item.itemCode}`}
                    value={option.value}
                    checked={value === option.value}
                    onPointerDown={() => {
                      viaArrow.current = false;
                    }}
                    onKeyDown={(event) => {
                      if (event.key.startsWith("Arrow")) viaArrow.current = true;
                      else if (event.key === "Enter") {
                        event.preventDefault();
                        props.onAnswer(item.itemCode, option.value, index, true);
                      }
                    }}
                    onKeyUp={() => {
                      viaArrow.current = false;
                    }}
                    onChange={() => {
                      const arrow = viaArrow.current;
                      viaArrow.current = false;
                      props.onAnswer(item.itemCode, option.value, index, !arrow);
                    }}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

function StepNav(props: {
  questions: readonly SfvDialogItem[];
  step: number;
  onStep: (step: number) => void;
  /** Focus moved to the new question, which announces it: the live region says nothing, so it is not said twice. */
  quiet: boolean;
}): JSX.Element {
  const count = props.questions.length;
  return (
    <div className="wx-sfv-stepnav">
      <button
        type="button"
        style={secondaryButton}
        disabled={props.step === 0}
        onClick={() => props.onStep(props.step - 1)}
      >
        ← Previous question
      </button>
      <span>
        Question {props.step + 1} of {count}
      </span>
      {/* One live region that stays mounted, so a step is announced when its text changes (a new region would say nothing). */}
      <output style={srOnly}>
        {props.quiet
          ? ""
          : `Question ${props.step + 1} of ${count}: ${props.questions[props.step]?.label}`}
      </output>
      <button
        type="button"
        style={secondaryButton}
        disabled={props.step >= count - 1}
        onClick={() => props.onStep(props.step + 1)}
      >
        Next question →
      </button>
    </div>
  );
}
