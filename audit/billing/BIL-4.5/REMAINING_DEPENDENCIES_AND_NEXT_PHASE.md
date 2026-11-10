# Remaining Dependencies and Next Phase

## External / financial dependencies

- Medicare Claim.MD/MAC route certification and controlled-test approval remain pending.
- No Medicare-specific Claim.MD posting authorization or accounting policy is implemented.
- PLB recovery references, reversals and recoupments still lack an authoritative historical financial-effect correlation contract; BIL-4.4 correctly leaves them review-only.
- Organization/provider/payer policy governance for CO, PI, PLB and patient-liability actions remains unconfigured. Existing blockers are preserved.
- Vendor/IdP deployment certification and production activation were not attempted.

## Next implementation

The repository's published Billing roadmap has BIL-5 as the next broad phase; it does not define a BIL-4.6. A focused next implementation is proposed as **BIL-4.6 — Medicare Route & Financial-Policy Certification Before Posting**: establish source-owned MAC route evidence, identify and approve policy ownership for financial effects, and verify recovery/duplicate correlation. Keep actual Medicare posting disabled until the rules and controlled-test authorization are verified. Do not broaden financial effects by inferring them from an ERA code.
