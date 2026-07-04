export interface RegionNode {
  regionPath: string;
  region: string;
  level: number;
  parentPath: string | null;
  children: RegionNode[];
}

export interface ResolvedRegion {
  requestedPath: string;
  resolvedPath: string;
  resolvedRegion: string;
  resolvedLevel: number;
  fallback: boolean;
}

export interface TimeseriesPoint {
  date: string; // YYYY-MM
  value: number | null;
}

export interface MonthlySeries {
  requestedPath: string;
  resolved: ResolvedRegion | null;
  data: TimeseriesPoint[];
}

export interface RegionCompareItem {
  regionPath: string;
  region: string;
  prev: number | null;
  curr: number | null;
  change: number | null;
}

export interface RegionCompareResult {
  date: string;
  prevDate: string;
  items: RegionCompareItem[];
}

// 시세지표(주간 동일 구조) — 선택 지역별 매매/전세 아파트 지수 시계열.
// key는 선택자(주간 형식)의 선택 키이며, 차트 dataKey·라벨 매핑에 그대로 쓰인다.
export interface MonthlyPriceRegion {
  key: string; // 선택 키 (예: "서울특별시", "경기도|수원시 장안구")
  resolvedRegion: string | null; // 실제 데이터 지역명 (없으면 null)
  fallback: boolean; // 요청 지역에 데이터가 없어 상위로 대체됐는지
  saleAptIndex: TimeseriesPoint[]; // 아파트 매매가격지수
  jeonseAptIndex: TimeseriesPoint[]; // 아파트 전세가격지수
}

// 시장지표 탭 — 선택 지역별 ㎡당 아파트 평균 매매/전세가 시계열(중지역까지 제공).
// 단위 변환(㎡→3.3㎡)·격차·전세가율 파생은 대시보드에서 처리한다.
export interface MonthlyMarketRegion {
  key: string;
  resolvedRegion: string | null;
  fallback: boolean;
  aptAvgSalePerM2: TimeseriesPoint[]; // ㎡당 아파트 평균 매매가(만원/㎡)
  aptAvgJeonsePerM2: TimeseriesPoint[]; // ㎡당 아파트 평균 전세가(만원/㎡)
}

// 전망지표 — 선택 지역별 KB 매매/전세 가격 전망지수(0~200, 100 중립). 대지역/집계만 제공.
export interface MonthlyForecastRegion {
  key: string; // 선택 키 (중지역이면 호출부에서 대지역으로 폴백한 키)
  saleForecast: TimeseriesPoint[]; // KB부동산 매매가격 전망지수
  jeonseForecast: TimeseriesPoint[]; // KB부동산 전세가격 전망지수
}
