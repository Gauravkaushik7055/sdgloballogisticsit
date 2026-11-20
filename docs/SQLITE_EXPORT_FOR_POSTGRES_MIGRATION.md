# Read-only SQLite export for PostgreSQL migration

This utility creates a private, checksummed export of the existing SQLite database. It is a preparation step only: it does **not** create PostgreSQL tables, connect to Neon, import data, or change the source database.

## Run locally

1. Obtain a fresh SQLite backup from the application using its approved backup workflow. Do not download the database from a public URL or commit it to Git.
2. Keep the backup in a private local folder.
3. From the repository root, run:

   ```bash
   npm install
   npm run db:export-sqlite -- --source ./path/to/it_crm.db --out ./secure-migration-export
   ```

4. The command checks SQLite integrity and foreign-key consistency before exporting each application table as JSON. It writes a `manifest.json` with row counts and SHA-256 checksums. Existing output directories are never overwritten.
5. Store the resulting directory securely. It can contain employee personal data, login-related records, tickets, audit logs, and confidential business information. Do not upload it to GitHub or share it in chat.

## What this does not prove

- A successful export is not a PostgreSQL import or application compatibility test.
- The current application still runs on synchronous `better-sqlite3`; production must not be pointed at Neon until the server data-access layer and all SQLite-specific queries, migrations, triggers, backup/restore paths, and scheduled jobs have been ported and tested.
- The source database must be a fresh, verified backup from the actual running environment. A developer's old local database is not an adequate production migration source.
- File uploads and generated backup files need a separate durable storage migration.
- Neon `migration-test` is a separate database branch; do not use the Neon `production` branch for trial imports.

## Current status

This is a read-only export/preflight tool committed on GitHub branch `add-main`. No live data has been exported or copied, no Neon credentials have been configured, and no Render environment settings have been changed.
