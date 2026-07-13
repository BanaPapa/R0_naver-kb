// 브라우저 확장(Estate-OS 커넥터) 연동 계층.
//
// 기존에는 로컬 Electron 에이전트(http://127.0.0.1:47328)에 HTTP로 붙었으나,
// 이제 브라우저 확장에 postMessage RPC로 붙는다. 함수 시그니처는 useAgentStatus
// 훅과의 호환을 위해 최대한 유지한다.

import { callExtension, detectExtension } from './extensionBridge';

// 크롬 웹스토어 설치 페이지 (게시 완료 — 확장 상세 페이지로 바로 이동).
// 확장 ID: gpaicndndkdkljpocmoiohgahofbdhpi ("Estate-OS 커넥터")
// 필요 시 VITE_EXTENSION_STORE_URL 환경변수로 오버라이드 가능.
export const EXTENSION_STORE_URL =
  (import.meta.env.VITE_EXTENSION_STORE_URL as string | undefined) ??
  'https://chromewebstore.google.com/detail/estate-os-%EB%A7%A4%EB%AC%BC%EC%8B%9C%EC%84%B8-%EC%97%B0%EA%B2%B0%EA%B8%B0/gpaicndndkdkljpocmoiohgahofbdhpi';

export type AgentStatus = 'unknown' | 'running' | 'offline';

export async function pingAgent(): Promise<AgentStatus> {
  const present = await detectExtension();
  return present ? 'running' : 'offline';
}

// ── 크롤 토큰 (Vercel /api/crawl-token — 라이선스 게이트, 변경 없음) ──────────
interface TokenCache {
  token: string;
  expiresAt: number; // ms
}

let tokenCache: TokenCache | null = null;

// 토큰 만료 60초 전에 갱신 (10분 토큰 → 9분 이내 재사용)
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export function getCachedCrawlToken(): string | null {
  if (!tokenCache) return null;
  if (Date.now() >= tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    tokenCache = null;
    return null;
  }
  return tokenCache.token;
}

export async function fetchCrawlToken(supabaseAccessToken: string): Promise<string> {
  const cached = getCachedCrawlToken();
  if (cached) return cached;

  const res = await fetch('/api/crawl-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${supabaseAccessToken}`,
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `crawl-token 발급 실패: ${res.status}`);
  }

  const data = (await res.json()) as { token: string; expiresIn: number };
  tokenCache = {
    token: data.token,
    expiresAt: Date.now() + data.expiresIn * 1000,
  };
  return data.token;
}

export function clearCrawlToken(): void {
  tokenCache = null;
}

// ── 네이버 로그인 상태 ──────────────────────────────────────

export interface CookieStatus {
  hasCookies: boolean;
  hasBearer: boolean;
  loginDate: string | null;
}

export async function getCookieStatus(): Promise<CookieStatus> {
  try {
    const res = await callExtension<{ loggedIn?: boolean; hasBearer?: boolean }>(
      'STATUS',
      undefined,
      3000,
    );
    return {
      hasCookies: !!res?.loggedIn,
      hasBearer: !!res?.hasBearer,
      loginDate: null,
    };
  } catch {
    return { hasCookies: false, hasBearer: false, loginDate: null };
  }
}

// ── 연결 유효성 검증 ────────────────────────────────────────
// 중요: 429(rate limit)는 "쿠키 만료"가 아니다. 재로그인으로 안 풀린다.
// 401/403(expired)과 429(rate-limited)를 반드시 구분해 호출부가 올바르게 안내하게 한다.

export type ValidateReason = 'expired' | 'rate-limited' | 'no-login' | 'unknown';
export type ValidateResult = { valid: true } | { valid: false; reason: ValidateReason };

export async function validateConnection(): Promise<ValidateResult> {
  try {
    const res = await callExtension<{ status?: number; body?: string }>(
      'NAVER_FETCH',
      {
        base: 'fin',
        path: '/search/autocomplete/complexes',
        method: 'GET',
        query: { keyword: '강남', size: 1, page: 0 },
      },
      9000,
    );
    const status = res?.status ?? 0;
    if (status >= 200 && status < 300) return { valid: true };
    if (status === 401 || status === 403) return { valid: false, reason: 'expired' };
    if (status === 429) return { valid: false, reason: 'rate-limited' };
    // 그 외 상태(5xx, 네트워크 등)는 불확정 — 오탐으로 검색을 막지 않는다.
    return { valid: true };
  } catch {
    // 확장 오류/타임아웃 — 불확정 처리(오탐 방지)
    return { valid: true };
  }
}

// 네이버 로그인 탭을 열고 사용자가 로그인 완료할 때까지 대기.
export async function startNaverLogin(): Promise<void> {
  const res = await callExtension<{ loggedIn?: boolean; error?: string }>(
    'OPEN_LOGIN',
    undefined,
    190_000,
  );
  if (!res?.loggedIn) {
    throw new Error(res?.error ?? '로그인이 완료되지 않았습니다. 다시 시도해 주세요.');
  }
}
