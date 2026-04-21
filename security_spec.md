# Security Specification 

## Data Invariants
1. A log entry (`DailyLog`) cannot exist without a valid `userId` path that strictly matches the authenticated user (`request.auth.uid`).
2. The `ownerId` field in the document must match the authenticated `userId`.
3. The `logDate` ID must be a YYYY-MM-DD string format to prevent ID poisoning and excessive storage.
4. All text fields (`good`, `bad`, `gratitude`, `aiComment`) must have a strict character limit.
5. `updatedAt` must be a valid server timestamp, updated on every write.

## The "Dirty Dozen" Payloads
1. **Unauthenticated Write**: Missing `request.auth` entirely.
2. **Path Spoofing**: `request.auth.uid` is 'userA', but writing to `users/userB/logs/2026-04-21`.
3. **OwnerId Spoofing**: Writing to own path, but `ownerId` field is set to 'userB'.
4. **Missing OwnerId**: Payload omits `ownerId` entirely.
5. **ID Poisoning**: `logDate` is 1MB string or invalid characters instead of YYYY-MM-DD.
6. **Type Poisoning**: `good` is an Array or Number instead of String.
7. **Size Poisoning**: `good` is a 1MB string exceeding the validation limit.
8. **Shadow Field**: Payload includes `isVerified: true` (a ghost field not in schema).
9. **Timestamp Spoofing**: `updatedAt` is a client timestamp instead of `request.time`.
10. **Incomplete Schema**: Payload missing required `good` string during create.
11. **Orphan Modification**: Updating a log document but changing `ownerId`.
12. **System Field Modification**: Modifying `aiComment` with massive data without being validated.

## Test Runner
Defined in `firestore.rules.test.ts`.
