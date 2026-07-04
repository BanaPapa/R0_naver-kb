// Vercel Serverless Function — 배포 환경 구독(OAuth) 인증.
//
// 팝업/콜백이 필요 없는 두 흐름만 지원(로컬 콜백 불가한 배포에서 작동):
//   - device-code (OpenAI Codex): 1회용 코드 발급 → 사용자가 승인 페이지에서 승인 → 폴링 교환
//   - oauth-code (xAI): 동의 화면이 코드 표시 → 사용자가 복사·붙여넣기 → PKCE 교환
//
// PKCE verifier/state 는 서버리스 인스턴스 간 메모리 공유가 안 되므로 HMAC 서명 쿠키로 왕복한다.
// 교환된 토큰은 저장 위치(storageMode)에 따라:
//   - 'account': 사용자 JWT로 kb_user_providers 에 upsert(RLS 본인 전용)
//   - 'session': 응답으로 반환 → 클라이언트가 sessionStorage 에 보관(서버 무저장)
//
// ⚠️ self-contained(상대경로 import 0개) — api/crawl-token.ts 주석 참고.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, createHash, randomBytes } from 'crypto';

// ── 프로바이더 구독 설정 (registry.ts 의 서버 사본) ──
interface SubCfg {
  kind: 'device-code' | 'oauth-code';
  clientId: string;
  tokenUrl: string;
  issuer?: string;
  deviceUserCodeUrl?: string;
  deviceTokenUrl?: string;
  verificationUrl?: string;
  authorizeUrl?: string;
  redirectUri?: string;
  scopes?: string[];
  extraAuthParams?: Record<string, string>;
}
const SUBS: Record<string, SubCfg> = {
  openai: {
    kind: 'device-code',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    issuer: 'https://auth.openai.com',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    deviceUserCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
    deviceTokenUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
    verificationUrl: 'https://auth.openai.com/codex/device',
  },
  xai: {
    kind: 'oauth-code',
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    authorizeUrl: 'https://accounts.x.ai/oauth2/consent',
    tokenUrl: 'https://auth.x.ai/oauth2/token',
    redirectUri: 'http://127.0.0.1:56121/callback',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'grok-cli:access', 'api:access'],
    extraAuthParams: { referrer: 'hermes-agent', plan: 'generic' },
  },
};

const SECRET = process.env.OAUTH_SECRET ?? process.env.CRAWL_TOKEN_SECRET ?? 'kb-oauth-default';
const b64url = (b: Buffer) => b.toString('base64url');
const hmac = (data: string) => createHmac('sha256', SECRET).update(data).digest('base64url');

