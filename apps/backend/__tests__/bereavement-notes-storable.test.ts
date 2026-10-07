// apps/backend/__tests__/bereavement-notes-storable.test.ts — GAP-129 (M16): a counselor note is refused (503), never
// silently discarded, while the `contact_notes_cipher` column has no bound M34 cipher port to write ciphertext into.
import { describe, expect, it } from "vitest";
import {
  NOTES_STORAGE_UNAVAILABLE,
  assertNotesStorable,
} from "../src/modules/16-bereavement/routes/write-service-drizzle";

describe("assertNotesStorable", () => {
  it("refuses a request that carries a note with a 503", () => {
    expect(() => assertNotesStorable("spoke with the daughter")).toThrow(
      expect.objectContaining({ code: NOTES_STORAGE_UNAVAILABLE, statusCode: 503 }),
    );
  });

  it("allows a request with no note (absent, null or blank)", () => {
    expect(() => assertNotesStorable(undefined)).not.toThrow();
    expect(() => assertNotesStorable(null)).not.toThrow();
    expect(() => assertNotesStorable("   ")).not.toThrow();
  });
});
