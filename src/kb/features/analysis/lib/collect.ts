// 스토어 상태 → AnalysisRequest 패키징.
// 대시보드가 화면에 그리는 것과 동일한 변환(지수 리베이스·증감 파생·평당 환산)을 적용해
// "현재 화면"과 분석 입력이 일치하도록 한다.
//
// 두 가지 경로:
//   - collectTabs/collectCurrentView: 스토어에 이미 로드된 데이터 + 스토어 선택 지역 사용.
//   - collectFor: 임의의 지역/기간을 받아 정적 JSON에서 직접 로드(직접 선택·슬롯 분석용).

import { useAppStore } from '../../../shared/lib/store';
import { useMonthlyStore } from '../../../shared/lib/monthly-store';
import { weeklyLocal } from '../../../entities/kb-data/api/weekly-local';
import { weeklyTradeLocal } from '../../../entities/kb-data/api/weekly-trade-local';
import { monthlyLocal, monthlyTradeLocal, monthlyForecastLocal } from '../../../entities/monthly-data';
import { buildChartData, nearestDateIndex, type ChartRow } from '../../../widgets/chart-dashboard/chart-primitives';
import type { MetricKey } from '../../../shared/config';
import type { WeeklyDataRow } from '../../../entities/kb-data';
import type { MonthlyPriceRegion, MonthlyMarketRegion, MonthlyForecastRegion } from '../../../entities/monthly-data';
import type {
  AnalysisRequest,
  AnalysisDataset,
  AnalysisTab,
  SeriesPoint,
} from '../../../entities/analysis';
import { toRegionSeries, fitPayloadBudget } from './summarize';

const PYEONG = 3.305785; // ㎡ → 3.3㎡(평) 환산계수

export const ALL_TABS: { tab: AnalysisTab; label: string; mode: 'weekly' | 'monthly' }[] = [
  { tab: 'weekly-price', label: '주간 시세지표', mode: 'weekly' },
  { tab: 'weekly-trade', label: '주간 거래지표', mode: 'weekly' },
  { tab: 'monthly-price', label: '월간 시세지표', mode: 'monthly' },
  { tab: 'monthly-trade', label: '월간 거래지표', mode: 'monthly' },
  { tab: 'monthly-market', label: '월간 시장지표', mode: 'monthly' },
];

// ── 공용 변환 ──────────────────────────────────────────────

function sliceByRegion(rows: ChartRow[], regions: string[], from: string, to: string): Record<string, SeriesPoint[]> {
  const out: Record<string, SeriesPoint[]> = {};
  const sliced = rows.filter(r => r.date >= from && r.date <= to);
  for (const region of regions) {
    out[region] = sliced.map(r => ({ date: r.date, value: typeof r[region] === 'number' ? (r[region] as number) : null }));
  }
  return out;
}

// 전기대비 변동률(%) — 주간이면 전주, 월간이면 전월. (값/직전값 − 1) × 100
function changeByRegion(rows: ChartRow[], regions: string[], from: string, to: string): Record<string, SeriesPoint[]> {
  const changeRows = rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1]! : null;
    const o = { date: r.date } as ChartRow;
    for (const region of regions) {
      const v = r[region];
      const p = prev ? prev[region] : null;
      o[region] = prev && typeof v === 'number' && typeof p === 'number' && p !== 0 ? (v / p - 1) * 100 : null;
    }
    return o;
  });
  return sliceByRegion(changeRows, regions, from, to);
}

function makeDataset(
  tab: AnalysisTab,
  metric: string,
  label: string,
  unit: string,
  byRegionSeries: Record<string, SeriesPoint[]>,
): AnalysisDataset | null {
  const byRegion: AnalysisDataset['byRegion'] = {};
  for (const [region, series] of Object.entries(byRegionSeries)) {
    if (series.some(p => typeof p.value === 'number')) byRegion[region] = toRegionSeries(series);
  }
  if (Object.keys(byRegion).length === 0) return null;
  return { tab, metric, label, unit, byRegion };
}

function compact(datasets: (AnalysisDataset | null)[]): AnalysisDataset[] {
  return datasets.filter((d): d is AnalysisDataset => d !== null);
}

