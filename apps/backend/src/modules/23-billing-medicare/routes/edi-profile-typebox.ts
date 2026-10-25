// apps/backend/src/modules/23-billing-medicare/routes/edi-profile-typebox.ts — M23 EDI-profile request/response shapes
// (migration 1269). Named `*-typebox` for the same table-ownership-heuristic reason as `billing-typebox.ts`. Limits mirror the
// table's CHECKs. No secret and no beneficiary data; org / membership binding is server-side.
import { type Static, Type } from "@sinclair/typebox";
import { parse } from "./billing-typebox";

const uuid = () => Type.String({ format: "uuid" });
// Non-blank and free of the X12 delimiters (* ~ : ^ | \) the 837I writer cannot carry, so a bad value is refused here
// rather than failing a claim render later.
const X12_SAFE_TEXT = "^(?=.*\\S)[^*~:^|\\\\]+$";
const name = () => Type.String({ minLength: 1, maxLength: 60, pattern: X12_SAFE_TEXT });

/** The CLEARINGHOUSE_VENDOR value the profile applies to (`stedi`, `claim_md`, `direct_mac`, ...). */
export const EdiRouteKeySchema = Type.String({ pattern: "^[a-z][a-z0-9_]{1,31}$" });

export const EdiProfileParamsSchema = Type.Object({
  providerEntityId: uuid(),
  routeKey: EdiRouteKeySchema,
});

export const EdiProfileListParamsSchema = Type.Object({ providerEntityId: uuid() });

export const UpsertEdiProfileBodySchema = Type.Object({
  submitterName: name(),
  submitterId: Type.String({ minLength: 1, maxLength: 80, pattern: X12_SAFE_TEXT }),
  submitterContactName: name(),
  /** 10 digits, no punctuation (the PER segment's contact number). */
  submitterContactPhone: Type.String({ pattern: "^[0-9]{10}$" }),
  receiverName: name(),
  receiverId: Type.String({ minLength: 1, maxLength: 80, pattern: X12_SAFE_TEXT }),
  /** GS03, 2-15 alphanumerics. */
  receiverApplicationCode: Type.String({ pattern: "^[A-Za-z0-9]{2,15}$" }),
});
export type UpsertEdiProfileBody = Static<typeof UpsertEdiProfileBodySchema>;

export const EdiProfileViewSchema = Type.Object({
  profileId: Type.String(),
  providerEntityId: Type.String(),
  routeKey: Type.String(),
  ...UpsertEdiProfileBodySchema.properties,
  setByMembershipId: Type.String(),
  version: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type EdiProfileView = Static<typeof EdiProfileViewSchema>;

export const EdiProfileListResponseSchema = Type.Object({
  profiles: Type.Array(EdiProfileViewSchema),
});

export { parse };
