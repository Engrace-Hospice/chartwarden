import { randomInt } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Generate a clearinghouse-facing 17-character PCN; DB uniqueness handles the vanishingly rare collision. */
export function generateExternalPatientControlNumber(): string {
  let value = "";
  for (let index = 0; index < 17; index += 1) value += ALPHABET[randomInt(ALPHABET.length)];
  return value;
}
