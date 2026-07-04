import React, { useEffect, useMemo } from 'react';
import { useMonthlyStore } from '../../shared/lib/monthly-store';
import type { MonthlyMarketRegion, MonthlyForecastRegion } from '../../entities/monthly-data';
import { computeDynamicYConfig, type DynamicYOptions } from '../../shared/config/y-axis';
import { DEFAULT_CHART_OPTIONS } from '../../shared/config';
import { type ChartRow, MetricChart } from '../chart-dashboard/chart-primitives';
import { YAxisControl } from '../weekly-trade-dashboard/YAxisControl';

// ㎡ → 3.3㎡(평) 환산계수. 평균 매매/전세가에 곱해 평당 가격으로 표시한다.
const PYEONG = 3.305785;
const NEUTRAL = 100; // 전망지수 확산지수 중립선

type MarketField = 'aptAvgSalePerM2' | 'aptAvgJeonsePerM2' | 'medianAptSale' | 'medianAptJeonse';
type ForecastField = 'saleForecast' | 'jeonseForecast';

// 선도50 차트의 고정 dataKey/라벨 — 전국 단일 지수라 지역 선택과 무관.
const KB50_KEY = 'kb50';
const KB50_LABELS = { [KB50_KEY]: 'KB 선도아파트50' };

// 차트별 동적 Y축 옵션 — 평균 매매/전세가는 2,000만원 단위 고정, 나머지는 데이터로 산출.
function marketYOpts(id: string): DynamicYOptions {
  if (id === 'avgSale' || id === 'avgJeonse') return { step: 2000 };
  return {};
}

// 시장지표 차트 정의. regions/labels 미지정 시 선택 지역을 그대로 사용(선도50만 고정 키).
interface MarketChartView {
  id: string;
  title: string;
  subtitle?: string;
  unit: string;
  referenceValue?: number;
  data: ChartRow[];
  regions?: string[];
  labels?: Record<string, string>;
}

const INFO: Record<string, string> = {
  avgSale: 'KB 월간 ㎡당 아파트 평균 매매가를 3.3㎡(평)당으로 환산(×3.305785)한 값. 단위: 만원/3.3㎡.',
  avgJeonse: 'KB 월간 ㎡당 아파트 평균 전세가를 3.3㎡(평)당으로 환산(×3.305785)한 값. 단위: 만원/3.3㎡.',
  saleForecast:
    'KB부동산 매매가격 전망지수. 3개월 후 매매가 전망 설문의 확산지수(0~200, 100=중립). 100 초과 = 상승 전망 우세, 미만 = 하락 전망 우세. 전망지수는 대지역만 제공되어, 중지역을 고르면 소속 대지역(시/도) 기준으로 표시된다.',
  jeonseForecast:
    'KB부동산 전세가격 전망지수. 3개월 후 전세가 전망 설문의 확산지수(0~200, 100=중립). 100 초과 = 상승 전망 우세. 전망지수는 대지역만 제공되어, 중지역을 고르면 소속 대지역(시/도) 기준으로 표시된다.',
  gap: '3.3㎡당 평균 매매가 − 평균 전세가 (만원/3.3㎡). 두 값 모두 평당 환산된 값이라 그대로 뺀 격차. 클수록 매매·전세 가격차가 크다.',
  jeonseRatio: 'APT 전세가율(%) = 평균 전세가 ÷ 평균 매매가 × 100. 단위가 약분되어 환산 불필요. 높을수록 매매가 대비 전세가가 높다.',
  medianSale:
    'KB 월간 아파트 중위 매매가(만원/호). 가격순 정중앙 값이라 평균보다 고가 이상치 왜곡이 적다. 상위지역(시/도·권역)만 제공되어, 시군구를 고르면 소속 상위지역 기준으로 표시된다.',
  medianJeonse:
    'KB 월간 아파트 중위 전세가(만원/호). 상위지역만 제공 — 시군구 선택 시 소속 상위지역 기준으로 표시된다.',
  leading50:
    'KB 선도아파트 50지수. 시가총액 상위 50개 대단지의 가격지수(2026.1=100)로, 시장 전체보다 먼저 움직이는 경향이 있는 대표 선행 지표. 전국 단일 지수라 지역 선택과 무관하게 동일하다.',
};

