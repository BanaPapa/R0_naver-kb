import React, { useMemo } from 'react';
import { LineChart, Brush, ResponsiveContainer } from 'recharts';
import { useAppStore } from '../../shared/lib/store';
import { useMonthlyStore } from '../../shared/lib/monthly-store';
import {
  useBrushRange,
  BrushTraveller,
} from '../chart-dashboard/chart-primitives';

const PRESETS = [1, 3, 5, 10]; // 최근 N년

// 외부(월간) 주입용 props. 미지정 시 주간 store를 사용한다.
interface PeriodSliderProps {
  fromDate?: string;
  toDate?: string;
  setFromDate?: (d: string) => void;
  setToDate?: (d: string) => void;
  dates?: string[];
}

// 사이드바용 기간 선택기: 최근 1/3/5/10년 프리셋 + 얇은 드래그 막대.
// 주간은 활성 탭(시세/거래)에 맞는 날짜축을, 월간은 props로 주입된 날짜축을 사용한다.
export const PeriodSlider: React.FC<PeriodSliderProps> = props => {
  const weekly = useAppStore();
  const weeklyTab = useMonthlyStore(s => s.weeklyTab);
  const fromDate = props.fromDate ?? weekly.fromDate;
  const toDate = props.toDate ?? weekly.toDate;
  const setFromDate = props.setFromDate ?? weekly.setFromDate;
  const setToDate = props.setToDate ?? weekly.setToDate;
  const dates = props.dates ?? (weeklyTab === 'trade' ? weekly.allTradeDates : weekly.allDates);

  const data = useMemo(() => dates.map(d => ({ date: d })), [dates]);

  const { startIndex, endIndex, handleBrushChange } = useBrushRange(
    dates,
    fromDate,
    toDate,
    setFromDate,
    setToDate,
  );

  const selectYears = (years: number) => {
    if (!dates.length) return;
    const last = dates[dates.length - 1]!;
    const cutoff = new Date(last);
    cutoff.setFullYear(cutoff.getFullYear() - years);
    // 날짜 입력 단위(주간 YYYY-MM-DD / 월간 YYYY-MM)에 무관하게 실제 데이터 날짜로 스냅
    const fromStr = dates.find(d => new Date(d).getTime() >= cutoff.getTime()) ?? dates[0]!;
    setFromDate(fromStr);
    setToDate(last);
  };

  const selectAll = () => {
    if (!dates.length) return;
    setFromDate(dates[0]!);
    setToDate(dates[dates.length - 1]!);
  };

  if (!dates.length) return null;

  return (
    <div>
      {/* 최근 N년 프리셋 + 전체 기간 */}
      <div className="mb-1.5 flex gap-1">
        {PRESETS.map(y => (
          <button
            key={y}
            onClick={() => selectYears(y)}
            className="ctrl-button-1 flex-1 rounded-md border border-gray-200 py-1 text-[11px] text-gray-500 transition-colors hover:border-blue-300 hover:bg-gray-50 hover:text-blue-600"
          >
            {y}년
          </button>
        ))}
        <button
          onClick={selectAll}
          className="ctrl-button-1 flex-1 rounded-md border border-gray-200 py-1 text-[11px] text-gray-500 transition-colors hover:border-blue-300 hover:bg-gray-50 hover:text-blue-600"
        >
          전체
        </button>
      </div>

      {/* 드래그 막대 (시작/종료 원형 노브) — 노브가 잘리지 않게 위아래 여백 확보 */}
      <div className="h-8">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 9, right: 8, left: 8, bottom: 9 }}>
            <Brush
              dataKey="date"
              height={12}
              startIndex={startIndex}
              endIndex={endIndex}
              onChange={handleBrushChange}
              travellerWidth={10}
              traveller={<BrushTraveller />}
              stroke="var(--border-2)"
              fill="var(--blue)"
              tickFormatter={() => ''}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-0.5 flex h-4 items-start justify-end">
        <span className="font-mono text-[11px] leading-none text-blue-600">{fromDate} ~ {toDate}</span>
      </div>
    </div>
  );
};
