import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSupabaseProject = vi.fn();
const query = vi.fn();

vi.mock('@/lib/security/sameOrigin', () => ({
  isAllowedOrigin: () => true,
}));

vi.mock('@/lib/installer/edgeFunctions', () => ({
  extractProjectRefFromSupabaseUrl: () => 'projref',
  getSupabaseProject: (...args: unknown[]) => getSupabaseProject(...args),
  resolveSupabaseDbUrlViaCliLoginRole: vi.fn(),
}));

vi.mock('pg', () => ({
  Client: class {
    connect = vi.fn().mockResolvedValue(undefined);
    end = vi.fn().mockResolvedValue(undefined);
    query = (...args: unknown[]) => query(...args);
  },
}));

describe('POST /api/installer/health-check', () => {
  beforeEach(() => {
    vi.resetModules();
    getSupabaseProject.mockReset();
    query.mockReset();
  });

  it('does not skip migrations when public.organizations exists but later migrations are missing', async () => {
    getSupabaseProject.mockResolvedValue({
      ok: true,
      project: { status: 'ACTIVE_HEALTHY' },
    });

    query.mockImplementation(async (sql: string) => {
      if (sql.includes("to_regclass('storage.buckets')")) {
        return { rows: [{ ready: true }] };
      }
      if (sql.includes("to_regclass('public.organizations')")) {
        return { rows: [{ ready: true }] };
      }
      if (sql.includes('FROM public.organizations')) {
        return { rows: [{ count: '1' }] };
      }
      if (sql.includes('FROM public.user_settings')) {
        return { rows: [{ count: '1' }] };
      }
      return { rows: [] };
    });

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/installer/health-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          supabase: {
            url: 'https://projref.supabase.co',
            accessToken: 'sbp_test',
            projectRef: 'projref',
            dbUrl: 'postgresql://postgres:pass@db.projref.supabase.co:5432/postgres',
          },
        }),
      })
    );

    const body = await res.json();

    expect(body.schemaApplied).toBe(true);
    expect(body.hasOrganization).toBe(true);
    expect(body.skipMigrations).toBe(false);
  });
});
