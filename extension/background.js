// Estate-OS 커넥터 — 백그라운드 서비스워커
//
// 역할: 웹앱(content-bridge 경유)의 요청을 받아 네이버 fin.land/new.land를
// 사용자 브라우저(주거 IP)에서 직접 호출하고 JSON을 돌려준다.
// 브라우저의 네이버 세션 쿠키는 host_permissions 덕분에 fetch에 자동 포함된다.

const VERSION = '2.2.0';
const FIN_LAND_BASE = 'https://fin.land.naver.com/front-api/v1';
const NEW_LAND_BASE = 'https://new.land.naver.com';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// 설치/업데이트 즉시 "원스톱 재연결"을 처리한다:
//   1) 이미 열려 있는 Estate-OS 앱 탭을 새로고침 (설치 시 기존 탭엔 content script가
//      자동 주입되지 않으므로, 사용자가 F5를 누르지 않아도 재연결되게 한다)
//   2) 앱 탭으로 포커스를 되돌리고
//   3) 설치를 위해 열려 있던 이 확장의 웹스토어 탭을 자동으로 닫는다
// → 사용자는 웹스토어에서 "Chrome에 추가"만 하면 원래 앱 화면으로 자동 복귀한다.
// tabs 권한으로 동작(호스트 권한 불필요). chrome.runtime.id 로 내 확장 상세 탭만 골라 닫는다.
const APP_TAB_MATCHES = [
  'https://estate-os.xyz/*',
  'https://www.estate-os.xyz/*',
  'https://estate-os.vercel.app/*',
  'http://localhost:5173/*',
  'http://localhost:5174/*',
  'http://127.0.0.1:5173/*',
  'http://127.0.0.1:5174/*',
];

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  try {
    const appTabs = await chrome.tabs.query({ url: APP_TAB_MATCHES });
    if (appTabs.length === 0) return; // 열린 앱 탭이 없으면 아무것도 하지 않는다

    // 1) 앱 탭 새로고침(재연결)
    for (const t of appTabs) {
      if (t.id != null) chrome.tabs.reload(t.id).catch(() => {});
    }
    // 2) 앱 탭으로 포커스 복귀
    const target = appTabs[0];
    if (target.id != null) chrome.tabs.update(target.id, { active: true }).catch(() => {});
    if (target.windowId != null) chrome.windows.update(target.windowId, { focused: true }).catch(() => {});

    // 3) 설치로 열려 있던 이 확장의 웹스토어 탭만 닫는다(업데이트 시엔 스토어 탭이 없음)
    if (details.reason === 'install') {
      const storeTabs = await chrome.tabs.query({ url: 'https://chromewebstore.google.com/detail/*' });
      for (const t of storeTabs) {
        if (t.id != null && t.url && t.url.includes(chrome.runtime.id)) {
          chrome.tabs.remove(t.id).catch(() => {});
        }
      }
    }
  } catch (_) {
    // 탭 조작 실패는 무시 — 사용자는 "연결 재시도"(F5)로 폴백 가능
  }
});

// new.land /api/articles 는 Bearer JWT 필수(로그인 자격증명이 아니라 네이버 프론트가
// 발급하는 ~3시간짜리 HS256 토큰). webRequest로 new.land SPA의 요청 헤더에서 가로챈다.
let bearerToken = '';
let bearerCaptureInflight = null; // 동시 캡처 중복(탭 여러 개) 방지

// JWT payload의 exp(초)→ms. 실패 시 0(만료 판단 불가 → 유효로 취급).
function decodeJwtExpMs(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(part));
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function bearerValid(token) {
  if (!token) return false;
  const exp = decodeJwtExpMs(token);
  return exp === 0 || exp - Date.now() > 60_000; // 만료 60초 전까지 유효
}

function setBearer(token) {
  bearerToken = token;
  chrome.storage.session.set({ bearer: token }).catch(() => {});
}

// ── Bearer 캡처: new.land 요청의 Authorization 헤더를 관찰(read-only) ──────────
// extraHeaders를 지정해야 일부 크롬 버전에서 Authorization 헤더가 가려지지 않는다.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = details.requestHeaders || [];
    for (const h of headers) {
      if (h.name.toLowerCase() === 'authorization' && h.value && /^Bearer\s+/i.test(h.value)) {
        const t = h.value.replace(/^Bearer\s+/i, '').trim();
        if (t && t !== bearerToken) {
          setBearer(t);
          console.log('[Estate-OS] new.land Bearer 캡처됨');
        }
      }
    }
  },
  { urls: ['https://new.land.naver.com/*'] },
  ['requestHeaders', 'extraHeaders'],
);

