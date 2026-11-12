// apps/backend/src/modules/23-billing-medicare/routes/mac-credential-body.ts — parse a MAC credential upsert body, for the tenant route and
// the operator lane's port alike.
//
// `UpsertMacCredentialBodySchema` already refuses a separator-formed SSN shape in the submitter, trading-partner and client ids (its
// `pattern`), but TypeBox's own message for a failed pattern is the regular expression, which is no message for a person. So the shape is
// checked first, on the NFKC-normalised text, and refused as a person's 422 EVIDENCE_LOOKS_LIKE_PHI naming the field and never echoing
// the value; everything else goes through the schema as before.
import { parse } from "@chartwarden/shared/route-kit";
import { ValidationError } from "@chartwarden/types";
import { MAC_IDENTIFIER_SSN_SHAPE, UpsertMacCredentialBodySchema } from "./billing-typebox";

const IDENTIFIER_FIELDS = ["submitterId", "tradingPartnerId", "clientId"] as const;
const SSN_SHAPE = new RegExp(MAC_IDENTIFIER_SSN_SHAPE);

export function parseMacCredentialBody(raw: unknown): ReturnType<typeof parseBody> {
  if (raw !== null && typeof raw === "object") {
    for (const field of IDENTIFIER_FIELDS) {
      const value = (raw as Record<string, unknown>)[field];
      if (typeof value === "string" && SSN_SHAPE.test(value.normalize("NFKC"))) {
        throw new ValidationError("request validation failed", [
          {
            field,
            code: "EVIDENCE_LOOKS_LIKE_PHI",
            message: `${field} looks like a social security number; enter the identifier the MAC issued, never a person's number`,
          },
        ]);
      }
    }
  }
  return parseBody(raw);
}

const parseBody = (raw: unknown) => parse(UpsertMacCredentialBodySchema, raw);
