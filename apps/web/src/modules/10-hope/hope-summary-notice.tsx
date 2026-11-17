// apps/web/src/modules/10-hope — what the assessment screen says about a "Request summary" press: that it was accepted, or why it was
// not (or that nobody could tell). The button that was pressed is disabled while the request is out, and stays disabled once it was
// accepted, which drops keyboard focus to the document in Firefox and Safari: these words take it (`useHopeRecordActions` owns the ref).
import type { JSX, RefObject } from "react";

export interface SummaryNotice {
  readonly text: string;
  /** A failure (an alert, in the error colour) as opposed to the request having been accepted (a status). */
  readonly failed: boolean;
}

export function SummaryRequestNotice(props: {
  readonly notice: SummaryNotice | null;
  readonly noticeRef: RefObject<HTMLParagraphElement>;
}): JSX.Element | null {
  const { notice, noticeRef } = props;
  if (notice === null) return null;
  return (
    <p
      ref={noticeRef}
      tabIndex={-1}
      role={notice.failed ? "alert" : "status"}
      className={notice.failed ? "wx-hope-action-error" : undefined}
      style={notice.failed ? undefined : { color: "var(--color-success-pill-fg)", fontWeight: 600 }}
    >
      {notice.text}
    </p>
  );
}