// ── 주간 (데이터를 인자로 받아 빌드) ──────────────────────────

function weeklyPriceDatasets(weeklyData: WeeklyDataRow[], regions: string[], from: string, to: string, baseDate: string): AnalysisDataset[] {
  const saleIdx = buildChartData(weeklyData, regions, 'saleIndex', true, baseDate);
  const jeonseIdx = buildChartData(weeklyData, regions, 'jeonseIndex', true, baseDate);
  return compact([
    makeDataset('weekly-price', 'saleIndex', '아파트 매매가격지수', '', sliceByRegion(saleIdx, regions, from, to)),
    makeDataset('weekly-price', 'jeonseIndex', '아파트 전세가격지수', '', sliceByRegion(jeonseIdx, regions, from, to)),
    makeDataset('weekly-price', 'saleChange', '매매 증감률(전주대비)', '%', changeByRegion(saleIdx, regions, from, to)),
    makeDataset('weekly-price', 'jeonseChange', '전세 증감률(전주대비)', '%', changeByRegion(jeonseIdx, regions, from, to)),
  ]);
}

const TRADE_METRICS: { metric: MetricKey; label: string }[] = [
  { metric: 'buyerAdvantage', label: '매수우위지수' },
  { metric: 'jeonseSupply', label: '전세수급지수' },
  { metric: 'saleActivity', label: '매매거래활발지수' },
  { metric: 'jeonseActivity', label: '전세거래활발지수' },
];

function tradeDatasets(tab: AnalysisTab, tradeData: WeeklyDataRow[], regions: string[], from: string, to: string): AnalysisDataset[] {
  return compact(
    TRADE_METRICS.map(({ metric, label }) => {
      const rows = buildChartData(tradeData, regions, metric, false, '');
      return makeDataset(tab, metric, label, '', sliceByRegion(rows, regions, from, to));
    }),
  );
}

// ── 월간 (데이터를 인자로 받아 빌드) ──────────────────────────

// 월간 지수 시계열 → 날짜축 ChartRow[] (기준월 리베이스 = 100)
function monthlyIndexRows(price: MonthlyPriceRegion[], keys: string[], field: 'saleAptIndex' | 'jeonseAptIndex', baseDate: string): ChartRow[] {
  const byDate = new Map<string, Record<string, number | null>>();
  for (const r of price) {
    if (!keys.includes(r.key)) continue;
    for (const pt of r[field]) {
      if (!byDate.has(pt.date)) byDate.set(pt.date, {});
      byDate.get(pt.date)![r.key] = pt.value;
    }
  }
  const rows = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ date, ...values })) as ChartRow[];
  if (!baseDate || rows.length === 0) return rows;
  const baseRow = rows[nearestDateIndex(rows.map(r => r.date), baseDate)]!;
  return rows.map(r => {
    const o = { date: r.date } as ChartRow;
    for (const key of keys) {
      const bv = baseRow[key];
      const v = r[key];
      o[key] = typeof bv === 'number' && bv !== 0 && typeof v === 'number' ? (v / bv) * 100 : v;
    }
    return o;
  });
}

function monthlyPriceDatasets(priceData: MonthlyPriceRegion[], regions: string[], from: string, to: string, baseDate: string): AnalysisDataset[] {
  const saleIdx = monthlyIndexRows(priceData, regions, 'saleAptIndex', baseDate);
  const jeonseIdx = monthlyIndexRows(priceData, regions, 'jeonseAptIndex', baseDate);
  return compact([
    makeDataset('monthly-price', 'saleIndex', '아파트 매매가격지수', '', sliceByRegion(saleIdx, regions, from, to)),
    makeDataset('monthly-price', 'jeonseIndex', '아파트 전세가격지수', '', sliceByRegion(jeonseIdx, regions, from, to)),
    makeDataset('monthly-price', 'saleChange', '매매 증감률(전월대비)', '%', changeByRegion(saleIdx, regions, from, to)),
    makeDataset('monthly-price', 'jeonseChange', '전세 증감률(전월대비)', '%', changeByRegion(jeonseIdx, regions, from, to)),
  ]);
}

