// 클라이언트 사이드 월간 데이터 소스 — 백엔드 불필요.
// public/data/kb-monthly.json(빌드 산출물, server/scripts/build-monthly-json.mjs)을 1회 로드해
// 메모리에 캐싱하고, 기존 백엔드 monthlyApi와 동일한 형태로 제공한다.
// 트리 구성 / 지표 폴백 / 지역비교 로직은 server/src/services/monthly-region.service.ts를 포팅.
// 추후 Supabase 연결 시 이 모듈만 교체하면 된다.
import type {
  RegionNode,
  MonthlySeries,
  ResolvedRegion,
  TimeseriesPoint,
  RegionCompareItem,
  RegionCompareResult,
  MonthlyPriceRegion,
  MonthlyMarketRegion,
} from '../model/monthly-data.types';
import { loadKbJson } from '../../../shared/lib/kb-source/loader';

interface RegionMeta {
  regionPath: string;
  region: string;
  level: number;
  parentPath: string | null;
}

interface KBMonthlyJson {
  dates: string[];
  regions: RegionMeta[];
  data: Record<string, Partial<Record<string, (number | null)[]>>>;
}

interface Loaded {
  json: KBMonthlyJson;
  dateIdx: Map<string, number>;
  metaByPath: Map<string, RegionMeta>;
  childrenByPath: Map<string, RegionMeta[]>;
  // KB Land API 선택 키(주간 형식) → 월간 regionPath 매핑 (선택자 공용화용)
  aggPathByLabel: Map<string, string>; // 집계: "전국"·"수도권"·"강남11개구" …
  sidoPathByKey: Map<string, string>; // 시도: sidoKey("경기도")="경기" …
  midPathByKey: Map<string, string>; // 중지역: `${sidoKey}|${keyName(leaf)}`
}

// 시도명 → 정규화 키. KB API명(전북특별자치도)과 월간 데이터명(전라북도) 표기차 흡수.
const SIDO_PREFIXES: ReadonlyArray<[string, string]> = [
  ['서울', '서울'], ['부산', '부산'], ['대구', '대구'], ['인천', '인천'], ['광주', '광주'],
  ['대전', '대전'], ['울산', '울산'], ['세종', '세종'], ['경기', '경기'],
  ['충청북', '충북'], ['충청남', '충남'],
  ['전라남', '전남'], ['전라북', '전북'], ['전북', '전북'],
  ['경상북', '경북'], ['경상남', '경남'], ['강원', '강원'], ['제주', '제주'],
];
function sidoKey(name: string): string | null {
  for (const [prefix, key] of SIDO_PREFIXES) if (name.startsWith(prefix)) return key;
  return null;
}
// 시(市) 접미사 제거 — 월간 데이터의 표기 흔들림(동두천/동두천시) 흡수
function keyName(name: string): string {
  return name.endsWith('시') ? name.slice(0, -1) : name;
}

// KB Land 선택 키(주간 형식) → 월간 regionPath. 없으면 undefined(=데이터 없음).
export interface MonthlyRegionLookup {
  resolve: (key: string) => string | undefined;
}

// 선택 키(주간 형식) → 월간 regionPath 해석. 데이터 없으면 undefined.
function resolveKey(L: Loaded, key: string): string | undefined {
  if (key.includes('|')) {
    const [sido, leaf] = key.split('|');
    const sk = sidoKey(sido ?? '');
    return sk ? L.midPathByKey.get(`${sk}|${keyName(leaf ?? '')}`) : undefined;
  }
  const agg = L.aggPathByLabel.get(key);
  if (agg) return agg;
  const sk = sidoKey(key);
  return sk ? L.sidoPathByKey.get(sk) : undefined;
}

let cache: Loaded | null = null;
let loadPromise: Promise<Loaded> | null = null;

