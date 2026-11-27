// apps/backend/src/modules/10-hope/hope-plain-text.ts — the two character rules every M10 operator-typed REASON shares: the late-deadline
// override's justification (routes/hope-route-guards.ts) and the signer-licence shadow reason (hope-signer-licence-policy.ts). Both are
// stored verbatim in an immutable audit event, as the only record of why a compliance control was lifted or lowered, so each must be real,
// readable text. One definition here, so the two cannot drift; neither route nor service imports the other.

/** A run of Unicode White_Space: one space for a length minimum. The web client's counter must collapse the same runs. */
export const WHITE_SPACE_RUN = /\p{White_Space}+/gu;

/**
 * Characters a reason may not contain: control characters (`\p{Cc}`: NUL, escapes, NEL...) EXCEPT tab, line feed and carriage return (a
 * multi-line reason is normal), format characters (`\p{Cf}`: zero-width space / joiner, bidi marks, soft hyphen, BOM...) and a surrogate
 * that has no partner (not text at all). Twenty zero-width characters would otherwise pass the length minimum as an invisible "reason",
 * and a NUL or a lone surrogate cannot be stored in the audit event's jsonb (22P05), which would turn this 422 into a 500. REJECTED,
 * never stripped: silently removing characters would store a different text from the one the operator typed and measured the minimum on.
 * Not screened: other blank-looking glyphs (Hangul fillers, the Braille blank); the text is attributable to a named operator and still
 * goes through the patient-identifier screen (which sees SSN- and MBI-shaped values only: it is not a promise that no name is typed).
 */
export const FORBIDDEN_REASON_CHARACTER =
  /(?![\t\n\r])[\p{Cc}\p{Cf}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
