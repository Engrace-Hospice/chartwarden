// apps/web/src/modules/08-encounters/workspace — a link to `#visit-review` or `#visit-complete` on another screen (the composer's "go to
// sign-off", a copied address) lands on the right place once the screen has what it shows. The router does not scroll to a hash.
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { COMPLETE_ANCHOR_ID, REVIEW_ANCHOR_ID, jumpToAnchor } from "./jump-to-anchor";

const WORKFLOW_ANCHORS: ReadonlySet<string> = new Set([REVIEW_ANCHOR_ID, COMPLETE_ANCHOR_ID]);

/**
 * `ready`: the screen has rendered what the anchors name (not its spinner). Other hashes are left to their own screens.
 * It lands once per arrival (per navigation, which the router gives its own `key`): the record reads the encounter again after a save or a
 * sign and is "not ready" while it does, but the hash is still in the address and the user has moved on.
 */
export function useHashAnchor(ready: boolean): void {
  const { hash, key } = useLocation();
  const landedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || landedFor.current === key) return;
    const id = hash.slice(1);
    if (!WORKFLOW_ANCHORS.has(id)) return;
    // Not marked when the anchor is not on this page (yet): a later ready render tries again.
    if (jumpToAnchor(id)) landedFor.current = key;
  }, [ready, hash, key]);
}
