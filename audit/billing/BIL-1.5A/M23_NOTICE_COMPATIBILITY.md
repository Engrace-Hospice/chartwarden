# M23 notice compatibility

NOE, NOTR and transfer notice Claim.MD uploads remain fail-closed. The immutable submission evidence schema and `transportUpload` path require claim ID/submission evidence, while these notice workflows do not provide a claim ID. Do not enable Claim.MD notice uploads. Corrective work should introduce a separate immutable notice-evidence identity and propagate it through the existing at-send evidence path without changing notice business transitions; add focused coverage for all three notice types.
