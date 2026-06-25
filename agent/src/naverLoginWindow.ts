import { BrowserWindow, session } from 'electron';
import type { Cookie, Session } from 'electron';
import { setCookie, setBearer, getBearer, hasRequiredNaverCookies } from './cookieStore';

const PARTITION = 'persist:naver';
const LOGIN_URL =
  'https://nid.naver.com/nidlogin.login?mode=form&url=https%3A%2F%2Fland.naver.com%2F';
const FIN_LAND_WARMUP_URL = 'https://fin.land.naver.com/map';
const NEW_LAND_WARMUP_URL = 'https://new.land.naver.com/houses';
const COOKIE_READY_MAX_WAIT_MS = 15_000;
const COOKIE_POLL_MS = 300;

const NAVER_COOKIE_URLS = [
  'https://nid.naver.com',
  'https://land.naver.com',
  'https://new.land.naver.com',
  'https://fin.land.naver.com',
];

// Bearer 캡처 폴링 간격
const BEARER_POLL_MS = 300;
// Bearer 캡처 최대 대기 시간 (10초) — new.land 콜드 로드 대비
const BEARER_MAX_WAIT_MS = 10_000;
// 전체 최대 대기 시간 (3분)
const MAX_WAIT_MS = 3 * 60 * 1000;

function mergeCookies(cookies: Cookie[]): string {
  const merged = new Map<string, string>();
  for (const cookie of cookies) {
    if (!cookie.name || !cookie.value) continue;
    merged.set(cookie.name, cookie.value);
  }
  return Array.from(merged.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function collectNaverCookieHeader(ses: Session): Promise<string> {
  const batches = await Promise.all([
    ses.cookies.get({ domain: '.naver.com' }),
    ...NAVER_COOKIE_URLS.map((url) => ses.cookies.get({ url })),
  ]);
  return mergeCookies(batches.flat());
}

async function waitForNaverCookieHeader(ses: Session): Promise<string> {
  const deadline = Date.now() + COOKIE_READY_MAX_WAIT_MS;
  let latest = '';

  while (Date.now() < deadline) {
    latest = await collectNaverCookieHeader(ses);
    if (hasRequiredNaverCookies(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, COOKIE_POLL_MS));
  }

  return latest;
}

async function warmFinLandSession(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  try {
    await win.loadURL(FIN_LAND_WARMUP_URL);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } catch {
    // Cookie polling below is the source of truth for login readiness.
  }
}

export async function openNaverLoginWindow(): Promise<void> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 480,
      height: 750,
      title: 'Estate-OS — 네이버 로그인',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: PARTITION,
      },
      autoHideMenuBar: true,
      resizable: false,
    });

    // Windows에서 트레이 앱이 창을 열면 OS 포커스 탈취 방지로 작업표시줄에서만 깜빡임.
    // setAlwaysOnTop(true) → 강제 전면 → focus → 이후 해제하는 표준 우회법.
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.show();
    win.focus();
    win.once('focus', () => {
      win.setAlwaysOnTop(false);
    });

    const ses = session.fromPartition(PARTITION);
    let loginDetected = false;
    let visitedLoginPage = false;
    setBearer('');
    // bearer 캡처 단계에서 창이 닫혔을 때 정리할 수 있도록 외부에서 참조 가능하게 저장
    let finishCapture: (() => void) | null = null;

    // new.land API 요청에서 Authorization 헤더 인터셉트 → Bearer 캡처
    ses.webRequest.onBeforeSendHeaders(
      { urls: ['https://new.land.naver.com/*'] },
      (details, callback) => {
        const auth =
          (details.requestHeaders['Authorization'] as string | undefined) ??
          (details.requestHeaders['authorization'] as string | undefined);
        if (auth?.startsWith('Bearer ')) {
          setBearer(auth.slice(7));
        }
        callback({ requestHeaders: details.requestHeaders });
      },
    );

    const finishLogin = async (): Promise<void> => {
      if (loginDetected) return;
      loginDetected = true;
      clearTimeout(maxTimer);

      // 쿠키 캡처
      await warmFinLandSession(win);
      const cookieStr = await waitForNaverCookieHeader(ses);
      if (!hasRequiredNaverCookies(cookieStr)) {
        if (!win.isDestroyed()) win.close();
        reject(new Error('네이버 로그인 쿠키가 아직 완성되지 않았습니다. 로그인 창에서 네이버 부동산 페이지가 열린 뒤 다시 시도해 주세요.'));
        return;
      }
      setCookie(cookieStr);

      // new.land로 이동해 Bearer 토큰 유발 (onBeforeSendHeaders 인터셉터가 캡처)
      if (!win.isDestroyed()) {
        win.loadURL(NEW_LAND_WARMUP_URL);
      }

      // Bearer가 실제로 캡처될 때까지 폴링 — 고정 타임아웃 2초 대신 최대 10초 대기
      // new.land 페이지가 콜드 로드일 때 API 호출이 2초를 넘는 경우가 있어서
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(bearerPoll);
        clearTimeout(bearerTimeout);
        finishCapture = null;
        collectNaverCookieHeader(ses)
          .then((latestCookieStr) => {
            if (hasRequiredNaverCookies(latestCookieStr)) setCookie(latestCookieStr);
          })
          .finally(() => {
            if (!win.isDestroyed()) win.close();
            resolve();
          });
      };

      finishCapture = finish; // closed 핸들러에서도 호출할 수 있도록 저장

      const bearerPoll = setInterval(() => {
        if (getBearer()) finish();
      }, BEARER_POLL_MS);

      const bearerTimeout = setTimeout(finish, BEARER_MAX_WAIT_MS);
    };

    // 로그인 감지: nid.naver.com → 다른 곳으로 이동 = 로그인 완료
    win.webContents.on('did-navigate', (_event, url) => {
      if (loginDetected) return;

      if (url.includes('nid.naver.com')) {
        visitedLoginPage = true;
        return;
      }

      // 로그인 페이지를 방문한 후 다른 도메인으로 이동 = 성공
      if (visitedLoginPage) {
        void finishLogin();
      }
    });

    win.on('closed', () => {
      clearTimeout(maxTimer);
      if (!loginDetected) {
        // 로그인 자체를 완료하지 않고 닫은 경우
        reject(new Error('로그인 창이 닫혔습니다. 로그인을 완료한 뒤 다시 시도해 주세요.'));
      } else if (finishCapture) {
        // 로그인은 됐지만 bearer 캡처 중에 창을 직접 닫은 경우
        // finish()를 호출해 타이머를 정리하고 resolve (bearer 없이도 계속 진행)
        finishCapture();
      }
    });

    // 최대 3분 타임아웃
    const maxTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.close();
      if (!loginDetected) {
        reject(new Error('로그인 시간이 초과되었습니다 (3분). 다시 시도해 주세요.'));
      }
    }, MAX_WAIT_MS);

    win.loadURL(LOGIN_URL);
  });
}
