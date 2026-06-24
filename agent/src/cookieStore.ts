import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

interface Store {
  cookie: string;
  bearer: string;
  loginDate: string | null;
}

let store: Store = { cookie: '', bearer: '', loginDate: null };

export const REQUIRED_NAVER_COOKIE_NAMES = ['NID_AUT', 'NID_SES'] as const;

export function hasRequiredNaverCookies(cookie: string): boolean {
  const names = new Set(
    cookie
      .split(';')
      .map((part) => part.trim().split('=')[0])
      .filter(Boolean),
  );
  return REQUIRED_NAVER_COOKIE_NAMES.every((name) => names.has(name));
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'naver-cookies.json');
}

function persist(): void {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    // read-only fs 또는 아직 ready 전 — 무시
  }
}

export function loadCookies(): void {
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8');
    const data = JSON.parse(raw) as Partial<Store>;
    store = {
      cookie: data.cookie ?? '',
      bearer: data.bearer ?? '',
      loginDate: data.loginDate ?? null,
    };
  } catch {
    // 파일 없음 또는 파싱 실패 — 새로 시작
  }
}

export function setCookie(cookie: string): void {
  store = { ...store, cookie, loginDate: new Date().toISOString() };
  persist();
}

export function setBearer(bearer: string): void {
  store = { ...store, bearer };
  persist();
}

export function getCookie(): string {
  return store.cookie;
}

export function getBearer(): string {
  return store.bearer;
}

export function hasCookies(): boolean {
  return hasRequiredNaverCookies(store.cookie);
}

export function getLoginDate(): string | null {
  return store.loginDate;
}

export function clearAll(): void {
  store = { cookie: '', bearer: '', loginDate: null };
  persist();
}
