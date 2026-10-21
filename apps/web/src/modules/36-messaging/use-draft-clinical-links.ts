import { RICH_BODY_LIMITS } from "@chartwarden/types";
import { useCallback, useState } from "react";
import type { DraftClinicalLink } from "./clinical-link-kinds";

export const MAX_DRAFT_CLINICAL_LINKS = RICH_BODY_LIMITS.maxClinicalLinks;

const sameRecord = (a: DraftClinicalLink, b: DraftClinicalLink): boolean =>
  a.kind === b.kind && a.entityId === b.entityId;

/** The links attached to the message being composed. Immutable updates; the 10-link cap and de-duplication live here. */
export function useDraftClinicalLinks() {
  const [links, setLinks] = useState<readonly DraftClinicalLink[]>([]);
  const add = useCallback((link: DraftClinicalLink): void => {
    setLinks((current) =>
      current.length >= MAX_DRAFT_CLINICAL_LINKS || current.some((c) => sameRecord(c, link))
        ? current
        : [...current, link],
    );
  }, []);
  const remove = useCallback((link: DraftClinicalLink): void => {
    setLinks((current) => current.filter((c) => !sameRecord(c, link)));
  }, []);
  const clear = useCallback((): void => setLinks([]), []);
  return { links, add, remove, clear };
}
