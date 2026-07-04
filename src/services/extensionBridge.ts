// 웹앱 ↔ 브라우저 확장(content-bridge.js) 사이의 postMessage RPC.
//
// 확장이 설치되어 있으면 content script가 페이지에 주입되어 이 메시지를 받아
// 백그라운드로 전달하고, 백그라운드가 네이버를 호출(주거 IP)한 결과를 돌려준다.
// 확장이 없으면 PING이 타임아웃되어 호출부가 폴백(dev 프록시)을 선택한다.

const PAGE_SOURCE = 'eos-page';
const EXT_SOURCE = 'eos-ext';

interface Pending {
  resolve: (v: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let listenerAttached = false;

function ensureListener(): void {
  if (listenerAttached) return;
  listenerAttached = true;
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string; id?: string; result?: unknown } | null;
    if (!data || data.source !== EXT_SOURCE || typeof data.id !== 'string') return;
    if (data.id === 'ready') return; // 확장 로드 신호 — 무시(감지는 PING으로)
    const p = pending.get(data.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(data.id);
    p.resolve(data.result);
  });
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function callExtension<T = unknown>(
  kind: string,
  payload?: unknown,
  timeoutMs = 30000,
): Promise<T> {
  ensureListener();
  return new Promise<T>((resolve, reject) => {
    const id = newId();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('확장 응답 시간 초과'));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, timer });
    window.postMessage({ source: PAGE_SOURCE, id, kind, payload }, window.location.origin);
  });
}

// 확장 설치·활성 여부 감지 (짧은 타임아웃 PING).
export async function detectExtension(): Promise<boolean> {
  try {
    const res = await callExtension<{ ok?: boolean }>('PING', undefined, 1500);
    return !!res?.ok;
  } catch {
    return false;
  }
}
