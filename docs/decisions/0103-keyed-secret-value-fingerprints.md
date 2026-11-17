# Decision 0103: Keyed secret value fingerprints

Status: **accepted and implemented**

Date: 2026-11-17 (Asia/Shanghai).

## Context

ADR 0025 introduced write-only SecretHandles. A value is sealed at rest with
AES-256-GCM under a process-scoped key, never returned to a client, never
logged, and never sent to a model. Beside the ciphertext the store keeps a
`value_digest`, described in `SECURITY.md` as a "one-way digest", and publishes it
as `valueDigest` on the handle.

The digest was `sha256:` of the plaintext, unsalted, in the same row as the
ciphertext. That reads as protection and is not:

- The ciphertext genuinely hides the value — AES-GCM with a random IV per seal.
- The digest does not. A database copy hands an attacker `sha256(password)` next
  to the row it belongs to, which is exactly the input an offline dictionary or
  rainbow-table attack needs. For a high-entropy API key that is fine; for a
  password, a PIN, or a short token it is a plaintext-equivalent leak.
- Sealing is therefore only as strong as the entropy of what it seals, which is
  not a property the Runtime controls.

The digest is not used to verify a caller-supplied value: nothing in the Runtime
compares it against an input. It is a fingerprint — "this is the value that was
configured" — used so a client can tell a rotation from a no-op and so use
receipts reference a value without carrying it.

## Decision

1. **The fingerprint is keyed.** `secretValueDigest(value, key)` is
   HMAC-SHA256 under a process-scoped key. There is no unkeyed overload left, so
   a new call site has to state which key it means.
2. **It has its own key.** `PROCESS_VALUE_FINGERPRINT_KEY` is separate from
   `PROCESS_SEALED_VALUE_KEY`. Both are process-scoped with the same lifetime, but
   a compromise of one should not weaken the other.
3. **The published shape does not change.** It is still `sha256:<64 hex>`, so
   clients, `openapi.yaml`, and the receipt format are untouched. What changes is
   that the value can no longer be recovered from a database copy.
4. **The fingerprint dies with the seal.** A restart already invalidates every
   sealed value (`openSealedValue` would fail with the new key), so a fingerprint
   that cannot be reproduced across a restart is consistent with the seal rather
   than a new limitation. Nothing durable depends on cross-restart stability.
5. **Existing rows are not migrated.** A stored fingerprint from an older build
   is indistinguishable from a fingerprint of a different value; rewriting it
   would require the plaintext, which the Runtime does not keep. Those handles are
   already unusable after a restart, and rotating the handle produces a new
   fingerprint.

## Consequences

- A database copy no longer yields a crackable hash of any configured secret.
  The residual exposure is the same as before: an attacker holding both the
  database and the live process memory.
- `valueDigest` is stable within a process and meaningless across processes. A
  client that persisted it to detect changes must treat a restart as a change.
- The rotation test can no longer assert a computed value; it asserts the shape,
  that it differs from the plaintext hash, and that it changes on rotation.

## Options considered

### A. Keep the plaintext SHA-256 and document the entropy requirement

Consequences: makes the safety of a seal depend on what the user chose as a
secret, with no way to enforce it. Rejected.

### B. Salted hash with a per-row random salt

Consequences: defeats rainbow tables but not a dictionary attack, because the salt
is stored beside the digest. It also breaks equality comparison between two rows,
which the fingerprint exists to support. Rejected.

### C. Drop the fingerprint entirely

Consequences: removes the ability to tell a rotation from a no-op without
revealing the value, and changes the handle contract. The keyed fingerprint keeps
the capability at no cost to confidentiality. Rejected.
