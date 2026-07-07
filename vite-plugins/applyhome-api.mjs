import {
  searchApartments,
  streamSearch,
  getApartmentDetail,
} from '../lib/applyhome/handlers.mjs';

/**
 * 청약홈(지역별 청약현황 탭) API 개발 미들웨어 — R6_Apply 이식.
 * 크롤러가 Node(개발 서버)에서 돌므로 브라우저 CORS 문제가 없다.
 * 배포 환경은 api/apartments/* Vercel 함수가 동일한 lib/applyhome 핸들러를 사용한다.
 *
 * 호스트 조정: /api/apartments/* 만 처리하고 그 외 /api/* 는 next()로 넘긴다
 * (crawl-token 미들웨어·kbland 프록시 등 다른 /api 경로와 공존).
 */

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());
  const method = req.method || 'GET';

  // 스트리밍 검색(SSE) — 일반 검색보다 먼저 매칭해야 한다.
  if (path === '/api/apartments/search/stream' && method === 'GET') {
    await streamSearch(query, req, res);
    return true;
  }

  // 청약 검색 (라이브 크롤, 페이지네이션)
  if (path === '/api/apartments/search' && method === 'GET') {
    const { status, body } = await searchApartments(query);
    sendJson(res, status, body);
    return true;
  }

  // 단지 상세 — /api/apartments/:houseManageNo/detail
  const detailMatch = path.match(/^\/api\/apartments\/([^/]+)\/detail$/);
  if (detailMatch && method === 'GET') {
    const houseManageNo = decodeURIComponent(detailMatch[1]);
    const { status, body } = await getApartmentDetail(houseManageNo, query);
    sendJson(res, status, body);
    return true;
  }

  return false; // 담당 경로 아님 → 호출부가 next()
}

export function applyhomeApiPlugin() {
  return {
    name: 'applyhome-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/apartments/')) return next();
        handle(req, res)
          .then((handled) => {
            if (!handled) next();
          })
          .catch((error) => {
            if (!res.headersSent) {
              sendJson(res, 500, { error: 'Internal server error', message: error.message });
            } else {
              res.end();
            }
          });
      });
    },
  };
}

export default applyhomeApiPlugin;
