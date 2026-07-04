import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { monthlyLocal, monthlyTradeLocal, monthlyForecastLocal } from '../../entities/monthly-data';
import type { MonthlyPriceRegion, MonthlyMarketRegion, MonthlyForecastRegion, TimeseriesPoint } from '../../entities/monthly-data';
import type { WeeklyDataRow } from '../../entities/kb-data';
import { DEFAULT_CHART_OPTIONS, type ChartOptions } from '../../shared/config';

export type ViewMode = 'weekly' | 'monthly';
// 시세지표 / 거래지표 — 주간·월간 공용 헤더 탭. 'market'(시장지표)는 월간 전용.
export type WeeklyTab = 'price' | 'trade' | 'market';

const MAX_REGIONS = 5;

interface MonthlyStore {
  // ── 주간/월간 공유 상태 ────────────────────────────────────────────
  mode: ViewMode;
  weeklyTab: WeeklyTab;
  // 주간 거래지표 보기 옵션 (주간 RegionSelector/TradeDashboard가 사용)
  tradeMaOn: boolean;
  tradeMaWindow: number;
  tradeYRanges: Record<string, { min: number; max: number }>;
  // 시세지표·시장지표 그래프별 Y축 범위 override (id는 'wp:saleIndex' 등 prefix로 구분)
  yRanges: Record<string, { min: number; max: number }>;
  // 그래프별 차트 옵션(형태·혼합·막대 스타일). id는 yRanges와 동일한 prefix 규칙.
  chartOptions: Record<string, ChartOptions>;
  // 시세지표 기준일(지수=100) 세로선 표시 여부 — 주간/월간 시세 차트 공용
  baseLineOn: boolean;
  // 슬롯 복원 시 clearYRanges 자동초기화를 일회성으로 건너뛰기 위한 가드(prefix 집합).
  skipYRangeClear: Set<string>;

  // ── 월간 시세지표 상태 (주간 store와 동일 구조) ──────────────────────
  selectedRegions: string[]; // 선택 키(주간 형식)
  regionLabels: Record<string, string>;
  fromDate: string;
  toDate: string;
  baseDate: string; // 지수 리베이스 기준월 (이 달 = 100.0)
  allDates: string[]; // 전체 월간 날짜축 (YYYY-MM)

  priceData: MonthlyPriceRegion[];
  priceLoading: boolean;
  priceError: string | null;

  // ── 월간 거래지표 상태 (주간 store와 동일 구조) ──────────────────────
  allTradeRegions: string[]; // 거래지표 제공 지역(대지역/집계만)
  tradeData: WeeklyDataRow[]; // 매수우위·매매거래활발·전세수급·전세거래활발
  tradeLoading: boolean;

  // ── 월간 시장지표 상태 (월간 전용) ──────────────────────────────────
  marketData: MonthlyMarketRegion[]; // ㎡당 평균 매매/전세가 + 중위가
  forecastData: MonthlyForecastRegion[]; // KB 매매/전세 전망지수
  leading50: TimeseriesPoint[]; // KB 선도아파트 50지수 (전국 단일)
  marketLoading: boolean;

  // ── 액션 ────────────────────────────────────────────────────────
  setMode: (mode: ViewMode) => void;
  setWeeklyTab: (tab: WeeklyTab) => void;
  setTradeMaOn: (on: boolean) => void;
  setTradeMaWindow: (w: number) => void;
  setTradeYRange: (id: string, min: number, max: number) => void;
  resetTradeYRanges: () => void;
  setYRange: (id: string, min: number, max: number) => void;
  // 지정 prefix('wp:'/'mp:'/'mk:')의 Y축 수동 override를 모두 해제(기간·지역 변경 시 자동 재계산용)
  clearYRanges: (prefix: string) => void;
  // 그래프별 차트 옵션 부분 갱신(없으면 기본값에서 병합).
  setChartOptions: (id: string, patch: Partial<ChartOptions>) => void;
  setBaseLineOn: (on: boolean) => void;
  armSkipYRangeClear: (prefixes: string[]) => void;
  consumeSkipYRangeClear: (prefix: string) => boolean;

