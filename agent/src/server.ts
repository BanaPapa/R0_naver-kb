import express, { Request, Response, NextFunction } from 'express';
import { getCookie, getBearer, hasCookies, getLoginDate } from './cookieStore';
import { openNaverLoginWindow } from './naverLoginWindow';

const AGENT_PORT = 47328;
const FIN_LAND_BASE = 'https://fin.land.naver.com/front-api/v1';
const NEW_LAND_BASE = 'https://new.land.naver.com';
const ALLOWED_ORIGIN = 'https://estate-os.vercel.app';

const ALLOWED_ORIGINS = new Set([
  ALLOWED_ORIGIN,
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]);

function first(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

function applyCorsHeaders(req: Request, res: Response): void {
  const origin = req.headers.origin ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : ALLOWED_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Naver-Cookie, X-Naver-Bearer, X-Naver-Referer, X-Crawl-Token',
  );
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function verifyCrawlToken(req: Request, res: Response): boolean {
  const token = req.headers['x-crawl-token'];
  if (!token || (typeof token === 'string' && token.trim() === '')) {
    res.status(401).json({ error: '크롤 토큰이 없습니다. 웹앱에서 로그인 후 다시 시도해 주세요.' });
    return false;
  }
  return true;
}

async function proxyRequest(
  targetBase: string,
  subPath: string,
  req: Request,
  res: Response,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  try {
    const target = new URL(`${targetBase}/${subPath}`);
    for (const [key, value] of Object.entries(req.query)) {
      if (key === '__path') continue;
      target.searchParams.set(key, first(value as string | string[] | undefined));
    }

    // cookieStore 우선 → 없으면 웹앱이 헤더로 전달한 값 사용 (하위 호환)
    const storedCookie = getCookie();
    const storedBearer = getBearer();
    const cookie = storedCookie || first(req.headers['x-naver-cookie'] as string | string[] | undefined);
    const bearer = storedBearer || first(req.headers['x-naver-bearer'] as string | string[] | undefined);
    const referer = first(req.headers['x-naver-referer'] as string | string[] | undefined);

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      ...extraHeaders,
    };

    if (cookie) headers['Cookie'] = cookie;
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    if (referer) headers['Referer'] = referer;

    const init: RequestInit = { method: req.method, headers };
    if (req.method === 'POST') {
      headers['Content-Type'] = 'application/json';
      init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    }

    const naverRes = await fetch(target.toString(), init);
    const text = await naverRes.text();

    res.status(naverRes.status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(text);
  } catch (err) {
    const e = err as { message?: string; cause?: { code?: string; message?: string } };
    res.status(502).json({
      proxyError: e?.message ?? String(err),
      causeCode: e?.cause?.code,
      causeMessage: e?.cause?.message,
    });
  }
}

export function createServer(): express.Application {
  const app = express();

  app.use(express.json());
  app.use(express.text());

  app.options('*', (req: Request, res: Response) => {
    applyCorsHeaders(req, res);
    res.status(204).end();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    applyCorsHeaders(req, res);
    next();
  });

  // 에이전트 실행 여부 감지
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: '1.0.0', port: AGENT_PORT });
  });

  // 쿠키 로그인 상태 확인
  app.get('/cookie-status', (_req: Request, res: Response) => {
    res.json({ hasCookies: hasCookies(), hasBearer: getBearer() !== '', loginDate: getLoginDate() });
  });

  // 실제 Naver API 호출로 쿠키 유효성 검증
  // 401 = 토큰 만료, 그 외 오류 = 불확정(오탐 방지)
  app.get('/validate', async (_req: Request, res: Response) => {
    if (!hasCookies()) {
      res.json({ valid: false, reason: 'no-cookie' });
      return;
    }
    try {
      const r = await fetch(
        'https://fin.land.naver.com/front-api/v1/search/autocomplete/complexes?keyword=%EA%B0%95%EB%82%A8&size=1&page=0',
        {
          headers: {
            Cookie: getCookie(),
            Referer: 'https://fin.land.naver.com/map',
            Origin: 'https://fin.land.naver.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'ko-KR,ko;q=0.9',
          },
          signal: AbortSignal.timeout(6000),
        },
      );
      if (r.ok) {
        res.json({ valid: true });
      } else if (r.status === 401 || r.status === 403) {
        res.json({ valid: false, reason: 'cookie-expired' });
      } else if (r.status === 429) {
        res.json({ valid: false, reason: 'cookie-rejected-or-rate-limited' });
      } else {
        res.json({ valid: false, reason: `naver-status-${r.status}` });
      }
    } catch {
      // 네트워크 오류 등 — 오탐 방지를 위해 유효로 처리
      res.json({ valid: true, inconclusive: true });
    }
  });

  // 네이버 로그인 창 열기 (로그인 완료 또는 창 닫힘까지 대기)
  app.post('/naver-login', (_req: Request, res: Response) => {
    openNaverLoginWindow()
      .then(() => res.json({ success: true }))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: msg });
      });
  });

  // fin.land.naver.com 프록시
  app.all('/naver-api/*', (req: Request, res: Response) => {
    if (!verifyCrawlToken(req, res)) return;
    const subPath = (req.params as Record<string, string>)[0] ?? '';
    proxyRequest(FIN_LAND_BASE, subPath, req, res, {
      Referer: 'https://fin.land.naver.com/map',
      Origin: 'https://fin.land.naver.com',
    });
  });

  // new.land.naver.com 프록시
  app.all('/naver-new-api/*', (req: Request, res: Response) => {
    if (!verifyCrawlToken(req, res)) return;
    const subPath = (req.params as Record<string, string>)[0] ?? '';
    proxyRequest(NEW_LAND_BASE, subPath, req, res, {
      Referer: 'https://new.land.naver.com/houses',
      Origin: 'https://new.land.naver.com',
    });
  });

  return app;
}

export { AGENT_PORT };
