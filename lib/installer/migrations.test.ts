import path from 'path';
import { describe, expect, it } from 'vitest';
import { listMigrationFiles, parseMigrationFilename } from './migrations';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

describe('installer migrations runner', () => {
  it('parses versioned migration filenames', () => {
    expect(parseMigrationFilename('20251201000000_schema_init.sql')).toEqual({
      version: '20251201000000',
      name: 'schema_init',
      filename: '20251201000000_schema_init.sql',
    });
    expect(parseMigrationFilename('20260205100000_create_messaging_system.sql')?.version).toBe(
      '20260205100000'
    );
    expect(parseMigrationFilename('README.md')).toBeNull();
    expect(parseMigrationFilename('schema_init.sql')).toBeNull();
  });

  it('discovers all versioned SQL files in chronological order', () => {
    const files = listMigrationFiles(MIGRATIONS_DIR);

    expect(files).toHaveLength(46);
    expect(files[0]).toMatchObject({
      version: '20251201000000',
      name: 'schema_init',
      filename: '20251201000000_schema_init.sql',
    });
    expect(files[files.length - 1]).toMatchObject({
      version: '20260417160000',
      name: 'fix_board_ai_config_rls',
      filename: '20260417160000_fix_board_ai_config_rls.sql',
    });

    const versions = files.map((file) => file.version);
    expect(versions).toEqual([...versions].sort((a, b) => a.localeCompare(b)));

    expect(files.some((file) => file.filename === '20260205100000_create_messaging_system.sql')).toBe(
      true
    );
  });
});
