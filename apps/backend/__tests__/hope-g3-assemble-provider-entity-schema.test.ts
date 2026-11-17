// apps/backend/__tests__/hope-g3-assemble-provider-entity-schema.test.ts — POST /hope/submissions/assemble takes its provider
// entity as a uuid. The id reaches a `provider_entity_id = $1::uuid` predicate (and the m10:assemble advisory key), so a
// value that is no uuid used to be a 500 (22P02) for an org-wide caller; it is now the 422 the validation envelope carries.
// (backend-code-k8, class: missing input validation.)
import { ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { AssembleSubmissionSchema, parse } from "../src/modules/10-hope/routes/hope-typebox";

const PROVIDER_ENTITY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("AssembleSubmissionSchema.providerEntityId", () => {
  it.each([
    ["lower case", PROVIDER_ENTITY],
    ["upper case", PROVIDER_ENTITY.toUpperCase()],
  ])("accepts a uuid in %s (the service reads it canonically)", (_label, providerEntityId) => {
    expect(parse(AssembleSubmissionSchema, { providerEntityId })).toEqual({ providerEntityId });
  });

  it.each([
    ["free text", "pe_1"],
    ["a CCN-looking number", "123456"],
    ["an empty string", ""],
    ["a uuid with trailing text", `${PROVIDER_ENTITY} x`],
  ])(
    "refuses %s with the validation envelope, before any database cast",
    (_label, providerEntityId) => {
      expect(() => parse(AssembleSubmissionSchema, { providerEntityId })).toThrow(ValidationError);
    },
  );

  it("refuses a body without it", () => {
    expect(() => parse(AssembleSubmissionSchema, {})).toThrow(ValidationError);
  });
});
