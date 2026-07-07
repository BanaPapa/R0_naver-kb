import { createClient } from '@supabase/supabase-js';
import logger from '../applyhome/logger.mjs';

/**
 * Server-side Supabase client (service_role) — lazy factory (odcloud 패턴과 동일).
 * vite.config.ts의 top-level import이 loadEnv보다 먼저 실행되므로 모듈 로드 시점에
 * process.env를 읽으면 빈 값이 된다. 첫 요청 시 getSupabaseAdmin()을 호출해 초기화한다.
 *
 * NEVER import this from browser code — the service_role key must stay server-side.
 */
let _admin = undefined; // undefined = not yet initialized, null = disabled

export function getSupabaseAdmin() {
  if (_admin !== undefined) return _admin;
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && serviceKey) {
    _admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    logger.info('Supabase archive enabled (service_role client ready)');
  } else {
    _admin = null;
    logger.info('Supabase archive disabled (set VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to enable)');
  }
  return _admin;
}

export const isArchiveEnabled = () => getSupabaseAdmin() !== null;