async function loadBearer() {
  if (bearerValid(bearerToken)) return bearerToken;
  try {
    const { bearer } = await chrome.storage.session.get('bearer');
    if (bearer && bearerValid(bearer)) {
      bearerToken = bearer;
      return bearerToken;
    }
  } catch {
    // storage.session 미지원/오류 — 메모리 값만 사용
  }
  return bearerValid(bearerToken) ? bearerToken : '';
}

// 유효한 Bearer가 없으면 new.land를 백그라운드 탭으로 잠깐 열어 SPA가 토큰을 쓰게 유발한다.
// force=true면 캐시를 무시하고 강제 재캡처(만료·401 대응).
async function ensureBearer(force = false, maxWaitMs = 20_000) {
  if (!force) {
    const cached = await loadBearer();
    if (cached) return cached;
  } else {
    bearerToken = '';
  }
  if (bearerCaptureInflight) return bearerCaptureInflight;

  bearerCaptureInflight = (async () => {
    let tab;
    try {
      // 지도 좌표를 주어 로드 즉시 /api/* 요청이 발생하도록 한다(토큰 유발).
      tab = await chrome.tabs.create({
        url: 'https://new.land.naver.com/houses?ms=37.5145,127.0495,16&a=APT:VL:DDDGG&e=RETAIL',
        active: false,
      });
    } catch {
      return '';
    }
    try {
      const deadline = Date.now() + maxWaitMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        if (bearerValid(bearerToken)) break;
      }
      return bearerValid(bearerToken) ? bearerToken : '';
    } finally {
      if (tab && tab.id != null) {
        try {
          await chrome.tabs.remove(tab.id);
        } catch {
          // 이미 닫힘
        }
      }
      bearerCaptureInflight = null;
    }
  })();

  return bearerCaptureInflight;
}

// ── 네이버 로그인 상태 ───────────────────────────────────────
async function hasNaverLogin() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: '.naver.com' });
    const names = new Set(cookies.map((c) => c.name));
    return names.has('NID_AUT') && names.has('NID_SES');
  } catch {
    return false;
  }
}

// 네이버 로그인 탭을 열고 쿠키가 생길 때까지 대기(최대 3분).
async function openNaverLogin() {
  const already = await hasNaverLogin();
  if (already) return { loggedIn: true };

  const loginUrl =
    'https://nid.naver.com/nidlogin.login?mode=form&url=https%3A%2F%2Fland.naver.com%2F';
  let tab;
  try {
    tab = await chrome.tabs.create({ url: loginUrl, active: true });
  } catch (e) {
    return { loggedIn: false, error: String(e) };
  }

  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    if (await hasNaverLogin()) {
      return { loggedIn: true };
    }
    // 사용자가 로그인 탭을 닫았는지 확인
    if (tab && tab.id != null) {
      try {
        await chrome.tabs.get(tab.id);
      } catch {
        break; // 탭이 닫힘
      }
    }
  }
  return { loggedIn: await hasNaverLogin() };
}

