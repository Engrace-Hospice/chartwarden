# Financial balancing checks

The matching read calculates the transaction-level reported payment check in integer cents:

`sum(CLP04) - sum(PLB amounts as parsed) = BPR02`

The implementation returns balanced, discrepancy, or unavailable and never alters source values. Missing, excessive-precision, unsafe-integer, or invalid values produce unavailable. Provider-level adjustments remain separate from claim and service-line adjustments; the code does not allocate PLB values to claims or interpret CARC/RARC for posting.

The equation follows the X12 835 transaction balancing description; see [X12 005010X221A1 TR3, section 1.10.2.1.3](https://ecommerce.x12.org/assets/tr3/x221-005010-PDF.pdf) and [NCPDP 835 FAQ, section 2.6.2](https://www.ncpdp.org/NCPDP/media/pdf/WG45_835_FAQ.pdf). The check is not proof of cash settlement and is not a posting rule.

No claim-level CAS/charge balancing is asserted, because the current projection does not preserve enough complete monetary adjustment detail to prove that check safely.
