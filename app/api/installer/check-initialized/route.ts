import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
    },
  });
}

/**
 * Verifica se a instância já foi inicializada.
 * Endpoint público (não requer autenticação) para uso nas páginas de instalação.
 * 
 * @returns {Promise<Response>} Retorna { initialized: boolean }
 */
export async function GET() {
  // Chave explícita de manutenção: com INSTALLER_ENABLED=true o wizard
  // permanece acessível mesmo se a instância já tiver organization/profile
  // (catch-up de migrations). Não altera is_instance_initialized() no banco.
  // INSTALLER_ENABLED=false (pós-install) mantém o bloqueio normalmente.
  if (process.env.INSTALLER_ENABLED === 'true') {
    console.log('[check-initialized] INSTALLER_ENABLED=true: allowing installer access');
    return json({ initialized: false });
  }

  // Bypass em desenvolvimento local: sempre permite acesso ao wizard
  if (process.env.NODE_ENV === 'development') {
    console.log('[check-initialized] Development mode: bypassing initialization check');
    return json({ initialized: false });
  }

  try {
    const supabase = await createClient();
    
    // is_instance_initialized tem GRANT para anon/authenticated
    const { data, error } = await supabase.rpc('is_instance_initialized');
    
    if (error) {
      // Em caso de erro, assumimos que não está inicializado para não bloquear o wizard
      console.warn('[check-initialized] Error checking initialization:', error);
      return json({ initialized: false });
    }
    
    return json({ initialized: data === true });
  } catch (err) {
    // Fail-safe: em caso de erro, não bloqueia o acesso ao wizard
    console.warn('[check-initialized] Exception:', err);
    return json({ initialized: false });
  }
}