// 단일 필드(평당 환산) → region별 시계열
function marketField(market: MonthlyMarketRegion[], regions: string[], field: 'aptAvgSalePerM2' | 'aptAvgJeonsePerM2', from: string, to: string): Record<string, SeriesPoint[]> {
  const out: Record<string, SeriesPoint[]> = {};
  for (const m of market) {
    if (!regions.includes(m.key)) continue;
    out[m.key] = m[field]
      .filter(p => p.date >= from && p.date <= to)
      .map(p => ({ date: p.date, value: p.value == null ? null : p.value * PYEONG }));
  }
  return out;
}

// 매매·전세 결합(격차/전세가율) → region별 시계열
function marketCombine(market: MonthlyMarketRegion[], regions: string[], fn: (sale: number, jeonse: number) => number, from: string, to: string): Record<string, SeriesPoint[]> {
  const out: Record<string, SeriesPoint[]> = {};
  for (const m of market) {
    if (!regions.includes(m.key)) continue;
    const jMap = new Map(m.aptAvgJeonsePerM2.map(p => [p.date, p.value] as const));
    out[m.key] = m.aptAvgSalePerM2
      .filter(p => p.date >= from && p.date <= to)
      .map(p => {
        const je = jMap.get(p.date);
        return { date: p.date, value: p.value == null || je == null ? null : fn(p.value, je) };
      });
  }
  return out;
}

function forecastField(forecast: MonthlyForecastRegion[], regions: string[], field: 'saleForecast' | 'jeonseForecast', from: string, to: string): Record<string, SeriesPoint[]> {
  const out: Record<string, SeriesPoint[]> = {};
  for (const f of forecast) {
    if (!regions.includes(f.key)) continue;
    out[f.key] = f[field].filter(p => p.date >= from && p.date <= to).map(p => ({ date: p.date, value: p.value }));
  }
  return out;
}

function monthlyMarketDatasets(marketData: MonthlyMarketRegion[], forecastData: MonthlyForecastRegion[], regions: string[], from: string, to: string): AnalysisDataset[] {
  return compact([
    makeDataset('monthly-market', 'avgSale', 'APT 평균 매매가', '만원/3.3㎡', marketField(marketData, regions, 'aptAvgSalePerM2', from, to)),
    makeDataset('monthly-market', 'avgJeonse', 'APT 평균 전세가', '만원/3.3㎡', marketField(marketData, regions, 'aptAvgJeonsePerM2', from, to)),
    makeDataset('monthly-market', 'gap', '매매-전세 가격 격차', '만원/3.3㎡', marketCombine(marketData, regions, (s, je) => (s - je) * PYEONG, from, to)),
    makeDataset('monthly-market', 'jeonseRatio', 'APT 전세가율', '%', marketCombine(marketData, regions, (s, je) => (je / s) * 100, from, to)),
    makeDataset('monthly-market', 'saleForecast', 'KB 매매가격 전망지수', '', forecastField(forecastData, regions, 'saleForecast', from, to)),
    makeDataset('monthly-market', 'jeonseForecast', 'KB 전세가격 전망지수', '', forecastField(forecastData, regions, 'jeonseForecast', from, to)),
  ]);
}

// ── 탭별 수집 디스패치 (현재 화면 경로: 스토어 데이터 사용) ──────

