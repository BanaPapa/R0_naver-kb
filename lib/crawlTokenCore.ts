// 크롤 토큰 발급 공용 코어 — Vercel 서버리스 함수(api/crawl-token.ts)와
// 로컬 개발용 Vite 미들웨어(vite.config.ts)가 함께 사용한다.
//
// ⚠️ 이 파일은 반드시 `api/` 밖에 둔다.
//   Vercel은 `api/` 안의 `_` 접두 파일을 배포에서 제외(404)하는데, 과거 이 코어가
//   `api/_crawlTokenCore.ts` 에 있어 api/crawl-token.ts 가 런타임에 이 모듈을 찾지 못해
//   FUNCTION_INVOCATION_FAILED(맨 500)로 크래시했다. (참조: docs 디버그 기록)
//   api/ 밖의 일반 모듈은 esbuild 번들에 정상 포함되므로 안전하다.
// 의존성은 node 내장(crypto)과 전역 fetch뿐.
import { createHmac, timingSafeEqual } from 'crypto';

export const TOKEN_TTL_SECONDS = 600; // 10분

export function signToken(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function buildCrawlToken(userId: string, secret: string): string {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = JSON.stringify({ sub: userId, exp });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = signToken(b64, secret);
  return `${b64}.${sig}`;
}

export function verifyCrawlToken(token: string, secret: string): boolean {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expectedSig = signToken(b64, secret);
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) return false;
  } catch {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString()) as { exp?: number };
    return typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export interface IssueCrawlTokenEnv {
  supabaseUrl?: string;
  supabaseKey?: string;
  secret?: string;
}

export interface IssueCrawlTokenResult {
  status: number;
  body: Record<string, unknown>;
}

// Supabase 세션 검증 → 승인 상태 확인 → 단기 서명 토큰 발급.
// 결과를 { status, body }로 반환하여 호출측(서버리스/미들웨어)이 응답을 쓰도록 한다.
export async function issueCrawlToken(
  accessToken: string,
  env: IssueCrawlTokenEnv,
): Promise<IssueCrawlTokenResult> {
  if (!accessToken) {
    return { status: 401, body: { error: '인증 토큰이 없습니다.' } };
  }

  const { supabaseUrl, supabaseKey, secret } = env;
  if (!supabaseUrl || !supabaseKey) {
    return { status: 500, body: { error: 'Supabase 환경변수 미설정' } };
  }
  if (!secret) {
    return { status: 500, body: { error: 'CRAWL_TOKEN_SECRET 환경변수가 설정되지 않았습니다.' } };
  }

  try {
    // 1. 사용자 ID 조회 (access token 검증)
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: supabaseKey,
      },
    });

    if (!userRes.ok) {
      return { status: 401, body: { error: '유효하지 않은 세션입니다.' } };
    }

    const user = (await userRes.json()) as { id?: string };
    const userId = user?.id;
    if (!userId) {
      return { status: 401, body: { error: '사용자 정보를 가져올 수 없습니다.' } };
    }

    // 2. profiles 테이블에서 승인 상태 확인
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=status`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: supabaseKey,
          Accept: 'application/json',
        },
      },
    );

    if (!profileRes.ok) {
      return { status: 500, body: { error: '프로필 조회 실패' } };
    }

    const profiles = (await profileRes.json()) as Array<{ status?: string }>;
    const profile = profiles[0];

    if (profile?.status !== 'approved') {
      return { status: 403, body: { error: '승인된 사용자만 크롤 토큰을 발급받을 수 있습니다.' } };
    }

    // 3. 크롤 토큰 발급
    const token = buildCrawlToken(userId, secret);
    return { status: 200, body: { token, expiresIn: TOKEN_TTL_SECONDS } };
  } catch (err) {
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}