  addRegion: (region: string, label?: string) => void;
  removeRegion: (region: string) => void;
  clearRegions: () => void;
  setFromDate: (date: string) => void;
  setToDate: (date: string) => void;
  setBaseDate: (date: string) => void;
  loadDates: () => Promise<void>;
  loadPriceData: () => Promise<void>;
  loadTradeRegions: () => Promise<void>;
  loadTradeData: () => Promise<void>;
  loadMarketData: () => Promise<void>;
}

const DEFAULT_FROM = '2015-01';

export const useMonthlyStore = create<MonthlyStore>()(
  persist(
    (set, get) => ({
  mode: 'weekly',
  weeklyTab: 'price',

  tradeMaOn: true,
  tradeMaWindow: 13,
  tradeYRanges: {},
  yRanges: {},
  chartOptions: {},
  baseLineOn: true,
  skipYRangeClear: new Set<string>(),

  selectedRegions: ['서울특별시', '전국'],
  regionLabels: { 서울특별시: '서울특별시', 전국: '전국' },
  fromDate: DEFAULT_FROM,
  toDate: '',
  baseDate: '',
  allDates: [],

  priceData: [],
  priceLoading: false,
  priceError: null,

  allTradeRegions: [],
  tradeData: [],
  tradeLoading: false,

  marketData: [],
  forecastData: [],
  leading50: [],
  marketLoading: false,

  setMode: mode => {
    // 'market'은 월간 전용 — 주간으로 전환 시 시세지표로 되돌린다.
    const weeklyTab = mode === 'weekly' && get().weeklyTab === 'market' ? 'price' : get().weeklyTab;
    set({ mode, weeklyTab });
    if (mode === 'monthly') {
      const loadAll = () => {
        void get().loadPriceData();
        void get().loadTradeRegions();
        void get().loadTradeData();
        void get().loadMarketData();
      };
      // dates가 아직 없으면 먼저 로드 후 데이터 로드, 이미 있으면 바로 데이터 로드.
      // StoreProvider가 선행 loadDates()를 호출해도 priceData 등은 로드되지 않으므로
      // allDates 유무와 무관하게 항상 데이터를 로드한다.
      if (get().allDates.length === 0) {
        void get().loadDates().then(loadAll);
      } else {
        loadAll();
      }
    }
  },

  setWeeklyTab: tab => set({ weeklyTab: tab }),
  setTradeMaOn: on => set({ tradeMaOn: on }),
  setTradeMaWindow: w => set({ tradeMaWindow: w }),
  setTradeYRange: (id, min, max) =>
    set(s => ({ tradeYRanges: { ...s.tradeYRanges, [id]: { min, max } } })),
  resetTradeYRanges: () => set({ tradeYRanges: {} }),
  setYRange: (id, min, max) => set(s => ({ yRanges: { ...s.yRanges, [id]: { min, max } } })),
  clearYRanges: prefix =>
    set(s => {
      const keys = Object.keys(s.yRanges).filter(k => k.startsWith(prefix));
      if (keys.length === 0) return {}; // 변경 없음 → 불필요한 리렌더 방지
      const next = { ...s.yRanges };
      for (const k of keys) delete next[k];
      return { yRanges: next };
    }),
  setChartOptions: (id, patch) =>
    set(s => ({
      chartOptions: {
        ...s.chartOptions,
        [id]: { ...DEFAULT_CHART_OPTIONS, ...s.chartOptions[id], ...patch },
      },
    })),
  setBaseLineOn: on => set({ baseLineOn: on }),
  armSkipYRangeClear: prefixes =>
    set(s => {
      const next = new Set(s.skipYRangeClear);
      for (const p of prefixes) next.add(p);
      return { skipYRangeClear: next };
    }),
  consumeSkipYRangeClear: prefix => {
    const has = get().skipYRangeClear.has(prefix);
    if (has) {
      set(s => {
        const next = new Set(s.skipYRangeClear);
        next.delete(prefix);
        return { skipYRangeClear: next };
      });
    }
    return has;
  },

  addRegion: (region, label) => {
    const { selectedRegions, regionLabels } = get();
    if (selectedRegions.includes(region) || selectedRegions.length >= MAX_REGIONS) return;
    set({
      selectedRegions: [...selectedRegions, region],
      regionLabels: { ...regionLabels, [region]: label ?? region },
    });
    void get().loadPriceData();
    void get().loadTradeData();
    void get().loadMarketData();
  },

  removeRegion: region => {
    const { selectedRegions, regionLabels } = get();
    const { [region]: _removed, ...restLabels } = regionLabels;
    set({ selectedRegions: selectedRegions.filter(r => r !== region), regionLabels: restLabels });
    void get().loadPriceData();
    void get().loadTradeData();
    void get().loadMarketData();
  },

  clearRegions: () =>
    set({ selectedRegions: [], regionLabels: {}, priceData: [], tradeData: [], marketData: [], forecastData: [] }),

  setFromDate: date => set({ fromDate: date }),
  setToDate: date => set({ toDate: date }),
  setBaseDate: date => set({ baseDate: date }),

  loadDates: async () => {
    try {
      const dates = await monthlyLocal.getDates();
      if (dates.length === 0) return;
      const last = dates[dates.length - 1]!;
      set(s => ({
        allDates: dates,
        // 미설정 값은 데이터 범위로 보정
        toDate: s.toDate || last,
        baseDate: s.baseDate || last,
        fromDate: s.fromDate && s.fromDate >= dates[0]! ? s.fromDate : dates[0]!,
      }));
    } catch {
      // ignore — 차트가 빈 상태를 처리
    }
  },

  loadPriceData: async () => {
    const { selectedRegions } = get();
    if (selectedRegions.length === 0) {
      set({ priceData: [] });
      return;
    }
    set({ priceLoading: true, priceError: null });
    try {
      const data = await monthlyLocal.getPriceData(selectedRegions);
      set({ priceData: data, priceLoading: false });
    } catch (e) {
      set({
        priceError: e instanceof Error ? e.message : '월간 데이터 로딩 실패',
        priceLoading: false,
      });
    }
  },

  loadTradeRegions: async () => {
    try {
      set({ allTradeRegions: await monthlyTradeLocal.getRegions() });
    } catch {
      // ignore — 사이드바가 빈 가용목록을 처리
    }
  },

  loadTradeData: async () => {
    const { selectedRegions } = get();
    if (selectedRegions.length === 0) {
      set({ tradeData: [] });
      return;
    }
    set({ tradeLoading: true });
    try {
      const data = await monthlyTradeLocal.getTradeData(selectedRegions);
      set({ tradeData: data, tradeLoading: false });
    } catch {
      set({ tradeLoading: false });
    }
  },

  loadMarketData: async () => {
    const { selectedRegions } = get();
    if (selectedRegions.length === 0) {
      set({ marketData: [], forecastData: [] });
      return;
    }
    set({ marketLoading: true });
    try {
      const [market, forecast, leading50] = await Promise.all([
        monthlyLocal.getMarketData(selectedRegions),
        monthlyForecastLocal.getForecastData(selectedRegions),
        monthlyLocal.getLeading50(),
      ]);
      set({ marketData: market, forecastData: forecast, leading50, marketLoading: false });
    } catch {
      set({ marketLoading: false });
    }
  },
    }),
    {
      name: 'kb-monthly',
      // skipYRangeClear(Set)는 직렬화 불가 → 런타임 전용으로 제외.
      partialize: s => ({
        mode: s.mode,
        weeklyTab: s.weeklyTab,
        tradeMaOn: s.tradeMaOn,
        tradeMaWindow: s.tradeMaWindow,
        baseLineOn: s.baseLineOn,
        yRanges: s.yRanges,
        tradeYRanges: s.tradeYRanges,
        chartOptions: s.chartOptions,
        selectedRegions: s.selectedRegions,
        regionLabels: s.regionLabels,
        fromDate: s.fromDate,
        toDate: s.toDate,
        baseDate: s.baseDate,
      }),
    },
  ),
);