// 한 탭의 데이터셋을 수집. regions는 해당 탭이 속한 스토어의 선택 지역과 교집합으로 거른다.
function collectTab(tab: AnalysisTab, regionFilter?: string[]): { datasets: AnalysisDataset[]; from: string; to: string; regions: string[] } {
  const weekly = useAppStore.getState();
  const monthly = useMonthlyStore.getState();
  const within = (rs: string[]) => (regionFilter ? rs.filter(r => regionFilter.includes(r)) : rs);

  switch (tab) {
    case 'weekly-price': {
      const regions = within(weekly.selectedRegions);
      return { datasets: weeklyPriceDatasets(weekly.weeklyData, regions, weekly.fromDate, weekly.toDate, weekly.baseDate), from: weekly.fromDate, to: weekly.toDate, regions };
    }
    case 'weekly-trade': {
      const regions = within(weekly.selectedRegions);
      return { datasets: tradeDatasets('weekly-trade', weekly.tradeData, regions, weekly.fromDate, weekly.toDate), from: weekly.fromDate, to: weekly.toDate, regions };
    }
    case 'monthly-price': {
      const regions = within(monthly.selectedRegions);
      return { datasets: monthlyPriceDatasets(monthly.priceData, regions, monthly.fromDate, monthly.toDate, monthly.baseDate), from: monthly.fromDate, to: monthly.toDate, regions };
    }
    case 'monthly-trade': {
      const regions = within(monthly.selectedRegions);
      return { datasets: tradeDatasets('monthly-trade', monthly.tradeData, regions, monthly.fromDate, monthly.toDate), from: monthly.fromDate, to: monthly.toDate, regions };
    }
    case 'monthly-market': {
      const regions = within(monthly.selectedRegions);
      return { datasets: monthlyMarketDatasets(monthly.marketData, monthly.forecastData, regions, monthly.fromDate, monthly.toDate), from: monthly.fromDate, to: monthly.toDate, regions };
    }
  }
}

function tabToMode(tab: AnalysisTab): 'weekly' | 'monthly' {
  return tab.startsWith('weekly') ? 'weekly' : 'monthly';
}

// 현재 보고 있는 탭(모드+하위탭) 기준 단일 탭 수집.
export function collectCurrentView(): AnalysisRequest {
  const { mode, weeklyTab } = useMonthlyStore.getState();
  const tab: AnalysisTab = `${mode}-${weeklyTab === 'price' ? 'price' : weeklyTab === 'trade' ? 'trade' : 'market'}` as AnalysisTab;
  return collectTabs([tab]);
}

// 선택한 탭들을 모아 수집. regionFilter로 포함할 지역을 추가로 제한 가능.
export function collectTabs(tabs: AnalysisTab[], regionFilter?: string[]): AnalysisRequest {
  const weekly = useAppStore.getState();
  const monthly = useMonthlyStore.getState();
  const datasets: AnalysisDataset[] = [];
  const regionSet = new Set<string>();

  for (const tab of tabs) {
    const { datasets: ds, regions } = collectTab(tab, regionFilter);
    datasets.push(...ds);
    regions.forEach(r => regionSet.add(r));
  }

  const regions = Array.from(regionSet);
  const regionLabels: Record<string, string> = {};
  for (const r of regions) regionLabels[r] = weekly.regionLabels[r] ?? monthly.regionLabels[r] ?? r;

  const usesWeekly = tabs.some(t => tabToMode(t) === 'weekly');
  const usesMonthly = tabs.some(t => tabToMode(t) === 'monthly');
  const from = usesWeekly ? weekly.fromDate : monthly.fromDate;
  const to = usesWeekly ? weekly.toDate : monthly.toDate;
  const mode: AnalysisRequest['scope']['mode'] = usesWeekly && usesMonthly ? 'mixed' : usesWeekly ? 'weekly' : 'monthly';

  return {
    generatedAt: new Date().toISOString(),
    scope: { mode, regions, regionLabels, period: { from, to }, tabs: Array.from(new Set(tabs)) },
    datasets: fitPayloadBudget(datasets),
  };
}

// ── 임의 지역/기간 수집 (직접 선택·슬롯 경로: 정적 JSON에서 직접 로드) ──

export interface CollectForParams {
  tabs: AnalysisTab[];
  regions: string[];
  regionLabels: Record<string, string>;
  weeklyPeriod: { from: string; to: string };
  monthlyPeriod: { from: string; to: string };
  weeklyBaseDate: string;
  monthlyBaseDate: string;
}

