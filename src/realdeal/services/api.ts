import { RegionCode } from '../types';

// =============================================
// 지역(법정동) 로딩 — KB Land 공개 API
// =============================================
// 이 엔드포인트는 커스텀 헤더 없는 단순 GET이라 CORS 허용(Access-Control-Allow-Origin이
// 요청 Origin을 그대로 반영) + 프리플라이트가 없어 브라우저에서 직접 호출이 가능하다.
const KB_BASE = 'https://api.kbland.kr/land-price/price/areaName';

// 지역 데이터는 사실상 고정값이므로 적극적으로 캐싱한다.
// - 메모리 캐시: 같은 세션 내 재선택은 네트워크 없이 즉시 응답
// - localStorage: 새로고침/재실행 후 첫 선택도 즉시 응답 (TTL 30일)
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'kbRegion:';

type RegionType = 'sido' | 'sigungu' | 'dong';

const memCache = new Map<string, RegionCode[]>();
const pending = new Map<string, Promise<RegionCode[]>>();

interface KBRawItem {
  대지역명: string;
  중지역명?: string;
  소지역명?: string;
  법정동코드: string;
}

function cacheKey(type: RegionType, code?: string): string {
  return `${type}:${code ?? ''}`;
}

function readPersisted(key: string): RegionCode[] | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t: number; d: RegionCode[] };
    if (!parsed?.d || Date.now() - parsed.t > CACHE_TTL_MS) return null;
    return parsed.d;
  } catch {
    return null;
  }
}

function writePersisted(key: string, data: RegionCode[]): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), d: data }));
  } catch {
    // localStorage 미지원/용량초과는 무시 (메모리 캐시로 동작)
  }
}

async function fetchRegions(type: RegionType, code?: string): Promise<RegionCode[]> {
  const params = new URLSearchParams();
  if (type !== 'sido' && code) {
    params.set('법정동코드', code);
  }
  const url = type !== 'sido' ? `${KB_BASE}?${params.toString()}` : KB_BASE;

  // 커스텀 헤더를 붙이지 않아야 CORS 프리플라이트가 발생하지 않는다 (단순 GET 유지).
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`KB Land API 오류: ${resp.status}`);
  }

  const json = await resp.json();
  if (json?.dataHeader?.resultCode && json.dataHeader.resultCode !== '10000') {
    throw new Error(`KB API Error: ${json.dataHeader?.message || 'Unknown error'}`);
  }
  const items: KBRawItem[] = json?.dataBody?.data ?? [];

  const seen = new Set<string>();
  const result: RegionCode[] = [];

  for (const item of items) {
    let name = '';
    let region_cd = '';
    if (type === 'sido') {
      name = (item.대지역명 || '').trim();
      region_cd = item.법정동코드.substring(0, 2);
    } else if (type === 'sigungu') {
      name = (item.중지역명 || '').trim();
      region_cd = item.법정동코드.substring(0, 5);
    } else {
      name = (item.소지역명 || '').trim();
      region_cd = item.법정동코드;
    }
    if (!seen.has(region_cd)) {
      seen.add(region_cd);
      result.push({ region_cd, locatadd_nm: name });
    }
  }

  return result;
}

/**
 * Fetch region list from KB Land API (캐시 + in-flight 중복제거 적용).
 * @param type 'sido' | 'sigungu' | 'dong'
 * @param code Parent region code (sigungu: 시/도 2자리, dong: 시/군/구 5자리)
 */
export const fetchRegionList = async (
  type: RegionType,
  code?: string
): Promise<RegionCode[]> => {
  const key = cacheKey(type, code);

  // 1) 메모리 캐시 — 즉시 응답
  const mem = memCache.get(key);
  if (mem) return mem;

  // 2) localStorage 캐시 — 즉시 응답 (메모리에도 승격)
  const persisted = readPersisted(key);
  if (persisted) {
    memCache.set(key, persisted);
    return persisted;
  }

  // 3) 동일 키 요청이 진행 중이면 그 Promise를 공유 (중복 호출 방지)
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const promise = fetchRegions(type, code)
    .then((data) => {
      memCache.set(key, data);
      writePersisted(key, data);
      return data;
    })
    .finally(() => {
      pending.delete(key);
    });

  pending.set(key, promise);
  return promise;
};

/**
 * 캐시에 있으면 동기적으로 즉시 반환(없으면 null).
 * 드롭다운을 로딩 스피너 없이 즉시 채우는 데 사용.
 */
export const peekRegionList = (type: RegionType, code?: string): RegionCode[] | null => {
  const key = cacheKey(type, code);
  const mem = memCache.get(key);
  if (mem) return mem;
  const persisted = readPersisted(key);
  if (persisted) {
    memCache.set(key, persisted);
    return persisted;
  }
  return null;
};

/**
 * 백그라운드 선(先)로딩. 캐시에 없을 때만 조용히 받아 캐시에 채운다.
 * 사용자가 다음 단계를 고르기 전에 미리 받아두어 선택이 즉시 반영되게 한다.
 */
export const prefetchRegionList = (type: RegionType, code?: string): void => {
  if (peekRegionList(type, code)) return;
  void fetchRegionList(type, code).catch(() => {});
};
