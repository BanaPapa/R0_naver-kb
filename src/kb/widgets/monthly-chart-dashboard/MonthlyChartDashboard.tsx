import React, { useEffect, useMemo } from 'react';
import { useMonthlyStore } from '../../shared/lib/monthly-store';
import type { MonthlyPriceRegion } from '../../entities/monthly-data';
import { computeDynamicYConfig, type DynamicYOptions } from '../../shared/config/y-axis';
import { DEFAULT_CHART_OPTIONS } from '../../shared/config';
import {
  type ChartRow,
  nearestDateIndex,
  MetricChart,
  useBrushRange,
} from '../chart-dashboard/chart-primitives';
import { YAxisControl } from '../weekly-trade-dashboard/YAxisControl';

// 월간 시세지표 6차트 (주간 ChartDashboard와 동일 구조):
//   매매지수 · 전세지수 · 매매증감(전월대비) · 전세증감 · 매매누적변동률 · 전세누적변동률
// 월간 원본엔 지수만 있으므로 증감·누적은 지수에서 프론트에서 파생한다.
// 증감 공식은 KB '★기간비교' 시트의 전월대비 증감률과 동일: (지수ₜ/지수ₜ₋₁ − 1) × 100.

type PriceField = 'saleAptIndex' | 'jeonseAptIndex';

// 차트별 동적 Y축 옵션 — 증감·누적변동률만 음수 허용(나머지는 0 이상).
function priceYOpts(id: string): DynamicYOptions {
  const allowNegative = id.endsWith('Change') || id.endsWith('Cumulative');
  return { allowNegative };
}

// 기준월 표기: (2026.5=100.0)
function formatBaseNote(dateStr: string): string {
  const [y, m] = dateStr.split('-');
  return `(${y}.${Number(m)}=100.0)`;
}

// 누적변동률 표기: (2026.5 대비)
function formatCumulativeNote(dateStr: string): string {
  const [y, m] = dateStr.split('-');
  return `(${y}.${Number(m)} 대비)`;
}

// 지역별 지수 시계열을 날짜축 차트 데이터로 변환.
// rebase=true 이면 기준월(baseDate) 값이 100이 되도록 지역별로 재정규화한다.
function buildChartData(
  priceData: MonthlyPriceRegion[],
  keys: string[],
  field: PriceField,
  rebase: boolean,
  baseDate: string,
): ChartRow[] {
  const byDate = new Map<string, Record<string, number | null>>();
  for (const r of priceData) {
    if (!keys.includes(r.key)) continue;
    for (const pt of r[field]) {
      if (!byDate.has(pt.date)) byDate.set(pt.date, {});
      byDate.get(pt.date)![r.key] = pt.value;
    }
  }
  const rows = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ date, ...values })) as ChartRow[];

  if (!rebase || !baseDate || rows.length === 0) return rows;

  const baseRow = rows[nearestDateIndex(rows.map(r => r.date), baseDate)]!;
  return rows.map(r => {
    const out: ChartRow = { date: r.date };
    for (const key of keys) {
      const baseValue = baseRow[key];
      const value = r[key];
      out[key] =
        typeof baseValue === 'number' && baseValue !== 0 && typeof value === 'number'
          ? (value / baseValue) * 100
          : value;
    }
    return out;
  });
}

// 전월대비 변동률(%): (지수ₜ / 지수ₜ₋₁ − 1) × 100. 리베이스된 지수에서 파생.
function toMonthOverMonth(rows: ChartRow[], keys: string[]): ChartRow[] {
  return rows.map((r, i) => {
    const out: ChartRow = { date: r.date };
    const prev = i > 0 ? rows[i - 1]! : null;
    for (const key of keys) {
      const v = r[key];
      const p = prev ? prev[key] : null;
      out[key] =
        prev && typeof v === 'number' && typeof p === 'number' && p !== 0 ? (v / p - 1) * 100 : null;
    }
    return out;
  });
}

// 누적 변동률(%): 표시 구간의 시작점을 0으로 해 종료월까지의 누적 변화.
function toCumulative(slicedRows: ChartRow[], keys: string[]): ChartRow[] {
  if (slicedRows.length === 0) return [];
  const ref: Record<string, number> = {};
  for (const key of keys) {
    for (const row of slicedRows) {
      const v = row[key];
      if (typeof v === 'number') {
        ref[key] = v;
        break;
      }
    }
  }
  return slicedRows.map(r => {
    const out: ChartRow = { date: r.date };
    for (const key of keys) {
      const v = r[key];
      const base = ref[key];
      out[key] =
        typeof v === 'number' && typeof base === 'number' && base !== 0 ? (v / base - 1) * 100 : null;
    }
    return out;
  });
}

