// 배포 환경 자격증명 보관 — "이번만 사용"(sessionStorage) 경로.
//
// 두 가지 저장 위치를 사용자가 고른다:
//   - session: 이 브라우저 탭에만 보관(sessionStorage). 탭을 닫으면 사라지고 서버엔 없음.
//     분석/모델 요청 시 매번 이 자격증명을 body로 서버리스에 실어 보낸다(서버 무저장).
//   - account: Supabase kb_user_providers 에 저장(기기 간 공유). provider.api 가 처리.
//
// 이 모듈은 session 경로만 담당한다. localStorage 가 아닌 sessionStorage 를 쓰는 이유:
// 키를 디스크에 영속하지 않아 "1회성" 의도에 맞고, 새 탭/재방문 시 자동으로 잊힌다.

export type StorageMode = 'session' | 'account';

export interface LocalCredential {
  method: 'apiKey' | 'subscription';
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
}

const CRED_PREFIX = 'kb-cred:'; // sessionStorage 키 접두사
const MODE_KEY = 'kb-cred-mode'; // 저장 위치 선호(localStorage — 선호 자체는 비밀 아님)

const ss = (): Storage | null => (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
const ls = (): Storage | null => (typeof localStorage !== 'undefined' ? localStorage : null);

// 저장 위치 선호 — 기본 'session'(이번만 사용). 사용자가 UI에서 바꾼다.
export function getStorageMode(): StorageMode {
  return ls()?.getItem(MODE_KEY) === 'account' ? 'account' : 'session';
}
export function setStorageMode(mode: StorageMode): void {
  ls()?.setItem(MODE_KEY, mode);
}

export function getLocalCredential(providerId: string): LocalCredential | null {
  const raw = ss()?.getItem(CRED_PREFIX + providerId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LocalCredential;
  } catch {
    return null;
  }
}

export function setLocalCredential(providerId: string, cred: LocalCredential): void {
  ss()?.setItem(CRED_PREFIX + providerId, JSON.stringify(cred));
}

export function removeLocalCredential(providerId: string): void {
  ss()?.removeItem(CRED_PREFIX + providerId);
}

export function localConnectedIds(): string[] {
  const s = ss();
  if (!s) return [];
  const ids: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k?.startsWith(CRED_PREFIX)) ids.push(k.slice(CRED_PREFIX.length));
  }
  return ids;
}
