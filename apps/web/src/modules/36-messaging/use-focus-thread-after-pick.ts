import { type RefObject, useCallback, useEffect, useRef } from "react";

interface Options {
  activeId: string | null;
  narrow: boolean;
  headingRef: RefObject<HTMLHeadingElement>;
  setActiveId: (id: string | null) => void;
}

/**
 * Picking a row on a narrow screen unmounts the list that held focus: hand it to the thread heading instead.
 * The pending pick is tracked by id and consumed by the first activeId change after it, so wide layouts, deep links,
 * realtime refreshes and re-picks of the open conversation can never steal focus later.
 */
export function useFocusThreadAfterPick({
  activeId,
  narrow,
  headingRef,
  setActiveId,
}: Options): (id: string | null) => void {
  const pickedId = useRef<string | null>(null);
  useEffect(() => {
    const picked = pickedId.current;
    if (picked === null) return;
    pickedId.current = null;
    if (activeId === picked) headingRef.current?.focus();
  }, [activeId, headingRef]);
  return useCallback(
    (id: string | null): void => {
      pickedId.current = narrow && id !== null && id !== activeId ? id : null;
      setActiveId(id);
    },
    [narrow, activeId, setActiveId],
  );
}
