import { Glyph, StatusPill } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { ReviewExceptionSummary, ReviewExceptionTask } from "./review-exception-tasks";

const NO_TASKS: ReadonlySet<string> = new Set();

export function ReviewExceptionPanel({
  summary,
  selectedTaskIds = NO_TASKS,
  expandSelected = false,
  onSelect,
}: {
  summary: ReviewExceptionSummary;
  /** The tasks whose work is open in the task column; their rows are marked as current. */
  selectedTaskIds?: ReadonlySet<string>;
  /** Open the categories holding those rows (a restored or deliberately opened task), not for the default one. */
  expandSelected?: boolean;
  onSelect: (task: ReviewExceptionTask) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const selectedCategoryKey = expandSelected
    ? summary.categories
        .filter((category) => category.tasks.some((task) => selectedTaskIds.has(task.id)))
        .map((category) => category.id)
        .join("|")
    : "";
  useEffect(() => {
    if (!selectedCategoryKey) return;
    setExpanded((current) => new Set([...current, ...selectedCategoryKey.split("|")]));
  }, [selectedCategoryKey]);

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
                            onClick={() => onSelect(task)}
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
