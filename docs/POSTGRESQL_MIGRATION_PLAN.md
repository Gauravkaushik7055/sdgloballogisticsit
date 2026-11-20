# PostgreSQL migration plan (add-main)

## Current architecture findings

- The application currently opens SQLite with `better-sqlite3` in `server/db.ts`.
- The schema currently defines 38 core tables, indexes, idempotent `PRAGMA table_info` migrations, and SQLite triggers for audit/chat/ticket immutability.
- The application exposes a synchronous `db.prepare(...)`-style database API used throughout server routes and services. A PostgreSQL driver is asynchronous and uses different SQL syntax; replacing the connection string or swapping the driver is not a safe migration.
- SQLite-specific constructs include `INTEGER PRIMARY KEY AUTOINCREMENT`, `datetime('now')`, `INSERT OR IGNORE`, `PRAGMA`, `julianday()`, `MAX()` scalar usage, and SQLite trigger syntax.
- Backups and uploads are currently local filesystem paths. Moving relational records to PostgreSQL does not automatically make uploaded files durable.
- Existing Google Drive sync stores its short-lived access token in process memory. Database migration alone will not make unattended Drive sync survive a server restart or token expiry.

## Target provider

Neon PostgreSQL Free is the proposed $0/month target, subject to its published quotas and availability. As checked on 2026-11-20, the official Free-plan FAQ states 100 CU-hours per project/month, 1 GB storage per project, up to 2 CU autoscaling, 5 GB monthly public network transfer, and compute scale-to-zero after five minutes idle. The project can be suspended for the remainder of the month if compute or transfer quotas are exhausted. These limits must be monitored; Free tier is not an uptime SLA.

## Required migration phases

1. **Inventory and compatibility layer**
   - Enumerate every database call in server routes, services, scheduled jobs, authentication, backup/restore, seed logic, and tests.
   - Replace synchronous SQLite calls with an explicitly asynchronous repository layer and PostgreSQL-safe parameterized SQL.
   - Port schema creation, incremental migrations, indexes, foreign keys, and immutability triggers to versioned PostgreSQL migrations.
   - Preserve existing IDs, unique constraints, relationships, JSON payloads, timestamps, and audit history.

2. **Data export and import**
   - Create a read-only SQLite export command that checkpoints WAL, runs `PRAGMA integrity_check`, exports every table with row counts, and records a SHA-256 manifest.
   - Create an idempotent PostgreSQL import command with dependency-aware table order, explicit ID preservation, and sequence resets.
   - Compare per-table counts and critical relationships after import. Never delete or overwrite the original SQLite file during migration.

3. **Dual validation**
   - Run the migrated application against a separate Neon development project/branch first.
   - Verify login, MFA, sessions, ticket lifecycle, assets, expenses, reports, permissions, audit immutability, attachments, and scheduled jobs.
   - Keep production on the old database until checks pass and a fresh backup/export is verified.

4. **Cutover**
   - Set `DATABASE_URL` and any required SSL configuration as Render environment secrets (never commit credentials).
   - Stop writes briefly, take a final SQLite backup/export, import the final delta, verify counts, then deploy the PostgreSQL build.
   - Keep a documented rollback path to the untouched SQLite backup. Do not merge or deploy automatically.

5. **Files and integrations**
   - Move uploads and generated backup artifacts to durable object storage or another persistent storage service; PostgreSQL only stores their metadata/paths.
   - Implement Google OAuth refresh-token handling separately with encrypted server-side token storage and revocation controls. Never persist short-lived access tokens in plaintext.
   - Implement rotating refresh sessions separately; do not make JWTs permanent or remove idle-timeout/revocation checks.

## Safety status

This document is a plan, not a completed database migration. No PostgreSQL database has been provisioned, no live data has been copied, and no production environment variable has been changed. The `main` branch and live deployment must remain untouched until the migration is tested and explicitly approved.