function toSortedRows(byDate: Map<string, Record<string, number | null>>): ChartRow[] {
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ date, ...values })) as ChartRow[];
}

// 단일 필드 시계열을 날짜축 차트행으로. mul 배수를 곱해 단위 변환(㎡→평).
function fieldRows(market: MonthlyMarketRegion[], regions: string[], field: MarketField, mul: number): ChartRow[] {
  const byDate = new Map<string, Record<string, number | null>>();
  for (const m of market) {
    if (!regions.includes(m.key)) continue;
    for (const pt of m[field]) {
      if (pt.value == null) continue;
      if (!byDate.has(pt.date)) byDate.set(pt.date, {});
      byDate.get(pt.date)![m.key] = pt.value * mul;
    }
  }
  return toSortedRows(byDate);
}

// 매매·전세 두 필드를 같은 날짜에서 결합(격차/전세가율). 둘 다 있는 날짜만 계산.
function combineRows(
  market: MonthlyMarketRegion[],
  regions: string[],
  fn: (sale: number, jeonse: number) => number,
): ChartRow[] {
  const byDate = new Map<string, Record<string, number | null>>();
  for (const m of market) {
    if (!regions.includes(m.key)) continue;
    const jMap = new Map(m.aptAvgJeonsePerM2.map(p => [p.date, p.value] as const));
    for (const pt of m.aptAvgSalePerM2) {
      const s = pt.value;
      const je = jMap.get(pt.date);
      if (s == null || je == null) continue;
      if (!byDate.has(pt.date)) byDate.set(pt.date, {});
      byDate.get(pt.date)![m.key] = fn(s, je);
    }
  }
  return toSortedRows(byDate);
}

function forecastRows(forecast: MonthlyForecastRegion[], regions: string[], field: ForecastField): ChartRow[] {
  const byDate = new Map<string, Record<string, number | null>>();
  for (const f of forecast) {
    if (!regions.includes(f.key)) continue;
    for (const pt of f[field]) {
      if (pt.value == null) continue;
      if (!byDate.has(pt.date)) byDate.set(pt.date, {});
      byDate.get(pt.date)![f.key] = pt.value;
    }
  }
  return toSortedRows(byDate);
}

