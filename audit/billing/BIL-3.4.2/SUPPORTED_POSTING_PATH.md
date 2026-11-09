# Supported posting path

No new Claim.MD-staged ERA financial scenario is supported by BIL-3.4.2. The existing manual/SFTP workflow remains `receiveAdvice → m25.edi.835_received → postAdvice`. It is not an approved-plan-bound path and must not be called from Claim.MD stage review.

The first safe scenario remains to be implemented after extracting a reusable M25 transaction operation that accepts a validated explicit claim association and writes through the existing accounting rules.
