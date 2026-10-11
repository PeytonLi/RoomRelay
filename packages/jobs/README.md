# Jobs

The queue provides generic leases, fencing, retries, and subject-version checks. Payment jobs must never be generically retried with a new idempotency key; they require their own job type, persistent provider request key, and retry/reconciliation rules. This queue retries only the same row and key.

Subject guards for T-004 should lock the subject row with `SELECT ... FOR SHARE`. The guard runs inside the completion transaction so a subject-version change cannot race the final check and output publication.

Operator retry reuses the same row and idempotency key, and refuses financial job types.
