import { Glyph, StatusPill } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { ReviewExceptionSummary, ReviewExceptionTask } from "./review-exception-tasks";

const NO_TASKS: ReadonlySet<string> = new Set();

export function ReviewExceptionPanel({
  summary,
  selectedTaskIds = NO_TASKS,
  revealVersion = 0,
  disabled = false,
  onSelect,
}: {
  summary: ReviewExceptionSummary;
  /** The tasks whose work is open in the task column; their rows are marked as current. */
  selectedTaskIds?: ReadonlySet<string>;
  /**
   * Counts the times a task was chosen or restored (0: only the default task is open). Each new value opens
   * the categories holding the open task's rows again, even after the reviewer collapsed them.
   */
  revealVersion?: number;
  /** True while a decision is being saved: the rows that switch task wait. */
  disabled?: boolean;
  /** `trigger` is the row that was chosen, so the caller can return focus to it. */
  onSelect: (task: ReviewExceptionTask, trigger: HTMLElement) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const revealedVersion = useRef(0);
  useEffect(() => {
    if (revealVersion === 0 || revealVersion === revealedVersion.current) return;
    revealedVersion.current = revealVersion;
    const holding = summary.categories
      .filter((category) => category.tasks.some((task) => selectedTaskIds.has(task.id)))
      .map((category) => category.id);
    if (holding.length > 0) setExpanded((current) => new Set([...current, ...holding]));
  }, [revealVersion, selectedTaskIds, summary]);

  return (
    <aside className="wx-unified-exceptions" aria-label="Review priorities">
      <header>
        <div>
          <h2>Review priorities</h2>
          <small>
            {summary.underlyingExceptionCount} underlying requirement
            {summary.underlyingExceptionCount === 1 ? "" : "s"} consolidated into{" "}
            {summary.taskCount} task{summary.taskCount === 1 ? "" : "s"}
          </small>
        </div>
        <StatusPill
          label={`${summary.actionableTaskCount} actionable · ${summary.blockedTaskCount} blocked`}
          tone={summary.blockedTaskCount > 0 ? "warning" : "progress"}
        />
      </header>
      {summary.categories.length === 0 ? (
        <p className="wx-unified-empty">
          <Glyph name="check-circle" size={18} /> No projected exceptions.
        </p>
      ) : (
        <div className="wx-unified-exception-categories">
          {summary.categories.map((category) => {
            const open = expanded.has(category.id);
            const panelId = `exception-category-${category.id}`;
            return (
              <section key={category.id}>
                <button
                  type="button"
                  className="wx-unified-exception-category"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (open) next.delete(category.id);
                      else next.add(category.id);
                      return next;
                    })
                  }
                >
                  <span>
                    <strong>{category.label}</strong>
                    <small>
                      {category.tasks.length} task{category.tasks.length === 1 ? "" : "s"} ·{" "}
                      {category.exceptionCount} requirement
                      {category.exceptionCount === 1 ? "" : "s"}
                    </small>
                  </span>
                  <StatusPill
                    label={`${category.actionableCount} ready · ${category.blockedCount} blocked`}
                    tone={category.blockedCount > 0 ? "warning" : "neutral"}
                  />
                  <span className={open ? "wx-unified-chevron is-open" : "wx-unified-chevron"}>
                    <Glyph name="chevron-down" size={17} />
                  </span>
                </button>
                {open ? (
                  <ol id={panelId}>
                    {category.tasks.map((task) => (
                      <li key={task.id}>
                        <div className="wx-unified-exception-task">
                          <button
                            type="button"
                            aria-describedby={`${task.id}-reasons`}
                            aria-current={selectedTaskIds.has(task.id) ? "true" : undefined}
                            disabled={disabled}
                            onClick={(event) => onSelect(task, event.currentTarget)}
                          >
                            <span>
                              <strong>{task.title}</strong>
                              {task.subject ? <small>{task.subject}</small> : null}
                              <small>
                                {task.reasons.length} reason{task.reasons.length === 1 ? "" : "s"}
                              </small>
                            </span>
                            <StatusPill
                              label={task.blocked ? "Blocked" : "Review"}
                              tone={task.blocked ? "warning" : "progress"}
                            />
                            <Glyph name="chevron-right" size={17} />
                          </button>
                          <ul id={`${task.id}-reasons`} aria-label={`Reasons for ${task.title}`}>
                            {task.reasons.map((reason) => (
                              <li key={reason.id}>{reason.detail}</li>
                            ))}
                          </ul>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </aside>
  );
}