export const MonthlyChartDashboard: React.FC = () => {
  const {
    priceData,
    selectedRegions,
    regionLabels,
    priceLoading,
    priceError,
    loadPriceData,
    fromDate,
    toDate,
    setFromDate,
    setToDate,
    baseDate,
    baseLineOn,
    yRanges,
    setYRange,
    clearYRanges,
    consumeSkipYRangeClear,
    chartOptions,
    setChartOptions,
  } = useMonthlyStore();

  // 기간·지역·기준일이 바뀌면 표시 데이터가 달라지므로 수동 Y축 override를 해제 → 자동 재계산.
  useEffect(() => {
    if (consumeSkipYRangeClear('mp:')) return; // 슬롯 복원 직후 1회 건너뜀
    clearYRanges('mp:');
  }, [clearYRanges, consumeSkipYRangeClear, fromDate, toDate, baseDate, selectedRegions]);

  const chartDataByMetric = useMemo(() => {
    if (priceData.length === 0 || selectedRegions.length === 0) return null;
    const saleIndex = buildChartData(priceData, selectedRegions, 'saleAptIndex', true, baseDate);
    const jeonseIndex = buildChartData(priceData, selectedRegions, 'jeonseAptIndex', true, baseDate);
    return { saleIndex, jeonseIndex };
  }, [priceData, selectedRegions, baseDate]);

  const dates = useMemo(() => {
    if (!chartDataByMetric) return [] as string[];
    return chartDataByMetric.saleIndex.map(d => d.date);
  }, [chartDataByMetric]);

  const snappedBaseDate = useMemo(() => {
    if (!dates.length) return baseDate;
    const i = nearestDateIndex(dates, baseDate);
    return dates[i] ?? baseDate;
  }, [dates, baseDate]);

  const { startIndex, endIndex } = useBrushRange(dates, fromDate, toDate, setFromDate, setToDate);

  const chartViews = useMemo(() => {
    if (!chartDataByMetric) return [];
    const saleIndex = chartDataByMetric.saleIndex.slice(startIndex, endIndex + 1);
    const jeonseIndex = chartDataByMetric.jeonseIndex.slice(startIndex, endIndex + 1);
    const baseNote = formatBaseNote(snappedBaseDate);
    const startDate = saleIndex[0]?.date;
    const cumNote = startDate ? formatCumulativeNote(startDate) : undefined;

    return [
      { id: 'saleIndex', title: '아파트 매매가격지수', subtitle: baseNote, unit: '', data: saleIndex },
      { id: 'jeonseIndex', title: '아파트 전세가격지수', subtitle: baseNote, unit: '', data: jeonseIndex },
      { id: 'saleChange', title: '매매 증감률 (전월대비)', unit: '%', data: toMonthOverMonth(saleIndex, selectedRegions) },
      { id: 'jeonseChange', title: '전세 증감률 (전월대비)', unit: '%', data: toMonthOverMonth(jeonseIndex, selectedRegions) },
      { id: 'saleCumulative', title: '매매 누적변동률', subtitle: cumNote, unit: '%', data: toCumulative(saleIndex, selectedRegions) },
      { id: 'jeonseCumulative', title: '전세 누적변동률', subtitle: cumNote, unit: '%', data: toCumulative(jeonseIndex, selectedRegions) },
    ];
  }, [chartDataByMetric, startIndex, endIndex, snappedBaseDate, selectedRegions]);

  if (selectedRegions.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="text-center">
          <p className="text-gray-400 text-lg mb-2">지역을 선택해주세요</p>
          <p className="text-gray-300 text-sm">좌측에서 지역을 추가하면 자동으로 표시됩니다</p>
        </div>
      </div>
    );
  }

  if (priceLoading) {
    return (
      <div className="flex items-center justify-center h-64 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-3"></div>
          <p className="text-gray-500 text-sm">데이터 로딩 중...</p>
        </div>
      </div>
    );
  }

  if (priceError) {
    return (
      <div className="flex items-center justify-center h-64 bg-white rounded-xl border border-red-200 shadow-sm">
        <div className="text-center">
          <p className="text-red-500 text-sm mb-3">데이터 로딩 실패: {priceError}</p>
          <button
            onClick={loadPriceData}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
          >
            재시도
          </button>
        </div>
      </div>
    );
  }

  if (!chartDataByMetric) {
    return (
      <div className="flex items-center justify-center h-64 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="text-center">
          <p className="text-gray-400 text-sm">데이터를 불러오는 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* 6개 그래프 — 남은 높이를 3×2로 가득 채움 (지수·증감·누적변동률) */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2 xl:grid-rows-3">
        {chartViews.map(view => {
          const cfg = computeDynamicYConfig(view.data, selectedRegions, priceYOpts(view.id));
          const range = cfg ? yRanges[`mp:${view.id}`] ?? { min: cfg.min, max: cfg.max } : undefined;
          return (
            <MetricChart
              key={view.id}
              title={view.title}
              subtitle={view.subtitle}
              unit={view.unit}
              data={view.data}
              selectedRegions={selectedRegions}
              regionLabels={regionLabels}
              baseLineDate={snappedBaseDate}
              showBaseLine={baseLineOn}
              yDomain={range ? [range.min, range.max] : undefined}
              yTickStep={cfg?.tickStep}
              yTickDecimals={cfg?.decimals}
              chartOptions={chartOptions[`mp:${view.id}`] ?? DEFAULT_CHART_OPTIONS}
              onChartOptionsChange={patch => setChartOptions(`mp:${view.id}`, patch)}
              headerRight={
                cfg && range ? (
                  <YAxisControl
                    min={range.min}
                    max={range.max}
                    minOptions={cfg.minOptions}
                    maxOptions={cfg.maxOptions}
                    decimals={cfg.decimals}
                    onChange={(mn, mx) => setYRange(`mp:${view.id}`, mn, mx)}
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
