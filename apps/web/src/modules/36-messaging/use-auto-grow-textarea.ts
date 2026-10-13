// The composer textarea grows with its content up to its CSS max-height, then scrolls. Recalculated after every
// controlled-value change, including selection and send/reset. Moved out of ConversationThread unchanged.
import { useLayoutEffect } from "react";
import type { RefObject } from "react";

export function useAutoGrowTextarea(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger: the height follows the text.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maximum = Number.parseFloat(window.getComputedStyle(textarea).maxHeight);
    const nextHeight = Number.isFinite(maximum)
      ? Math.min(textarea.scrollHeight, maximum)
      : textarea.scrollHeight;
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      Number.isFinite(maximum) && textarea.scrollHeight > maximum ? "auto" : "hidden";
  }, [textareaRef, value]);
}
