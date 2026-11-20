import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Read-only, point-in-time SQLite export for a later PostgreSQL migration.
 * This tool never connects to PostgreSQL and never changes the source database.
 *
 * Usage:
 *   npm run db:export-sqlite -- --source ./data/it_crm.db --out ./secure-migration-export
 */
function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourcePath = path.resolve(readArg('--source') || process.env.SQLITE_SOURCE || './data/it_crm.db');
const outputPath = path.resolve(readArg('--out') || '');
if (!readArg('--out')) {
  throw new Error('Missing required --out directory. Choose a new, secure directory outside the public web root.');
}
if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
  throw new Error(`SQLite source database not found: ${sourcePath}`);
}
if (fs.existsSync(outputPath)) {
  throw new Error(`Output directory already exists; refusing to overwrite it: ${outputPath}`);
}

const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

try {
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const integrityMessages = integrity.map((row) => row.integrity_check);
  if (integrityMessages.length !== 1 || integrityMessages[0] !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${integrityMessages.join('; ')}`);
  }

  const foreignKeyIssues = db.pragma('foreign_key_check') as Array<Record<string, unknown>>;
  if (foreignKeyIssues.length > 0) {
    throw new Error(`SQLite foreign_key_check found ${foreignKeyIssues.length} issue(s); export stopped.`);
  }

  fs.mkdirSync(outputPath, { recursive: false });
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as Array<{ name: string }>).map((row) => row.name);

  const manifest: {
    formatVersion: 1;
    generatedAt: string;
    sourceFileName: string;
    integrityCheck: 'ok';
    foreignKeyViolations: number;
    tables: Array<{ name: string; rowCount: number; file: string; sha256: string }>;
  } = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceFileName: path.basename(sourcePath),
    integrityCheck: 'ok',
    foreignKeyViolations: 0,
    tables: [],
  };

  const exportAll = db.transaction(() => {
    for (const tableName of tables) {
      const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all() as Array<Record<string, unknown>>;
      const file = `${tableName.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
      const serialized = JSON.stringify(rows);
      fs.writeFileSync(path.join(outputPath, file), serialized, { flag: 'wx', mode: 0o600 });
      manifest.tables.push({
        name: tableName,
        rowCount: rows.length,
        file,
        sha256: sha256(serialized),
      });
      console.log(`Exported ${tableName}: ${rows.length} row(s)`);
    }
  });
  exportAll();

  const manifestText = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(outputPath, 'manifest.json'), manifestText, { flag: 'wx', mode: 0o600 });
  console.log(`Read-only export complete: ${outputPath}`);
  console.log(`Tables: ${manifest.tables.length}; manifest SHA-256: ${sha256(manifestText)}`);
  console.log('Keep this export private. It may contain employee, login, ticket, and other confidential business data.');
} finally {
  db.close();
}
