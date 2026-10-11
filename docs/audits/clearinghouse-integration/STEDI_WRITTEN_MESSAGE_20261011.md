# Written message to Stedi (draft, to send)

**To:** Stedi Customer Operations and the engineer on our thread
**From:** Engrace (Fabrice Adjam, engineering lead)
**Status:** draft; not sent. Send, then record the date and each answer in `STEDI_QUESTIONS_20261008.md`.

---

Subject: Hospice integration: written follow-up questions (sandbox build)

Hello,

Thank you for the earlier answers. We have built the submit side against the sandbox and are blocked on
the items below before we build the receive side (acknowledgements, 277CA, 835). Numbering matches our
shared list (Q14 onward).

**Blocking**

- **Q14.** Our sandbox key returns `ACCOUNT_NOT_PROVISIONED` (HTTP 400) on every 837I that passes your
  edits, and on 277/835 report fetches and the polling endpoint. What enables test-mode claim submission
  and the Stedi Test Payer 835 flow on this account? A single 200 response body would let us finish
  parsing.
- **Q20.** Is there a way to validate a claim without filing it, without consuming the idempotency key?
- **Q21.** NOE/NOTR: is `BHT06 = RP` the right value for a Medicare MAC, given `CH` with a $0 charge is
  rejected by your edits?
- **Q22.** Webhook signatures: the exact signed content (`timestamp.body` or `id.timestamp.body`), the
  secret encoding, and the header names.
- **Q27.** On a shared account, how are 835s and 277CAs attributed to a billing NPI?
- **Q17 / Q28.** Your resubmission guidance says Original Medicare does not accept claim frequency 7 or 8,
  yet your edit accepts them when `REF*F8` follows `CL1`. How do we adjust or cancel a paid hospice claim?
- **Q15 / Q16 / Q31.** Is Medicare Oregon Part A (`MDCKC`, payer ID `12M41`) the right payer for hospice
  837I and NOE/NOTR (CCN 381588, Pendleton, OR)? Why does NGS `MFPWU` show 837I `NOT_SUPPORTED`? What does
  enrollment require and how long does it take?

**Non-blocking**

- Q23 claim-route `Authorization` form. Q24 idempotency replay and mismatch responses. Q25 whether the
  initial 277CA is in the 200 body and which STC codes mean accepted versus forwarded. Q26 the
  "not enrolled" response shape. Q29 276/277 status inquiry. Q30 TOB 82A/82B and 8xC/8xD. Q18 any
  hospice-specific edits on your side.
- HETS eligibility: CORE SOAP versus raw X12, `X-Forwarded-For`, and how production testing with CMS is
  coordinated (Q11).

Expected volume, as you asked: about 100-170 transactions a month (35-60 837I including about 10%
adjustments, 10-15 NOE, 10-15 NOTR, 25-45 eligibility checks).

All payloads we have shared use synthetic data only. Full text of each question is in our shared list.

Thank you,
Fabrice Adjam
