// apps/backend/src/modules/29-external-interfaces/nppes — NPI Luhn-mod-10 validator (M29-T07, §2.1 / D10).
// PURE. An NPI is 10 digits whose last digit is a Luhn check digit computed over the ISO-6523 prefix
// "80840" ++ the first 9 digits (the CMS algorithm). The nightly sync validates every candidate NPI before
// spending an API call on it — a Luhn-invalid NPI in a tenant's `external_physician` is a data-entry error
// NPPES would 200-with-no-result for, so we short-circuit it as `invalid_format` (see response-projection).

/** True iff `npi` is a 10-digit string whose Luhn check digit is correct (the CMS NPI check algorithm). */
export function isValidNpi(npi: string): boolean {
  if (typeof npi !== "string") return false;
  if (!/^\d{10}$/.test(npi)) return false;

  const prefixed = "80840" + npi.slice(0, 9);
  const expectedCheck = Number.parseInt(npi.charAt(9), 10);
  return luhnCheckDigit(prefixed) === expectedCheck;
}

/** The Luhn mod-10 check digit for a digit string (doubling starts at the rightmost digit). */
function luhnCheckDigit(input: string): number {
  let sum = 0;
  let doubleNext = true;
  for (let i = input.length - 1; i >= 0; i--) {
    let digit = Number.parseInt(input.charAt(i), 10);
    if (doubleNext) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleNext = !doubleNext;
  }
  const mod = sum % 10;
  return mod === 0 ? 0 : 10 - mod;
}
