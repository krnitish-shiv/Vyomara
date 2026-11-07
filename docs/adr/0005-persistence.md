# ADR-0005: Session history and explicit memory persistence

- **Status:** Accepted

## Context and problem

MVP requires locally stored, inspectable, deletable session history and
explicitly confirmed memory. Phase 2 leaves storage format, encryption,
retention, backup, and deletion guarantees open. These affect privacy and data
loss behavior.

## Decision

Keep session history and explicit memory logically separate. Use Node's
built-in `node:sqlite` `DatabaseSync` API with a versioned schema and
migrations. Schema version 2 also stores selected desktop filesystem roots so
grants and revocations persist across restarts. This avoids a native package
dependency and is available on the
declared Node.js `>=22.22.1` baseline. The API is experimental in this Node
line, so pin the documented runtime baseline and keep storage behind an
interface that can be replaced if compatibility changes.

Store the database at
`~/Library/Application Support/Vyomara/vyomara.sqlite` by default, with an
absolute `VYOM_DATA_DIR` override for testing and advanced local setups. Use
owner-only directory/file permissions (`0700`/`0600`) and SQLite foreign keys.
History is retained until the user deletes it; there is no automatic expiry,
automatic backup, or cloud sync. The desktop app can create a manual,
unencrypted SQLite snapshot at a user-selected destination. Restore is not
automatic: the user selects a validated snapshot, reviews its record counts,
and types `RESTORE`. Before replacement, the app writes a private safety
snapshot of the current database in the local data directory. macOS FileVault
is recommended; the application does not provide database-level encryption,
and operating system backups may include the database.

Persist session messages locally for review and continuation; this includes
user prompts, model replies, tool calls, and their returned data, which may
contain private file contents. Disclose this behavior and provide session
inspection and deletion. Ordinary session history is not memory. Save memory
only through a dedicated, explicit user operation with confirmation; never
extract it automatically from conversation. Keep prompts, message content,
memory text, and tool results out of ordinary logs and audit events.

## Alternatives considered

- JSON files/JSONL using Node built-ins: low dependency cost, but atomic updates,
  corruption recovery, concurrency, encryption, and deletion semantics need
  explicit design.
- Third-party embedded database: mature APIs, but native dependencies add
  installation and eventual Electron ABI/packaging complexity; the current
  Node baseline supplies an embedded SQLite API.
- Keep all data only in process memory: private by default but fails the
  session-history persistence requirement.

## Consequences and trade-offs

The built-in database avoids an external dependency, but its experimental
status must be monitored. Synchronous SQLite operations are appropriate for
the current single-user CLI and bounded records; move behind the persistence
interface before adding concurrent workers or long-running storage work.

## Security/privacy implications

History is not memory. No ordinary conversation becomes durable memory without
explicit user request and content confirmation. Manual backups contain the
complete SQLite database, including raw history and settings; they are
unencrypted and must be protected by the user. Restrict access to the current
macOS user, recommend FileVault, retain until explicit deletion, cascade
message deletion with its session, and never store credentials. A corrupted
database must fail visibly; do not silently replace it or discard records.

## Implementation implications for Phase 4

The Phase 4 skeleton kept temporary session messages in process memory. Phase
9 adds local session history and separately managed explicit memory. Phase 12
adds persistent desktop filesystem-root permissions; Phase 24 adds explicit
manual backup creation; Phase 25 adds validated restore with a pre-restore
safety snapshot. Test inspect/review/delete paths, migration, restart
persistence, session isolation, permissions, backup integrity, and corruption
handling. Do not claim application-level encryption or automatic backup.

## Evidence

FR-009, FR-010; NFR-008, NFR-017; Phase 2 open questions on format, encryption,
retention, backups, and deletion.