function index(json: KBMonthlyJson): Loaded {
  const dateIdx = new Map(json.dates.map((d, i) => [d, i]));
  const metaByPath = new Map<string, RegionMeta>();
  const childrenByPath = new Map<string, RegionMeta[]>();
  const aggPathByLabel = new Map<string, string>();
  const sidoPathByKey = new Map<string, string>();
  const midPathByKey = new Map<string, string>();

  for (const r of json.regions) {
    metaByPath.set(r.regionPath, r);
    if (r.parentPath) {
      const arr = childrenByPath.get(r.parentPath);
      if (arr) arr.push(r);
      else childrenByPath.set(r.parentPath, [r]);
    }

    const segs = r.regionPath.split('>');
    if (r.regionPath === '전국') {
      aggPathByLabel.set('전국', r.regionPath);
    } else if (r.parentPath === '전국') {
      // 전국 직속: 시도 또는 집계(권역·구묶음)
      const sk = sidoKey(r.region);
      if (sk) sidoPathByKey.set(sk, r.regionPath);
      else aggPathByLabel.set(r.region, r.regionPath);
    } else if (segs.length >= 3) {
      // 시/군/구 (시도 하위) — KB 선택 키와 매칭되도록 sidoKey|keyName(leaf)로 색인
      const sk = sidoKey(segs[1]!);
      if (sk) {
        const key = `${sk}|${keyName(r.region)}`;
        if (!midPathByKey.has(key)) midPathByKey.set(key, r.regionPath);
      }
    }
  }
  return { json, dateIdx, metaByPath, childrenByPath, aggPathByLabel, sidoPathByKey, midPathByKey };
}

async function ensureLoaded(): Promise<Loaded> {
  if (cache) return cache;
  if (!loadPromise) {
    loadPromise = loadKbJson<KBMonthlyJson>('monthly')
      .then(json => {
        cache = index(json);
        return cache;
      })
      .catch(err => {
        loadPromise = null; // 실패 시 재시도 가능
        throw err;
      });
  }
  return loadPromise;
}

// 지정 지역에 해당 지표 데이터가 없으면 상위(parentPath)로 올라가며 첫 데이터 보유 지역을 찾는다.
function resolveRegionForMetric(
  L: Loaded,
  regionPath: string,
  metric: string,
): ResolvedRegion | null {
  let current: string | null = regionPath;
  const visited = new Set<string>();

  while (current && !visited.has(current)) {
    visited.add(current);
    const meta = L.metaByPath.get(current);
    if (!meta) return null;
    const arr = L.json.data[current]?.[metric];
    const hasData = !!arr && arr.some(v => v != null);
    if (hasData) {
      return {
        requestedPath: regionPath,
        resolvedPath: current,
        resolvedRegion: meta.region,
        resolvedLevel: meta.level,
        fallback: current !== regionPath,
      };
    }
    current = meta.parentPath;
  }
  return null;
}

function seriesFor(L: Loaded, regionPath: string, metric: string): MonthlySeries {
  const resolved = resolveRegionForMetric(L, regionPath, metric);
  if (!resolved) {
    return { requestedPath: regionPath, resolved: null, data: [] };
  }
  const arr = L.json.data[resolved.resolvedPath]?.[metric] ?? [];
  const data: TimeseriesPoint[] = [];
  for (let i = 0; i < L.json.dates.length; i++) {
    const v = arr[i];
    if (v != null) data.push({ date: L.json.dates[i]!, value: v });
  }
  return { requestedPath: regionPath, resolved, data };
}

function prevMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const d = new Date(y!, m! - 1, 1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function valueAt(L: Loaded, regionPath: string, metric: string, date: string): number | null {
  const i = L.dateIdx.get(date);
  if (i === undefined) return null;
  return L.json.data[regionPath]?.[metric]?.[i] ?? null;
}

export const monthlyLocal = {
  async getRegionTree(): Promise<RegionNode[]> {
    const L = await ensureLoaded();
    // regions를 트리로 조립 (server getRegionTree와 동일)
    const map = new Map<string, RegionNode>();
    for (const r of L.json.regions) {
      map.set(r.regionPath, { ...r, children: [] });
    }
    const roots: RegionNode[] = [];
    for (const node of map.values()) {
      if (node.parentPath && map.has(node.parentPath)) {
        map.get(node.parentPath)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  },

  // KB Land API 선택 키(주간 형식) → 월간 regionPath 해석기. 선택자(주간 동일)에서 사용.
  async getRegionLookup(): Promise<MonthlyRegionLookup> {
    const L = await ensureLoaded();
    return { resolve: (key: string) => resolveKey(L, key) };
  },

  // 전체 월간 날짜축(YYYY-MM). 기준월 드롭다운/기간 슬라이더에 사용 (주간 getDates와 동일 역할).
  async getDates(): Promise<string[]> {
    const L = await ensureLoaded();
    return L.json.dates;
  },

  // 시세지표(주간 동일 구조): 선택 키들에 대해 매매/전세 아파트 지수 시계열을 반환.
  // 키 → regionPath 해석 후 metric별 폴백 포함 시계열. 데이터 없는 키는 빈 시계열.
  async getPriceData(keys: string[]): Promise<MonthlyPriceRegion[]> {
    const L = await ensureLoaded();
    return keys.map(key => {
      const path = resolveKey(L, key);
      if (!path) {
        return { key, resolvedRegion: null, fallback: false, saleAptIndex: [], jeonseAptIndex: [] };
      }
      const sale = seriesFor(L, path, 'saleAptIndex');
      const jeonse = seriesFor(L, path, 'jeonseAptIndex');
      const resolved = sale.resolved ?? jeonse.resolved;
      return {
        key,
        resolvedRegion: resolved?.resolvedRegion ?? L.metaByPath.get(path)?.region ?? null,
        fallback: !!resolved?.fallback,
        saleAptIndex: sale.data,
        jeonseAptIndex: jeonse.data,
      };
    });
  },

  async getTimeseries(regionPaths: string[], metric: string): Promise<MonthlySeries[]> {
    const L = await ensureLoaded();
    return regionPaths.map(p => seriesFor(L, p, metric));
  },

  // 시장지표(시세지표와 동일 구조): 선택 키들에 대해 ㎡당 평균 매매/전세가 시계열을 반환.
  // 중지역까지 제공하며, 데이터 없는 지역은 metric별 폴백(상위)으로 채운다.
  async getMarketData(keys: string[]): Promise<MonthlyMarketRegion[]> {
    const L = await ensureLoaded();
    return keys.map(key => {
      const path = resolveKey(L, key);
      if (!path) {
        return { key, resolvedRegion: null, fallback: false, aptAvgSalePerM2: [], aptAvgJeonsePerM2: [] };
      }
      const sale = seriesFor(L, path, 'aptAvgSalePerM2');
      const jeonse = seriesFor(L, path, 'aptAvgJeonsePerM2');
      const resolved = sale.resolved ?? jeonse.resolved;
      return {
        key,
        resolvedRegion: resolved?.resolvedRegion ?? L.metaByPath.get(path)?.region ?? null,
        fallback: !!resolved?.fallback,
        aptAvgSalePerM2: sale.data,
        aptAvgJeonsePerM2: jeonse.data,
      };
    });
  },

  async getRegionCompare(
    metric: string,
    parentPath: string,
    date?: string,
  ): Promise<RegionCompareResult> {
    const L = await ensureLoaded();
    const children = L.childrenByPath.get(parentPath) ?? [];

    // 대상월: 미지정 시 직계 하위 지역들 중 해당 지표 최신월
    let targetDate = date ?? '';
    if (!targetDate) {
      let maxIdx = -1;
      for (const c of children) {
        const arr = L.json.data[c.regionPath]?.[metric];
        if (!arr) continue;
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i] != null) {
            if (i > maxIdx) maxIdx = i;
            break;
          }
        }
      }
      targetDate = maxIdx >= 0 ? L.json.dates[maxIdx]! : '';
    }
    if (!targetDate) return { date: '', prevDate: '', items: [] };

    const prev = prevMonth(targetDate);
    const items: RegionCompareItem[] = [];
    for (const c of children) {
      const curr = valueAt(L, c.regionPath, metric, targetDate);
      const prevVal = valueAt(L, c.regionPath, metric, prev);
      if (curr == null && prevVal == null) continue; // 해당 지표 데이터 없는 하위 제외
      const change =
        prevVal != null && curr != null && prevVal !== 0
          ? ((curr - prevVal) / prevVal) * 100
          : null;
      items.push({ regionPath: c.regionPath, region: c.region, prev: prevVal, curr, change });
    }
    items.sort((a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity));
    return { date: targetDate, prevDate: prev, items };
  },
};
