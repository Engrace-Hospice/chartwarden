# BIL-4.1 — Multi-Claim Fully Paid ERA Posting

This change extends the existing controlled Claim.MD posting path to an all-or-nothing set of fully paid M41 claims. It reuses M25's caller-owned transaction core, plan/approval persistence, owner-scoped M41 history reader, and outbox. The financial feature remains disabled by default.

The supported case is deliberately narrow: all claims in one staged ERA must independently be fully paid with zero patient responsibility and no adjustments, service-line adjudication, PLB, reversal, recoupment, remarks, or unknown parsed content. Every claim must resolve to one authorized M41 historical attempt and the claim payments must equal the ERA payment.

See the focused scope, integrity and verification notes in this directory. No migration was needed; the existing immutable plan document binds the ordered claim set and effects.
