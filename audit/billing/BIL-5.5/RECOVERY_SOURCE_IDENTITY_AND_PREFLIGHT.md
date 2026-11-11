# Recovery source identity and preflight

The assessment begins from one `claimmd_era_inbox` row constrained by inbox UUID, vendor, server-configured account reference, and runtime environment. It reads the associated stream lease, ownership resolution, delivery receipt, source digest presence, and prior recovery receipts.

Supported blocker codes include active lease, retry threshold, attempt limit, ownership conflict, missing resolution/delivery, unsafe delivery reason, source digest mismatch, resolution version mismatch, and attribution scope mismatch. Completed delivery/duplicate states return `already_processed`.

The assessment never decrypts source bytes and does not claim financial eligibility.