// 선택한 탭·지역에 대해 데이터를 직접 로드하여 수집. 스토어 선택과 무관.
export async function collectFor(params: CollectForParams): Promise<AnalysisRequest> {
  const { tabs, regions, regionLabels, weeklyPeriod, monthlyPeriod, weeklyBaseDate, monthlyBaseDate } = params;
  const tabSet = new Set(tabs);
  const datasets: AnalysisDataset[] = [];

  if (regions.length > 0) {
    // 각 탭이 필요로 하는 데이터 소스를 병렬 로드.
    const [weeklyData, weeklyTrade, monthlyPrice, monthlyTrade, monthlyMarket, monthlyForecast] = await Promise.all([
      tabSet.has('weekly-price') ? weeklyLocal.getWeeklyData(regions, '', '') : Promise.resolve<WeeklyDataRow[]>([]),
      tabSet.has('weekly-trade') ? weeklyTradeLocal.getTradeData(regions) : Promise.resolve<WeeklyDataRow[]>([]),
      tabSet.has('monthly-price') ? monthlyLocal.getPriceData(regions) : Promise.resolve<MonthlyPriceRegion[]>([]),
      tabSet.has('monthly-trade') ? monthlyTradeLocal.getTradeData(regions) : Promise.resolve<WeeklyDataRow[]>([]),
      tabSet.has('monthly-market') ? monthlyLocal.getMarketData(regions) : Promise.resolve<MonthlyMarketRegion[]>([]),
      tabSet.has('monthly-market') ? monthlyForecastLocal.getForecastData(regions) : Promise.resolve<MonthlyForecastRegion[]>([]),
    ]);

    if (tabSet.has('weekly-price'))
      datasets.push(...weeklyPriceDatasets(weeklyData, regions, weeklyPeriod.from, weeklyPeriod.to, weeklyBaseDate));
    if (tabSet.has('weekly-trade'))
      datasets.push(...tradeDatasets('weekly-trade', weeklyTrade, regions, weeklyPeriod.from, weeklyPeriod.to));
    if (tabSet.has('monthly-price'))
      datasets.push(...monthlyPriceDatasets(monthlyPrice, regions, monthlyPeriod.from, monthlyPeriod.to, monthlyBaseDate));
    if (tabSet.has('monthly-trade'))
      datasets.push(...tradeDatasets('monthly-trade', monthlyTrade, regions, monthlyPeriod.from, monthlyPeriod.to));
    if (tabSet.has('monthly-market'))
      datasets.push(...monthlyMarketDatasets(monthlyMarket, monthlyForecast, regions, monthlyPeriod.from, monthlyPeriod.to));
  }

  // 데이터가 실제로 들어온 지역만 scope에 표기.
  const present = new Set<string>();
  for (const d of datasets) for (const r of Object.keys(d.byRegion)) present.add(r);
  const scopeRegions = regions.filter(r => present.has(r));
  const labels: Record<string, string> = {};
  for (const r of scopeRegions) labels[r] = regionLabels[r] ?? r;

  const usesWeekly = tabs.some(t => tabToMode(t) === 'weekly');
  const usesMonthly = tabs.some(t => tabToMode(t) === 'monthly');
  const from = usesWeekly ? weeklyPeriod.from : monthlyPeriod.from;
  const to = usesWeekly ? weeklyPeriod.to : monthlyPeriod.to;
  const mode: AnalysisRequest['scope']['mode'] = usesWeekly && usesMonthly ? 'mixed' : usesWeekly ? 'weekly' : 'monthly';

  return {
    generatedAt: new Date().toISOString(),
    scope: { mode, regions: scopeRegions, regionLabels: labels, period: { from, to }, tabs: Array.from(tabSet) },
    datasets: fitPayloadBudget(datasets),
  };
}

// 현재 두 스토어에서 선택된 지역들의 합집합(직접 선택 모달의 지역 체크박스용).
export function selectedRegionUnion(): { region: string; label: string }[] {
  const weekly = useAppStore.getState();
  const monthly = useMonthlyStore.getState();
  const set = new Map<string, string>();
  for (const r of weekly.selectedRegions) set.set(r, weekly.regionLabels[r] ?? r);
  for (const r of monthly.selectedRegions) if (!set.has(r)) set.set(r, monthly.regionLabels[r] ?? r);
  return Array.from(set, ([region, label]) => ({ region, label }));
}
