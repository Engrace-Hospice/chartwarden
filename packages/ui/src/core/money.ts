// @chartwarden/ui core — money and counts typed by an operator, parsed by string math. A float multiply rounds "1.005" and "0.145"
// the wrong way, and `Number()` takes "1e3", "0x1f" and "0b11": none of those is a price an operator meant. Shared by the platform
// console's modules (which may not import each other).

/** Plain digits with at most two decimals: no sign, exponent, hex or binary. */
const DECIMAL_SHAPE = /^\d+(\.\d{1,2})?$/;
/** Plain digits: no sign, decimal point, exponent, hex or binary. */
const WHOLE_SHAPE = /^\d+$/;

/**
 * A typed decimal ("49", "4.5", "19.99") to a whole count of hundredths; null for anything else, more than two decimals included,
 * or above `max`.
 */
export function parseHundredths(raw: string, max: number = Number.MAX_SAFE_INTEGER): number | null {
  const text = raw.trim();
  if (!DECIMAL_SHAPE.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(value) && value <= max ? value : null;
}

/** Dollars to integer cents; null unless 0 or more with at most two decimals ("abc" is not $0). */
export const parsePriceCents = (raw: string, maxCents?: number): number | null =>
  parseHundredths(raw, maxCents);

/** A whole number 0 or more (days, a quantity, a whole percentage); null for anything else, or above `max`. */
export function parseWholeNumber(
  raw: string,
  max: number = Number.MAX_SAFE_INTEGER,
): number | null {
  const text = raw.trim();
  if (!WHOLE_SHAPE.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value <= max ? value : null;
}

/** Hundredths back to the text an operator types ("4900" -> "49", "250" -> "2.50"), without a float divide. */
export function hundredthsText(value: number | null): string {
  if (value === null) return "";
  const fraction = String(value % 100).padStart(2, "0");
  const whole = String(Math.trunc(value / 100));
  return fraction === "00" ? whole : `${whole}.${fraction}`;
}
