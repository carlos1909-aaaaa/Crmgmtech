import { beforeEach, describe, expect, it, vi } from 'vitest';

const createClient = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => createClient(),
}));

describe('GET /api/installer/check-initialized', () => {
  beforeEach(() => {
    vi.resetModules();
    createClient.mockReset();
    vi.unstubAllEnvs();
  });

  it('returns initialized=false when INSTALLER_ENABLED is true, without querying the DB', async () => {
    vi.stubEnv('INSTALLER_ENABLED', 'true');
    vi.stubEnv('NODE_ENV', 'production');

    const { GET } = await import('./route');
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ initialized: false });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('returns initialized=true in production when installer is disabled and RPC says initialized', async () => {
    vi.stubEnv('INSTALLER_ENABLED', 'false');
    vi.stubEnv('NODE_ENV', 'production');
    createClient.mockResolvedValue({
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    });

    const { GET } = await import('./route');
    const res = await GET();
    const body = await res.json();

    expect(body).toEqual({ initialized: true });
    expect(createClient).toHaveBeenCalledOnce();
  });
});
