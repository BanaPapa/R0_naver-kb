import type { AuthMethod, ModelInfo, ProviderStatus } from '../model/provider.types';
import { PROVIDERS } from '../model/registry';
import { supabase } from '../../../../services/supabase';
import {
  getStorageMode,
  getLocalCredential,
  setLocalCredential,
  removeLocalCredential,
  localConnectedIds,
  type LocalCredential,
} from '../lib/local-credentials';

// 두 백엔드를 같은 인터페이스로 감싼다:
//  - 개발(DEV): vite 브리지(/api/providers/*) — 자격증명은 .analysis/providers.local.json,
//    구독은 loopback OAuth. 기존 동작 그대로.
//  - 배포(PROD): 저장 위치를 사용자가 고른다.
//      · session: sessionStorage(이번만) — 실행 시 매 요청에 자격증명 첨부(서버 무저장)
//      · account: Supabase kb_user_providers(RLS 본인 전용) — 서버가 조회
//    구독은 device-code(OpenAI)·oauth-code(xAI)를 서버리스(/api/kb-oauth)로 처리.
const DEV = import.meta.env.DEV;
const BASE = '/api/providers';

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`프로바이더 요청 실패 (${res.status}) ${msg}`);
  }
  return (await res.json()) as T;
}

async function accessTokenOrNull(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// 배포 실행 경로가 쓰는 세션 자격증명(있으면). analysis.api 가 chat 요청에 첨부한다.
export function sessionCredential(providerId: string): LocalCredential | null {
  if (DEV || getStorageMode() !== 'session') return null;
  return getLocalCredential(providerId);
}

export async function fetchProviders(): Promise<ProviderStatus[]> {
  if (DEV) {
    return jsonOrThrow<ProviderStatus[]>(await fetch(BASE, { headers: { Accept: 'application/json' } }));
  }
  const base = PROVIDERS.map(p => ({ id: p.id, connected: false as boolean, method: undefined as AuthMethod | undefined }));
  // session 모드: sessionStorage 연결 상태
  const localIds = new Set(localConnectedIds());
  // account 모드: Supabase 연결 상태(로그인 시)
  const token = await accessTokenOrNull();
  let accountMap = new Map<string, { method?: AuthMethod }>();
  if (token && supabase) {
    const { data, error } = await supabase.from('kb_user_providers').select('provider_id, credential');
    if (error) throw new Error(`연결 상태 조회 실패: ${error.message}`);
    accountMap = new Map((data ?? []).map(r => [r.provider_id as string, r.credential as { method?: AuthMethod }]));
  }
  return base.map(p => {
    const local = localIds.has(p.id) ? getLocalCredential(p.id) : null;
    if (local) return { id: p.id, connected: true, method: local.method };
    const acc = accountMap.get(p.id);
    return acc ? { id: p.id, connected: true, method: acc.method } : p;
  });
}

export async function fetchModels(id: string, force = false): Promise<ModelInfo[]> {
  if (DEV) {
    const q = force ? '?refresh=1' : '';
    return jsonOrThrow<ModelInfo[]>(await fetch(`${BASE}/${id}/models${q}`, { headers: { Accept: 'application/json' } }));
  }
  const token = await accessTokenOrNull();
  const local = getStorageMode() === 'session' ? getLocalCredential(id) : null;
  const res = await fetch('/api/kb-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action: 'models', provider: id, ...(local ? { credential: local } : {}) }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `모델 목록 조회 실패 (${res.status})`);
  }
  return (await res.json()) as ModelInfo[];
}

async function saveCredential(id: string, credential: LocalCredential): Promise<void> {
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
  if (getStorageMode() === 'session') {
    setLocalCredential(id, credential);
    return;
  }
  if (!supabase) throw new Error('Supabase가 설정되지 않았습니다.');
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('계정 저장을 하려면 로그인이 필요합니다.');
  const { error } = await supabase
    .from('kb_user_providers')
    .upsert({ user_id: data.session.user.id, provider_id: id, credential, updated_at: new Date().toISOString() });
  if (error) throw new Error(`자격증명 저장 실패: ${error.message}`);
}

export async function saveApiKey(id: string, apiKey: string): Promise<void> {
  await saveCredential(id, { method: 'apiKey', apiKey });
}

export async function saveSessionToken(id: string, token: string): Promise<void> {
  await saveCredential(id, { method: 'subscription', accessToken: token });
}

// ── 구독 OAuth (개발: vite 브리지 / 배포: 서버리스 device-code·oauth-code) ──

export interface DeviceStart {
  state: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
}

// device-code 시작 (OpenAI). 배포 전용 — 개발은 loopback(startOAuth)을 쓴다.
export async function startDeviceCode(id: string): Promise<DeviceStart> {
  const body = await postOAuth({ action: 'device-start', provider: id });
  return body as unknown as DeviceStart;
}

// device-code 승인 폴링. pending이면 { pending:true }, 완료면 저장까지 끝난 뒤 { pending:false }.
export async function pollDeviceCode(id: string, state: string): Promise<{ pending: boolean }> {
  const body = await postOAuth({ action: 'device-poll', provider: id, state });
  if ((body as { pending?: boolean }).pending) return { pending: true };
  await persistOAuthResult(id, body);
  return { pending: false };
}

export async function startOAuth(id: string): Promise<{ authUrl: string; state?: string }> {
  if (DEV) return jsonOrThrow<{ authUrl: string; state?: string }>(await fetch(`${BASE}/${id}/oauth/start`));
  const body = await postOAuth({ action: 'oauth-start', provider: id });
  return body as unknown as { authUrl: string; state?: string };
}

export async function exchangeOAuthCode(id: string, state: string, code: string): Promise<void> {
  if (DEV) {
    await jsonOrThrow<unknown>(
      await fetch(`${BASE}/${id}/oauth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, code }),
      }),
    );
    return;
  }
  const body = await postOAuth({ action: 'oauth-exchange', provider: id, state, code });
  await persistOAuthResult(id, body);
}

// 서버리스 OAuth 공통 POST — storageMode·access token 첨부.
async function postOAuth(payload: Record<string, unknown>): Promise<unknown> {
  const token = await accessTokenOrNull();
  const res = await fetch('/api/kb-oauth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    credentials: 'same-origin', // PKCE/device 서명 쿠키 왕복
    body: JSON.stringify({ ...payload, storageMode: getStorageMode() }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `구독 인증 실패 (${res.status})`);
  return body;
}

// 서버리스가 session 모드에서 { credential }을 반환하면 sessionStorage에 보관.
// account 모드면 서버가 이미 Supabase에 저장했으므로 할 일 없음.
async function persistOAuthResult(id: string, body: unknown): Promise<void> {
  const b = body as { stored?: string; credential?: LocalCredential };
  if (b.stored === 'session' && b.credential) setLocalCredential(id, b.credential);
}

export async function disconnect(id: string): Promise<void> {
  if (DEV) {
    await jsonOrThrow<unknown>(await fetch(`${BASE}/${id}/credentials`, { method: 'DELETE' }));
    return;
  }
  removeLocalCredential(id); // session 흔적 제거
  const token = await accessTokenOrNull();
  if (token && supabase) {
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      await supabase.from('kb_user_providers').delete().eq('user_id', data.session.user.id).eq('provider_id', id);
    }
  }
}
