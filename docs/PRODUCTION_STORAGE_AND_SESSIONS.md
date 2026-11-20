# Production storage and session notes

## Why data can disappear on Render Free

The application currently uses SQLite via `better-sqlite3` and writes the live database to `DATA_DIR/it_crm.db`. Backups are written below `BACKUP_DIR`, and uploaded files are written below `UPLOAD_DIR`.

A Render Free Web Service has an ephemeral filesystem. Local SQLite files, local backups, and uploads can be lost when the instance is replaced or redeployed. A daily backup stored on that same filesystem is not a durable off-site backup.

## Configurable storage paths

The server now supports these environment variables:

- `DATA_DIR`: directory containing `it_crm.db` (default: `./data`)
- `BACKUP_DIR`: directory for database backups (default: `<DATA_DIR>/backups`)
- `UPLOAD_DIR`: directory for uploaded files (default: `./uploads`)

On a hosting plan that supports a persistent disk, mount it and set all three paths to directories on that disk. For example, if the disk is mounted at `/var/data`:

- `DATA_DIR=/var/data/data`
- `BACKUP_DIR=/var/data/backups`
- `UPLOAD_DIR=/var/data/uploads`

Do not change these paths on a live deployment until the current database and uploads have been exported, copied, and verified. Changing `DATA_DIR` starts the app against a different SQLite file and can look like all records have disappeared.

## Render Free limitation

Render Free does not provide a persistent disk for a Web Service. The environment variables above do not make a Free instance durable. A durable zero-cost solution requires migrating the application from local SQLite to a supported managed database and moving uploaded files to durable object storage. This repository currently uses synchronous SQLite APIs and SQLite-specific SQL, so that migration needs a planned schema/query conversion, data export/import, and verification; it is not safe to switch by changing one connection string.

## Google Drive sync

The Drive sync worker runs inside the application process and its OAuth access token is intentionally held in memory. A process restart or token expiry interrupts that worker until an authorized Google sign-in occurs again. Do not persist short-lived access tokens in plaintext or remove the Google authorization requirement. Reliable unattended sync needs a supported OAuth refresh-token flow with secure server-side encryption and the required Google OAuth consent/configuration.

## Session security

The application currently issues 12-hour JWTs. Do not make tokens permanent or remove expiry. A secure longer-lived login requires refresh-token rotation, revocation, and session lifecycle handling rather than an unlimited JWT.

## Before production cutover

1. Export a fresh database backup and uploads.
2. Verify the backup integrity and record counts.
3. Configure the durable database/storage target.
4. Import into a staging deployment and compare record counts and key workflows.
5. Switch production only after verification and keep a rollback copy.