function sign(obj: unknown): string {
  const data = b64url(Buffer.from(JSON.stringify(obj)));
  return `${data}.${hmac(data)}`;
}
function unsign<T>(token: string | undefined): T | null {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const data = token.slice(0, i);
  if (token.slice(i + 1) !== hmac(data)) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString()) as T;
  } catch {
    return null;
  }
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}
function expiryFromJwt(token: string): number | undefined {
  const [, p] = token.split('.');
  if (!p) return undefined;
  try {
    const d = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return typeof d.exp === 'number' ? d.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
function extractChatGptAccountId(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  const seg = idToken.split('.');
  if (seg.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(seg[1]!, 'base64url').toString()) as Record<string, unknown>;
    const auth = payload['https://api.openai.com/auth'] as { chatgpt_account_id?: string } | undefined;
    return auth?.chatgpt_account_id ?? (payload.chatgpt_account_id as string | undefined);
  } catch {
    return undefined;
  }
}

interface Cred {
  method: 'subscription';
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
}

// 계정 저장 모드: 사용자 JWT로 검증 후 본인 행 upsert(RLS).
async function saveToAccount(accessToken: string, providerId: string, cred: Cred): Promise<void> {
  const url = process.env.VITE_SUPABASE_URL;
  const anon = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('Supabase 환경변수 미설정');
  const res = await fetch(`${url}/rest/v1/kb_user_providers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: anon,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ provider_id: providerId, credential: cred, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`계정 저장 실패 (${res.status}) ${await res.text().catch(() => '')}`);
}

// ── device-code (OpenAI) ─────────────────────────────────────
async function deviceStart(cfg: SubCfg) {
  const res = await fetch(cfg.deviceUserCodeUrl!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId }),
  });
  const j = await readJson<{ device_auth_id?: string; user_code?: string; usercode?: string; interval?: number }>(res);
  const userCode = j.user_code ?? j.usercode;
  if (!res.ok || !j.device_auth_id || !userCode) throw new Error(`장치 코드 요청 실패 (${res.status})`);
  return { deviceAuthId: j.device_auth_id, userCode, verificationUrl: cfg.verificationUrl!, interval: j.interval && j.interval > 0 ? j.interval : 5 };
}

async function deviceExchange(cfg: SubCfg, deviceAuthId: string, userCode: string): Promise<{ pending: true } | { pending: false; cred: Cred }> {
  const poll = await fetch(cfg.deviceTokenUrl!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  });
  if (poll.status === 403 || poll.status === 404) return { pending: true };
  const c = await readJson<{ authorization_code?: string; code_verifier?: string }>(poll);
  if (!poll.ok || !c.authorization_code || !c.code_verifier) throw new Error(`장치 인증 확인 실패 (${poll.status})`);
  const issuer = (cfg.issuer ?? 'https://auth.openai.com').replace(/\/$/, '');
  const tokRes = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: c.authorization_code,
      redirect_uri: `${issuer}/deviceauth/callback`,
      client_id: cfg.clientId,
      code_verifier: c.code_verifier,
    }).toString(),
  });
  const tok = await readJson<{ access_token?: string; refresh_token?: string; id_token?: string }>(tokRes);
  if (!tokRes.ok || !tok.access_token) throw new Error(`토큰 교환 실패 (${tokRes.status})`);
  return {
    pending: false,
    cred: {
      method: 'subscription',
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: expiryFromJwt(tok.access_token),
      accountId: extractChatGptAccountId(tok.id_token),
    },
  };
}

// ── oauth-code (xAI): authorize URL 생성 + 코드 붙여넣기 교환 ──
function oauthAuthorizeUrl(cfg: SubCfg, state: string, verifier: string): string {
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri ?? '',
    scope: (cfg.scopes ?? []).join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(cfg.extraAuthParams ?? {}),
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}
async function oauthCodeExchange(cfg: SubCfg, verifier: string, code: string): Promise<Cred> {
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri ?? '',
      code_verifier: verifier,
      code_challenge_method: 'S256',
    }).toString(),
  });
  const tok = await readJson<{ access_token?: string; refresh_token?: string; expires_in?: number }>(res);
  if (!res.ok || !tok.access_token) throw new Error(`토큰 교환 실패 (${res.status}). 코드가 만료됐거나 잘못됐습니다.`);
  return {
    method: 'subscription',
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined,
  };
}

// account 모드에서만 사용자 세션 필요. session 모드는 로그인과 무관하게 토큰만 반환.
function bearerOf(req: VercelRequest): string {
  return (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST만 지원합니다.' });
    return;
  }
  const { action, provider, storageMode, state, code, session } = (req.body ?? {}) as Record<string, string | undefined>;
  const cfg = provider ? SUBS[provider] : undefined;
  if (!cfg) {
    res.status(400).json({ error: `구독 인증을 지원하지 않는 프로바이더: ${provider}` });
    return;
  }
  const secure = (req.headers['x-forwarded-proto'] ?? '').includes('https');
  const cookieOpts = `HttpOnly; Path=/; Max-Age=900; SameSite=Lax${secure ? '; Secure' : ''}`;

  try {
    // 교환 성공 시 저장 위치 처리 후 응답 형태 결정.
    const finish = async (cred: Cred) => {
      if (storageMode === 'account') {
        await saveToAccount(bearerOf(req), provider!, cred);
        res.status(200).json({ ok: true, stored: 'account' });
      } else {
        res.status(200).json({ ok: true, stored: 'session', credential: cred }); // 클라이언트가 sessionStorage 보관
      }
    };

    if (action === 'device-start') {
      const s = await deviceStart(cfg);
      const st = b64url(randomBytes(12));
      res.setHeader('Set-Cookie', `kb_dev=${sign({ provider, deviceAuthId: s.deviceAuthId, userCode: s.userCode, state: st })}; ${cookieOpts}`);
      res.status(200).json({ state: st, userCode: s.userCode, verificationUrl: s.verificationUrl, interval: s.interval });
      return;
    }

    if (action === 'device-poll') {
      const sess = unsign<{ provider: string; deviceAuthId: string; userCode: string; state: string }>(readCookie(req, 'kb_dev'));
      if (!sess || sess.provider !== provider || sess.state !== state) {
        res.status(400).json({ error: '인증 세션이 만료됐습니다. 다시 시도하세요.' });
        return;
      }
      const r = await deviceExchange(cfg, sess.deviceAuthId, sess.userCode);
      if (r.pending) {
        res.status(200).json({ pending: true });
        return;
      }
      await finish(r.cred);
      return;
    }

    if (action === 'oauth-start') {
      const verifier = b64url(randomBytes(48));
      const st = b64url(randomBytes(12));
      const authUrl = oauthAuthorizeUrl(cfg, st, verifier);
      res.setHeader('Set-Cookie', `kb_pkce=${sign({ provider, verifier, state: st })}; ${cookieOpts}`);
      res.status(200).json({ authUrl, state: st });
      return;
    }

    if (action === 'oauth-exchange') {
      const sess = unsign<{ provider: string; verifier: string; state: string }>(readCookie(req, 'kb_pkce'));
      if (!sess || sess.provider !== provider) {
        res.status(400).json({ error: '인증 세션이 만료됐습니다. 다시 시도하세요.' });
        return;
      }
      if (!code?.trim()) {
        res.status(400).json({ error: '코드가 비어 있습니다.' });
        return;
      }
      const cred = await oauthCodeExchange(cfg, sess.verifier, code.trim());
      await finish(cred);
      return;
    }

    res.status(400).json({ error: `알 수 없는 action: ${action}` });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : '구독 인증 실패' });
  }
  // session 파라미터는 예약(향후 refresh) — 미사용 경고 방지
  void session;
}

function readCookie(req: VercelRequest, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
