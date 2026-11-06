-- compat: expand
-- ADR-0109 D10 - a bereaved contact can ask to stop MAILINGS (newsletter, holiday card, memorial invitation) while the calls and visits of
-- the Medicare-aligned cadence continue. `no_mailings` is a new bereavement_opt_out_kind: unlike `full` it does not close the contact, and
-- unlike `channel_specific` it names no channel. Purely additive: nothing reads the value until the mailing PR writes it, and no row changes.
-- ALTER TYPE ... ADD VALUE is safe in the migration transaction because nothing in this file uses the new value (its own file, per 1001/1305).
ALTER TYPE "public"."bereavement_opt_out_kind" ADD VALUE IF NOT EXISTS 'no_mailings';
