// Shared test vectors for the two MBI note screens (this file is kept byte-identical in packages/billing/__tests__ and
// apps/web/src/modules/23-billing-medicare/__tests__; a billing test fails if they differ): the server's `looksLikeMbi` (@wardenx/billing) and its web mirror
// (`apps/web/.../dde-queue-model.ts`). One table, so the two cannot diverge silently. Test data only: these are the
// CMS format example shapes, not real identifiers.

/** Must be flagged: each hides an MBI-shaped value behind formatting, a lookalike letter, or an accent. */
export const MBI_HIDDEN: readonly (readonly [string, string])[] = [
  ["dashes", "1EG4-TE5-MK73"],
  ["spaces", "1EG4 TE5 MK73"],
  ["a glued prefix", "ID1EG4-TE5-MK73"],
  ["a glued suffix", "1EG4TE5MK73XYZ"],
  ["doubled spaces", "1EG4  TE5   MK73"],
  ["tabs", "1EG4\tTE5\tMK73"],
  ["NBSP", "1EG4\u00a0TE5\u00a0MK73"],
  ["dots", "1.E.G.4.T.E.5.M.K.7.3"],
  ["full-width digits", "\uff11EG\uff14TE\uff15MK\uff17\uff13"],
  ["zero-width characters", "1EG4\u200bTE5\u200bMK73"],
  ["a Cyrillic E", "1\u0415G4-TE5-MK73"],
  ["a Greek K", "1EG4-TE5-M\u039a73"],
  ["a Cyrillic E and a Greek K together", "1\u0415G4 TE5 M\u039a73"],
  ["a precomposed accented letter", "1\u00c9G4TE5MK73"],
  ["a combining accent", "1E\u0301G4TE5MK73"],
  ["an Arabic-Indic digit", "1EG4TE5MK\u0667\u0663"],
];

/** Must NOT be flagged: ordinary notes, including non-Latin and accented prose. */
export const MBI_CLEAN: readonly string[] = [
  "called MAC 05/12, ref 4471, waiting on receipt",
  "\u041f\u043e\u0437\u0432\u043e\u043d\u0438\u0442\u044c \u0432 \u043e\u0444\u0438\u0441 12 \u0440\u0430\u0437",
  "Appel \u00e0 l'h\u00f4pital, r\u00e9f 4471 en attente",
  "DCN 22123456789012345",
  "NPI 1234567890",
];

/**
 * KNOWN, ACCEPTED GAP: a non-ASCII LETTER standing in for a DIGIT (Cyrillic Ze for 3, Che for 4) is a letter wildcard
 * at a digit position and does not match. Allowing it would flag ordinary non-Latin prose. Pinned so the behaviour is
 * deliberate and visible; if the screen is ever tightened, this vector moves to MBI_HIDDEN.
 */
export const MBI_DIGIT_LOOKALIKE_GAP: readonly string[] = [
  "1EG4-TE5-MK7\u0417",
  "1EG\u0427-TE5-MK73",
];