// 월간 시장지표 대시보드(월간 전용) — 6차트(3×2):
//   APT 평균 매매가 · APT 평균 전세가 / KB 매매전망 · KB 전세전망 / 매매-전세 격차 · APT 전세가율
// ㎡당 평균가(중지역까지)와 전망지수(대지역)는 날짜축이 달라, 표시 구간은 값(fromDate~toDate) 기준으로 자른다.
export const MonthlyMarketDashboard: React.FC = () => {
  const {
    marketData,
    forecastData,
    leading50,
    marketLoading,
    selectedRegions,
    regionLabels,
    fromDate,
    toDate,
    yRanges,
    setYRange,
    clearYRanges,
    consumeSkipYRangeClear,
    chartOptions,
    setChartOptions,
  } = useMonthlyStore();

  // 기간·지역이 바뀌면 표시 데이터가 달라지므로 수동 Y축 override를 해제 → 자동 재계산.
  useEffect(() => {
    if (consumeSkipYRangeClear('mk:')) return; // 슬롯 복원 직후 1회 건너뜀
    clearYRanges('mk:');
  }, [clearYRanges, consumeSkipYRangeClear, fromDate, toDate, selectedRegions]);

  const chartViews = useMemo(() => {
    if (selectedRegions.length === 0) return null;
    const slice = (rows: ChartRow[]) => rows.filter(r => r.date >= fromDate && r.date <= toDate);
    // 선도50: 전국 단일 시계열 → 고정 dataKey 로 변환
    const leading50Rows: ChartRow[] = leading50
      .filter(p => p.value != null)
      .map(p => ({ date: p.date, [KB50_KEY]: p.value }) as ChartRow);

    const views: MarketChartView[] = [
      {
        id: 'avgSale',
        title: 'APT 평균 매매가',
        unit: '만원/3.3㎡',
        data: slice(fieldRows(marketData, selectedRegions, 'aptAvgSalePerM2', PYEONG)),
      },
      {
        id: 'avgJeonse',
        title: 'APT 평균 전세가',
        unit: '만원/3.3㎡',
        data: slice(fieldRows(marketData, selectedRegions, 'aptAvgJeonsePerM2', PYEONG)),
      },
      {
        id: 'medianSale',
        title: 'APT 중위 매매가',
        subtitle: '※ 상위지역(시/도)만 제공',
        unit: '만원',
        data: slice(fieldRows(marketData, selectedRegions, 'medianAptSale', 1)),
      },
      {
        id: 'medianJeonse',
        title: 'APT 중위 전세가',
        subtitle: '※ 상위지역(시/도)만 제공',
        unit: '만원',
        data: slice(fieldRows(marketData, selectedRegions, 'medianAptJeonse', 1)),
      },
      {
        id: 'gap',
        title: '매매-전세 가격 격차',
        subtitle: '= 매매 − 전세',
        unit: '만원/3.3㎡',
        data: slice(combineRows(marketData, selectedRegions, (s, je) => (s - je) * PYEONG)),
      },
      {
        id: 'jeonseRatio',
        title: 'APT 전세가율',
        subtitle: '= 전세 ÷ 매매 × 100',
        unit: '%',
        data: slice(combineRows(marketData, selectedRegions, (s, je) => (je / s) * 100)),
      },
      {
        id: 'saleForecast',
        title: 'KB 매매가격 전망지수',
        subtitle: '※ 상위지역(시/도)만 제공',
        unit: '',
        referenceValue: NEUTRAL,
        data: slice(forecastRows(forecastData, selectedRegions, 'saleForecast')),
      },
      {
        id: 'jeonseForecast',
        title: 'KB 전세가격 전망지수',
        subtitle: '※ 상위지역(시/도)만 제공',
        unit: '',
        referenceValue: NEUTRAL,
        data: slice(forecastRows(forecastData, selectedRegions, 'jeonseForecast')),
      },
      {
        id: 'leading50',
        title: 'KB 선도아파트 50지수',
        subtitle: '※ 전국 단일 — 지역 선택과 무관',
        unit: '',
        regions: [KB50_KEY],
        labels: KB50_LABELS,
        data: slice(leading50Rows),
      },
    ];
    return views;
  }, [marketData, forecastData, leading50, selectedRegions, fromDate, toDate]);

  if (selectedRegions.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="text-center">
          <p className="text-gray-400 text-lg mb-2">지역을 선택해주세요</p>
          <p className="text-gray-300 text-sm">시장지표는 중지역(시/군/구)까지 선택할 수 있습니다</p>
        </div>
      </div>
    );
  }

  if (marketLoading) {
    return (
      <div className="flex items-center justify-center h-64 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-3"></div>
          <p className="text-gray-500 text-sm">데이터 로딩 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* 9개 차트 — 2열 고정 행높이 그리드, 넘치면 세로 스크롤 */}
      <div className="grid min-h-0 flex-1 auto-rows-[minmax(300px,1fr)] grid-cols-1 gap-3 overflow-y-auto xl:grid-cols-2">
        {(chartViews ?? []).map((view, i) => {
          const regions = view.regions ?? selectedRegions;
          const labels = view.labels ?? regionLabels;
          const cfg = computeDynamicYConfig(view.data, regions, marketYOpts(view.id));
          const range = cfg ? yRanges[`mk:${view.id}`] ?? { min: cfg.min, max: cfg.max } : undefined;
          return (
            <MetricChart
              key={view.id}
              title={view.title}
              subtitle={view.subtitle}
              info={INFO[view.id]}
              infoAlign={i % 2 === 1 ? 'right' : 'left'}
              unit={view.unit}
              data={view.data}
              selectedRegions={regions}
              regionLabels={labels}
              syncId="kb-monthly-market"
              referenceValue={view.referenceValue}
              yDomain={range ? [range.min, range.max] : undefined}
              yTickStep={cfg?.tickStep}
              yTickDecimals={cfg?.decimals}
              chartOptions={chartOptions[`mk:${view.id}`] ?? DEFAULT_CHART_OPTIONS}
              onChartOptionsChange={patch => setChartOptions(`mk:${view.id}`, patch)}
              headerRight={
                cfg && range ? (
                  <YAxisControl
                    min={range.min}
                    max={range.max}
                    minOptions={cfg.minOptions}
                    maxOptions={cfg.maxOptions}
                    decimals={cfg.decimals}
                    onChange={(mn, mx) => setYRange(`mk:${view.id}`, mn, mx)}
                  />
                ) : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
};
