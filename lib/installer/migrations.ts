import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');
const SCHEMA_INIT_VERSION = '20251201000000';
const MIGRATION_FILENAME_RE = /^(\d{14})_(.+)\.sql$/;

export type MigrationFile = {
  version: string;
  name: string;
  filename: string;
  filePath: string;
};

function needsSsl(connectionString: string) {
  return !/sslmode=disable/i.test(connectionString);
}

function stripSslModeParam(connectionString: string) {
  // Some drivers/envs treat `sslmode=require` inconsistently. We control SSL via `Client({ ssl })`.
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return connectionString;
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function isRetryableConnectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('ENOTFOUND') ||
    msg.includes('EAI_AGAIN') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('timeout')
  );
}

/**
 * Conecta com retry/backoff, recriando o Client a cada tentativa.
 * Isso evita o erro: "Client has already been connected. You cannot reuse a client."
 */
async function connectClientWithRetry(
  createClient: () => Client,
  opts?: { maxAttempts?: number; initialDelayMs?: number }
): Promise<Client> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const initialDelayMs = opts?.initialDelayMs ?? 3000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = createClient();
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      try {
        await client.end().catch(() => undefined);
      } catch {
        // ignore
      }

      if (!isRetryableConnectError(err) || attempt === maxAttempts) {
        throw err;
      }

      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `[migrations] Conexão falhou (${msg}), tentativa ${attempt}/${maxAttempts}. Aguardando ${Math.round(
          delayMs / 1000
        )}s...`
      );
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Falha ao conectar ao banco de dados'));
}

async function waitForStorageReady(client: Client, opts?: { timeoutMs?: number; pollMs?: number }) {
  const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 210_000;
  const pollMs = typeof opts?.pollMs === 'number' ? opts?.pollMs : 4_000;
  const t0 = Date.now();

  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await client.query<{ ready: boolean }>(
        `select (to_regclass('storage.buckets') is not null) as ready`
      );
      const ready = Boolean(r?.rows?.[0]?.ready);
      if (ready) return;
    } catch {
      // keep polling on transient errors
    }
    await sleep(pollMs);
  }

  throw new Error(
    'Supabase Storage ainda não está pronto (storage.buckets não existe). Aguarde o projeto terminar de provisionar e tente novamente.'
  );
}

