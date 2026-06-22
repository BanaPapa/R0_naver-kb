import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error — .mjs Node 모듈 (개발 서버 전용, 타입 선언 없음)
import { getNaverLandToken } from './server/naverTokenProvider.mjs';
import { issueCrawlToken } from './lib/crawlTokenCore';

// 로컬 개발용 /api/crawl-token 미들웨어.
// Vercel 서버리스 함수 api/crawl-token.ts는 vite dev에서 서빙되지 않으므로,
// 동일한 발급 로직(issueCrawlToken)을 dev 서버 미들웨어로 재현한다.
// 환경변수는 loadEnv로 읽은 값(CRAWL_TOKEN_SECRET 포함)을 주입받는다.
function crawlTokenDevApi(env: Record<string, string>) {
  return {
    name: 'crawl-token-dev-api',
    configureServer(server: { middlewares: { use: (path: string, fn: unknown) => void } }) {
      server.middlewares.use('/api/crawl-token', async (req: any, res: any, next: () => void) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Method Not Allowed' }));
          return;
        }
        try {
          const auth = req.headers['authorization'] ?? '';
          const accessToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
          const { status, body } = await issueCrawlToken(accessToken, {
            supabaseUrl: env.VITE_SUPABASE_URL,
            supabaseKey: env.VITE_SUPABASE_ANON_KEY,
            secret: env.CRAWL_TOKEN_SECRET,
          });
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        void next; // 응답을 직접 종료하므로 next 미호출
      });
    },
  };
}

// new.land /api/articles (빌라·단독) 는 Bearer 토큰 필수.
// 수동 토큰(x-naver-bearer)이 없으면 헤드리스 브라우저로 자동 발급해 주입한다.
// 프록시(proxyReq)보다 먼저 실행되도록 내부 미들웨어 설치 전에 등록한다.
function naverTokenInjector() {
  return {
    name: 'naver-token-injector',
    configureServer(server: { middlewares: { use: (path: string, fn: unknown) => void } }) {
      server.middlewares.use('/naver-new-api', async (req: any, _res: unknown, next: () => void) => {
        try {
          if (req.url?.startsWith('/api/articles') && !req.headers['x-naver-bearer']) {
            const cookie = req.headers['x-naver-cookie'];
            const cookieStr = Array.isArray(cookie) ? cookie[0] : cookie;
            if (cookieStr) {
              const token = await getNaverLandToken(cookieStr);
              if (token) req.headers['x-naver-bearer'] = token;
            }
          }
        } catch {
          // 토큰 발급 실패 시 토큰 없이 진행 → 네이버가 401, 기존 오류 처리로 안내
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // 접두사 없는 변수까지 모두 로드(CRAWL_TOKEN_SECRET 등). 세 번째 인자 '' = 전체.
  const env = loadEnv(mode, process.cwd(), '');
  return {
  plugins: [react(), naverTokenInjector(), crawlTokenDevApi(env)],
  server: {
    port: 5174,
    proxy: {
      '/naver-api': {
        target: 'https://fin.land.naver.com/front-api/v1',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/naver-api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const cookie = req.headers['x-naver-cookie'];
            if (cookie) {
              proxyReq.setHeader('Cookie', Array.isArray(cookie) ? cookie.join('; ') : cookie);
              proxyReq.removeHeader('x-naver-cookie');
            }
            proxyReq.setHeader('Host', 'fin.land.naver.com');
            proxyReq.setHeader('Origin', 'https://fin.land.naver.com');
            proxyReq.setHeader('Referer', 'https://fin.land.naver.com/map');
            proxyReq.setHeader('Accept-Language', 'ko-KR,ko;q=0.9');
            proxyReq.setHeader('Sec-Fetch-Site', 'same-origin');
            proxyReq.setHeader('Sec-Fetch-Mode', 'cors');
            proxyReq.setHeader('Sec-Fetch-Dest', 'empty');
            proxyReq.setHeader(
              'User-Agent',
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            );
          });
        },
      },
      '/naver-new-api': {
        target: 'https://new.land.naver.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/naver-new-api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const cookie = req.headers['x-naver-cookie'];
            if (cookie) {
              proxyReq.setHeader('Cookie', Array.isArray(cookie) ? cookie.join('; ') : cookie);
              proxyReq.removeHeader('x-naver-cookie');
            }
            // Bearer JWT — new.land.naver.com /api/articles 인증에 필요
            const bearer = req.headers['x-naver-bearer'];
            if (bearer) {
              proxyReq.setHeader('Authorization', `Bearer ${Array.isArray(bearer) ? bearer[0] : bearer}`);
              proxyReq.removeHeader('x-naver-bearer');
            }
            const referer = req.headers['x-naver-referer'];
            proxyReq.setHeader(
              'Referer',
              referer ? (Array.isArray(referer) ? referer[0] : referer) : 'https://new.land.naver.com/houses',
            );
            if (referer) proxyReq.removeHeader('x-naver-referer');
            proxyReq.setHeader('Host', 'new.land.naver.com');
            proxyReq.setHeader('Origin', 'https://new.land.naver.com');
            proxyReq.setHeader('Accept-Language', 'ko-KR,ko;q=0.9');
            proxyReq.setHeader('Sec-Fetch-Site', 'same-origin');
            proxyReq.setHeader('Sec-Fetch-Mode', 'cors');
            proxyReq.setHeader('Sec-Fetch-Dest', 'empty');
            proxyReq.setHeader(
              'User-Agent',
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            );
          });
        },
      },
    },
  },
  };
});