// ── 네이버 API 중계 ─────────────────────────────────────────
function buildUrl(base, path, query) {
  const targetBase = base === 'fin' ? FIN_LAND_BASE : NEW_LAND_BASE;
  const url = new URL(`${targetBase}${path}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// 참고: Referer/Origin/User-Agent/Sec-Fetch-*/Accept-Language 는 "forbidden headers"라
// 확장 fetch로는 설정해도 브라우저가 무시한다. new.land가 검사하는 Referer/Origin은
// declarativeNetRequest 규칙(rules.json)으로 네트워크 계층에서 강제 주입한다.
// 아래 헤더 지정은 무해하지만 실제 적용되는 건 Accept/Authorization 정도다.
function baseHeaders(base, referer) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': UA,
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
  if (base === 'fin') {
    headers.Referer = 'https://fin.land.naver.com/map';
    headers.Origin = 'https://fin.land.naver.com';
  } else {
    headers.Referer = referer || 'https://new.land.naver.com/houses';
    headers.Origin = 'https://new.land.naver.com';
  }
  return headers;
}

async function doFetch(base, path, method, query, body, headers) {
  const init = {
    method,
    headers,
    credentials: 'include', // 브라우저의 네이버 세션 쿠키 자동 포함
  };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  }
  const url = buildUrl(base, path, query);
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text };
}

async function naverFetch(payload) {
  const { base, path, method = 'GET', query, body, referer } = payload;
  const needsBearer = base === 'new' && path.startsWith('/api/articles');

  const headers = baseHeaders(base, referer);

  if (base === 'new') {
    // 빌라·단독 목록(/api/articles)은 Bearer 필수 → 없으면 캡처(탭 유발).
    // 그 외 new.land 엔드포인트는 있으면 쓰고 없어도 진행(쿠키만으로 동작).
    const t = needsBearer ? await ensureBearer() : await loadBearer();
    if (t) headers.Authorization = `Bearer ${t}`;
  }

  let result = await doFetch(base, path, method, query, body, headers);

  // 자가치유: /api/articles가 401/403이면 캐시 Bearer가 만료·무효일 수 있으므로
  // 강제 재캡처 후 딱 한 번 재시도한다. (429는 rate limit이라 재캡처 대상 아님)
  if (needsBearer && (result.status === 401 || result.status === 403)) {
    const fresh = await ensureBearer(true);
    if (fresh) {
      headers.Authorization = `Bearer ${fresh}`;
      result = await doFetch(base, path, method, query, body, headers);
    }
  }

  // 오류(비2xx)일 때만 진단 로그를 남긴다(정상 응답은 조용히, 데이터 노출 방지).
  if (result.status < 200 || result.status >= 300) {
    console.warn(
      `[Estate-OS] ${base} ${path} → ${result.status} | hasBearer=${!!headers.Authorization} | ${String(result.body).slice(0, 160)}`,
    );
  }

  return result;
}

// ── 호갱노노 리뷰 중계 (R7 Review) ──────────────────────────
// 리뷰 API는 로그인 세션 필수(익명 401). host_permissions 덕분에
// 사용자의 hogangnono.com 로그인 쿠키가 fetch에 자동 포함된다.
const HGNN_API = 'https://hogangnono.com/api';
// 호갱노노 JS 번들(v2.5.0.38)의 앱 레벨 정적 토큰
const HGNN_AT = 'B-7W6GsCNz-Bnrknn4UW7-kyG2TUs8gxwMpg';

function hgnnHeaders() {
  return {
    Accept: 'application/json',
    'x-hogangnono-api-version': '2.5.0',
    'x-hogangnono-app-name': 'hogangnono',
    'x-hogangnono-at': HGNN_AT,
    'x-hogangnono-ct': String(Date.now()),
    'x-hogangnono-platform': 'desktop',
    'x-hogangnono-release-version': '2.5.0.38',
  };
}

async function hgnnFetchReviewPage(aptId, page) {
  try {
    const res = await fetch(
      `${HGNN_API}/v2/apts/${encodeURIComponent(aptId)}/reviews?orderType=1&page=${page}`,
      { headers: hgnnHeaders(), credentials: 'include' },
    );
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'NOT_LOGGED_IN' };
    if (!res.ok) return { ok: false, error: `HTTP_${res.status}` };

    const data = await res.json().catch(() => null);
    if (!data) return { ok: false, error: 'PARSE_ERROR' };
    if (data.status === 'error') {
      const notLoggedIn = data.error === 'Unauthorized' || String(data.message).includes('로그인');
      return { ok: false, error: notLoggedIn ? 'NOT_LOGGED_IN' : data.message || 'API_ERROR' };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `NETWORK: ${e.message}` };
  }
}

// 로그인 필요 엔드포인트를 프로브로 사용(실존 단지 ID). 성공하면 로그인된 것.
async function hgnnLoggedIn() {
  const r = await hgnnFetchReviewPage('a2n36', 1);
  return r.ok;
}

// ── 메시지 라우터 ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.kind) {
        case 'PING':
          sendResponse({ ok: true, version: VERSION });
          break;
        case 'STATUS': {
          const loggedIn = await hasNaverLogin();
          const t = await loadBearer();
          sendResponse({ loggedIn, hasBearer: !!t });
          break;
        }
        case 'OPEN_LOGIN': {
          const result = await openNaverLogin();
          sendResponse(result);
          break;
        }
        case 'NAVER_FETCH': {
          const result = await naverFetch(msg.payload || {});
          sendResponse(result);
          break;
        }
        case 'HGNN_STATUS': {
          sendResponse({ loggedIn: await hgnnLoggedIn() });
          break;
        }
        case 'HGNN_FETCH_REVIEW_PAGE': {
          const { aptId, page } = msg.payload || {};
          if (!aptId) {
            sendResponse({ ok: false, error: 'MISSING_APT_ID' });
            break;
          }
          sendResponse(await hgnnFetchReviewPage(aptId, Number(page) || 1));
          break;
        }
        default:
          sendResponse({ error: 'unknown kind' });
      }
    } catch (err) {
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // 비동기 응답
});
