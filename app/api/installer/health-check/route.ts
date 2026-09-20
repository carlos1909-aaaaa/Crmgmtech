import { z } from 'zod';
import { isAllowedOrigin } from '@/lib/security/sameOrigin';
import { Client } from 'pg';
import {
  extractProjectRefFromSupabaseUrl,
  getSupabaseProject,
  resolveSupabaseDbUrlViaCliLoginRole,
} from '@/lib/installer/edgeFunctions';

export const maxDuration = 60;
export const runtime = 'nodejs';

const HealthCheckSchema = z.object({
  supabase: z.object({
    url: z.string().url(),
    accessToken: z.string().min(1),
    projectRef: z.string().optional(),
    dbUrl: z.string().optional(),
  }),
  vercel: z.object({
    token: z.string().min(1),
    projectId: z.string().min(1),
    teamId: z.string().optional(),
  }).optional(),
});

interface HealthCheckResult {
  ok: boolean;
  projectStatus: 'ACTIVE_HEALTHY' | 'ACTIVE_UNHEALTHY' | 'COMING_UP' | 'PAUSED' | 'UNKNOWN';
  projectReady: boolean;
  storageReady: boolean;
  schemaApplied: boolean;
  hasAdmin: boolean;
  hasOrganization: boolean;
  skipWaitProject: boolean;
  skipWaitStorage: boolean;
  skipMigrations: boolean;
  skipBootstrap: boolean;
  estimatedSeconds: number;
  details?: Record<string, unknown>;
}

function needsSsl(connectionString: string) {
  return !/sslmode=disable/i.test(connectionString);
}

function stripSslModeParam(connectionString: string) {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return connectionString;
  }
}

async function checkDatabaseHealth(dbUrl: string): Promise<{
  storageReady: boolean;
  schemaApplied: boolean;
  hasAdmin: boolean;
  hasOrganization: boolean;
}> {
  const normalizedDbUrl = stripSslModeParam(dbUrl);
  const client = new Client({
    connectionString: normalizedDbUrl,
    ssl: needsSsl(dbUrl) ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10_000,
  });

  try {
    await client.connect();

    const storageResult = await client.query<{ ready: boolean }>(
      `SELECT (to_regclass('storage.buckets') IS NOT NULL) as ready`
    );
    const storageReady = Boolean(storageResult?.rows?.[0]?.ready);

    const schemaResult = await client.query<{ ready: boolean }>(
      `SELECT (to_regclass('public.organizations') IS NOT NULL) as ready`
    );
    const schemaApplied = Boolean(schemaResult?.rows?.[0]?.ready);

    let hasAdmin = false;
    let hasOrganization = false;
    
    if (schemaApplied) {
      const orgResult = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM public.organizations LIMIT 1`
      );
      hasOrganization = parseInt(orgResult?.rows?.[0]?.count || '0', 10) > 0;

      const adminResult = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM public.user_settings WHERE role = 'admin' LIMIT 1`
      );
      hasAdmin = parseInt(adminResult?.rows?.[0]?.count || '0', 10) > 0;
    }

    return { storageReady, schemaApplied, hasAdmin, hasOrganization };
  } catch (error) {
    console.error('[health-check] Database check failed:', error);
    return { storageReady: false, schemaApplied: false, hasAdmin: false, hasOrganization: false };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function POST(req: Request) {
  if (!isAllowedOrigin(req)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const raw = await req.json().catch(() => null);
  const parsed = HealthCheckSchema.safeParse(raw);
  
  if (!parsed.success) {
    return Response.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 });
  }

  const { supabase } = parsed.data;
  const projectRef = supabase.projectRef?.trim() || extractProjectRefFromSupabaseUrl(supabase.url) || '';
  
  if (!projectRef) {
    return Response.json({ error: 'Could not determine project ref' }, { status: 400 });
  }

  const result: HealthCheckResult = {
    ok: false,
    projectStatus: 'UNKNOWN',
    projectReady: false,
    storageReady: false,
    schemaApplied: false,
    hasAdmin: false,
    hasOrganization: false,
    skipWaitProject: false,
    skipWaitStorage: false,
    skipMigrations: false,
    skipBootstrap: false,
    estimatedSeconds: 120,
  };

  try {
    const statusResult = await getSupabaseProject({
      accessToken: supabase.accessToken,
      projectRef,
    });

    if (statusResult.ok) {
      const status = statusResult.project.status || "".toUpperCase();
      if (status.includes('ACTIVE_HEALTHY')) {
        result.projectStatus = 'ACTIVE_HEALTHY';
        result.projectReady = true;
      } else if (status.includes('ACTIVE')) {
        result.projectStatus = 'ACTIVE_UNHEALTHY';
        result.projectReady = true;
      } else if (status.includes('COMING_UP') || status.includes('RESTORING')) {
        result.projectStatus = 'COMING_UP';
        result.projectReady = false;
      } else if (status.includes('PAUSED') || status.includes('INACTIVE')) {
        result.projectStatus = 'PAUSED';
        result.projectReady = false;
      }
    }

    let dbUrl = supabase.dbUrl?.trim() || '';
    if (!dbUrl && result.projectReady) {
      const dbResult = await resolveSupabaseDbUrlViaCliLoginRole({
        projectRef,
        accessToken: supabase.accessToken,
      });
      if (dbResult.ok) {
        dbUrl = dbResult.dbUrl;
      }
    }

    if (dbUrl && result.projectReady) {
      const dbHealth = await checkDatabaseHealth(dbUrl);
      result.storageReady = dbHealth.storageReady;
      result.schemaApplied = dbHealth.schemaApplied;
      result.hasAdmin = dbHealth.hasAdmin;
      result.hasOrganization = dbHealth.hasOrganization;
    }

    result.skipWaitProject = result.projectReady;
    result.skipWaitStorage = result.storageReady;
    // organizations existing only means schema_init ran — later migrations may still be missing.
    // runSchemaMigration() tracks versions and is safe to re-run; never skip it from this heuristic.
    result.skipMigrations = false;
    result.skipBootstrap = result.hasAdmin && result.hasOrganization;

    let estimatedSeconds = 10;
    if (!result.skipWaitProject) estimatedSeconds += 90;
    if (!result.skipWaitStorage) estimatedSeconds += 30;
    if (!result.skipMigrations) estimatedSeconds += 15;
    if (!result.skipBootstrap) estimatedSeconds += 5;
    estimatedSeconds += 20;
    
    result.estimatedSeconds = estimatedSeconds;
    result.ok = true;
    result.details = { projectRef, dbUrlProvided: Boolean(supabase.dbUrl), dbUrlResolved: Boolean(dbUrl) };

  } catch (error) {
    console.error('[health-check] Error:', error);
    result.ok = false;
    result.details = { error: error instanceof Error ? error.message : 'Unknown error' };
  }

  return Response.json(result);
}
