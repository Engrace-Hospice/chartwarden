# M23 and M41 integration boundary

| Concern | M23 | M41 | Status / evidence |
|---|---|---|---|
| Final payload source | Claim payload builder before transport | Renderer output before transport | Implemented; callers hash/parse final X12 |
| Evidence metadata | Claim, submission, attempt index, location; missing metadata blocks Claim.MD send | Claim/submission/control/attempt/location and context | Implemented for claim sends |
| Tenant/provider identity | Caller organization/provider plus context billing NPI; payer persisted from X12 | Caller organization/provider plus commercial payer and billing NPI checked against context | Implemented; provider scope runtime RLS not yet certified |
| Pre-send durable reservation | Before `submitClaim`/`submitNotice` call | Before `submitClaim` call | Implemented in source |
| Claim.MD upload receipt | Append receipt observations before acknowledging success | Append receipt observations before accepted transition | Implemented for returned identifiers; replay path may only have opaque identifier |
| Notice transactions | Required evidence metadata absent on current Claim.MD notice callers | Not applicable | Fail-closed / partial; NOE, NOTR, transfer path unavailable through this evidence-enabled boundary |
| Other vendors | Existing paths unchanged | Existing paths unchanged | Shared port preserved |

M23 evidence validation deliberately takes payer identity from the actual X12 rather than assuming `CLEARINGHOUSE_PAYER_ID` or MAC jurisdiction is the Claim.MD payer ID. M41 verifies the parsed payer against its commercial submission payer. Neither source check proves Claim.MD routing configuration is correct; test-account verification is still required.

Transport upload receipt is a clearinghouse receipt only. It is not a 999, 277CA, payer acceptance, adjudication, ERA, or payment state.