function formatPgError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { message?: string; code?: string; detail?: string; hint?: string };
    return [
      e.message,
      e.code ? `code=${e.code}` : null,
      e.detail ? `detail=${e.detail}` : null,
      e.hint ? `hint=${e.hint}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
  }
  return String(err);
}

/**
 * Parse a Supabase migration filename (`YYYYMMDDHHMMSS_name.sql`).
 */
export function parseMigrationFilename(filename: string): Omit<MigrationFile, 'filePath'> | null {
  const match = MIGRATION_FILENAME_RE.exec(filename);
  if (!match) return null;
  return {
    version: match[1],
    name: match[2],
    filename,
  };
}

/**
 * List versioned SQL migrations in lexicographic (chronological) order.
 */
export function listMigrationFiles(migrationsDir = MIGRATIONS_DIR): MigrationFile[] {
  const entries = fs.readdirSync(migrationsDir);
  const files: MigrationFile[] = [];

  for (const filename of entries) {
    const parsed = parseMigrationFilename(filename);
    if (!parsed) continue;
    files.push({
      ...parsed,
      filePath: path.join(migrationsDir, filename),
    });
  }

  files.sort((a, b) => a.filename.localeCompare(b.filename));
  return files;
}

async function ensureMigrationTracker(client: Client): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');

  const table = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS exists`
  );

  if (!table.rows[0]?.exists) {
    // Same shape the Supabase CLI bootstraps (version PK + optional name/statements).
    await client.query(`
      CREATE TABLE supabase_migrations.schema_migrations (
        version text NOT NULL PRIMARY KEY,
        statements text[],
        name text
      )
    `);
    return;
  }

  const cols = await client.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'supabase_migrations'
       AND table_name = 'schema_migrations'`
  );
  const names = new Set(cols.rows.map((row) => row.column_name));

  if (!names.has('version')) {
    throw new Error(
      'supabase_migrations.schema_migrations exists but is missing the version column; refusing to create a second tracker.'
    );
  }

  // Match CLI: add missing optional columns instead of a parallel table.
  if (!names.has('statements')) {
    await client.query(
      'ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]'
    );
  }
  if (!names.has('name')) {
    await client.query(
      'ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text'
    );
  }
}

async function getAppliedVersions(client: Client): Promise<Set<string>> {
  const result = await client.query<{ version: string }>(
    'SELECT version FROM supabase_migrations.schema_migrations'
  );
  return new Set(result.rows.map((row) => row.version));
}

async function recordApplied(client: Client, version: string, name: string): Promise<void> {
  await client.query(
    `INSERT INTO supabase_migrations.schema_migrations (version, name)
     VALUES ($1, $2)`,
    [version, name]
  );
}

/**
 * Existing installer DBs ran schema_init outside the tracker.
 * Record it as applied without re-executing when the base tables already exist.
 */
async function recordExistingSchemaInitIfNeeded(client: Client, applied: Set<string>): Promise<void> {
  if (applied.has(SCHEMA_INIT_VERSION)) return;

  const result = await client.query<{ has_organizations: boolean; has_profiles: boolean }>(
    `SELECT
       to_regclass('public.organizations') IS NOT NULL AS has_organizations,
       to_regclass('public.profiles') IS NOT NULL AS has_profiles`
  );
  const row = result.rows[0];
  if (!row?.has_organizations || !row?.has_profiles) return;

  console.log(
    `[MIGRATION] Existing schema detected — recording ${SCHEMA_INIT_VERSION} as applied without re-running`
  );

  await client.query('BEGIN');
  try {
    await recordApplied(client, SCHEMA_INIT_VERSION, 'schema_init');
    await client.query('COMMIT');
    applied.add(SCHEMA_INIT_VERSION);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

async function applyMigration(client: Client, migration: MigrationFile): Promise<void> {
  const sql = fs.readFileSync(migration.filePath, 'utf8');

  console.log(`[MIGRATION] Applying ${migration.filename}`);

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await recordApplied(client, migration.version, migration.name);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }

    const pgError = formatPgError(err);
    console.error(`[MIGRATION] FAILED:\n${migration.filename}`);
    console.error('[MIGRATION] Database changes rolled back.');
    console.error(`[MIGRATION] ${pgError}`);

    throw new Error(
      `[MIGRATION] FAILED:\n${migration.filename}\n\n[MIGRATION] Database changes rolled back.\n\n${pgError}`
    );
  }

  console.log(`[MIGRATION] Applied ${migration.version}`);
}

/**
 * Função pública `runSchemaMigration` do projeto.
 * Aplica todas as migrations versionadas em supabase/migrations/, com tracking.
 */
export async function runSchemaMigration(dbUrl: string) {
  const migrations = listMigrationFiles();
  console.log(`[MIGRATION] Found ${migrations.length} migrations`);

  const normalizedDbUrl = stripSslModeParam(dbUrl);

  const createClient = () =>
    new Client({
      connectionString: normalizedDbUrl,
      // NOTE: Supabase DB uses TLS; on some networks a MITM/corporate proxy can inject a cert chain
      // that Node doesn't trust. For the installer/migrations step we prefer "no-verify" over failure.
      ssl: needsSsl(dbUrl) ? { rejectUnauthorized: false } : undefined,
    });

  const client = await connectClientWithRetry(createClient, { maxAttempts: 5, initialDelayMs: 3000 });

  try {
    // Never "skip" Storage. We wait until it's ready, then run migrations.
    await waitForStorageReady(client);
    await ensureMigrationTracker(client);

    const applied = await getAppliedVersions(client);
    await recordExistingSchemaInitIfNeeded(client, applied);

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        console.log(`[MIGRATION] ${migration.version} already applied — skip`);
        continue;
      }

      await applyMigration(client, migration);
      applied.add(migration.version);
    }
  } finally {
    await client.end();
  }
}
