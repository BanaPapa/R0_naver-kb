import type { AuthMethod, ModelInfo, ProviderStatus } from '../model/provider.types';
import { PROVIDERS } from '../model/registry';
import { supabase } from '../../../../services/supabase';

// 두 백엔드를 같은 인터페이스로 감싼다:
//  - 개발: vite 브리지(/api/providers/*) — 자격증명은 .analysis/providers.local.json,
//    구독 OAuth(loopback) 지원.
//  - 배포: 자격증명은 사용자 계정(Supabase kb_user_providers, RLS 본인 전용)에 저장하고,
//    모델 목록은 서버리스(/api/kb-analysis)가 사용자 키로 대신 조회(BYOK).
//    구독 OAuth는 콜백이 localhost 전용이라 배포에서는 미지원.
const DEV = import.meta.env.DEV;

const BASE = '/api/providers';

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`프로바이더 요청 실패 (${res.status}) ${msg}`);
  }
  return (await res.json()) as T;
}

// ── 배포 경로 공용: 로그인 세션 ─────────────────────────────
async function requireSession(): Promise<{ userId: string; accessToken: string }> {
  if (!supabase) throw new Error('Supabase가 설정되지 않았습니다.');
  const { data } = await supabase.auth.getSession();
  const s = data.session;
  if (!s) throw new Error('로그인 후 사용할 수 있습니다.');
  return { userId: s.user.id, accessToken: s.access_token };
}

export async function fetchProviders(): Promise<ProviderStatus[]> {
  if (DEV) {
    return jsonOrThrow<ProviderStatus[]>(await fetch(BASE, { headers: { Accept: 'application/json' } }));
  }
  // 배포: 본인 자격증명 행 → 연결 상태. 비로그인/미설정이면 전부 미연결.
  const base = PROVIDERS.map(p => ({ id: p.id, connected: false as boolean, method: undefined as AuthMethod | undefined }));
  if (!supabase) return base;
  const { data: sess } = await supabase.auth.getSession();
  if (!sess.session) return base;
  const { data, error } = await supabase
    .from('kb_user_providers')
    .select('provider_id, credential')
    .eq('user_id', sess.session.user.id);
  if (error) throw new Error(`연결 상태 조회 실패: ${error.message}`);
  const byId = new Map((data ?? []).map(r => [r.provider_id as string, r.credential as { method?: AuthMethod }]));
  return base.map(p => {
    const cred = byId.get(p.id);
    return cred ? { id: p.id, connected: true, method: cred.method } : p;
  });
}

export async function fetchModels(id: string, force = false): Promise<ModelInfo[]> {
  if (DEV) {
    const q = force ? '?refresh=1' : '';
    return jsonOrThrow<ModelInfo[]>(await fetch(`${BASE}/${id}/models${q}`, { headers: { Accept: 'application/json' } }));
  }
  const { accessToken } = await requireSession();
  const res = await fetch('/api/kb-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ action: 'models', provider: id }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `모델 목록 조회 실패 (${res.status})`);
  }
  return (await res.json()) as ModelInfo[];
}

async function saveCredential(id: string, credential: Record<string, unknown>): Promise<void> {
  if (DEV) {
    await jsonOrThrow<unknown>(
      await fetch(`${BASE}/${id}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credential),
      }),
    );
    return;
  }
  const { userId } = await requireSession();
  const { error } = await supabase!
    .from('kb_user_providers')
    .upsert({ user_id: userId, provider_id: id, credential, updated_at: new Date().toISOString() });
  if (error) throw new Error(`자격증명 저장 실패: ${error.message}`);
}

export async function saveApiKey(id: string, apiKey: string): Promise<void> {
  await saveCredential(id, { method: 'apiKey', apiKey });
}

export async function saveSessionToken(id: string, token: string): Promise<void> {
  await saveCredential(id, { method: 'subscription', token });
}

export async function startOAuth(id: string): Promise<{ authUrl: string; state?: string }> {
  if (!DEV) throw new Error('구독 OAuth 로그인은 로컬 앱 전용입니다. 배포 환경에서는 API 키를 사용해 주세요.');
  return jsonOrThrow<{ authUrl: string; state?: string }>(await fetch(`${BASE}/${id}/oauth/start`));
}

export async function exchangeOAuthCode(id: string, state: string, code: string): Promise<void> {
  if (!DEV) throw new Error('구독 OAuth 로그인은 로컬 앱 전용입니다.');
  await jsonOrThrow<unknown>(
    await fetch(`${BASE}/${id}/oauth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, code }),
    }),
  );
}

export async function disconnect(id: string): Promise<void> {
  if (DEV) {
    await jsonOrThrow<unknown>(await fetch(`${BASE}/${id}/credentials`, { method: 'DELETE' }));
    return;
  }
  const { userId } = await requireSession();
  const { error } = await supabase!
    .from('kb_user_providers')
    .delete()
    .eq('user_id', userId)
    .eq('provider_id', id);
  if (error) throw new Error(`연결 해제 실패: ${error.message}`);
}
