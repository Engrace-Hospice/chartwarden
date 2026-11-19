// apps/web/src/modules/08-encounters — whether the component that started an async write is still on screen when the answer lands.
// A late answer must never navigate, stash a step-up draft or set state for a screen the person already left (the grant drawer closed,
// the policy screen navigated away from): the ref is true from mount until unmount, and read, never rendered, so it costs no render.
import { type RefObject, useEffect, useRef } from "react";

export function useIsMounted(): RefObject<boolean> {
  const mounted = useRef(false);
  useEffect(() => {
    // Set in the effect, not at declaration: a strict-mode remount re-arms it after its first cleanup.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
