import React, { useEffect, useMemo, useState } from 'react';
import { useMonthlyStore } from '../../shared/lib/monthly-store';
import { MAX_REGIONS, CHART_COLORS } from '../../shared/config';
import { AGGREGATE_REGIONS } from '../../shared/config/kb-aggregates';
import { getRegions, peekRegions, prefetchRegions, type RegionItem } from '../../shared/lib/kb-region-api';
import { buildMidOptions, type MidOption } from '../../shared/lib/kb-mid-options';
import { monthlyLocal, type MonthlyRegionLookup } from '../../entities/monthly-data';
import { InfoTip } from '../../shared/ui/InfoTip';
import { PeriodSlider } from '../region-selector/PeriodSlider';
import { ControlButton, ControlField, ControlSection, ControlSelect } from '../../../components/control-panel';

// 이동평균 기간 선택지(월)
const MA_OPTIONS = [3, 6, 12, 24];
const MA_LABEL: Record<number, string> = { 3: '3개월', 6: '6개월', 12: '12개월(1년)', 24: '24개월(2년)' };
const TRADE_VIEW_HELP =
  '확산지수: 0~200 범위, 100이 중립. 100을 넘으면 강세(매수세·수요·거래 우위), 미만이면 약세.\n\n' +
  '이동평균: 매월 오르내리는 값을 최근 N개월 평균으로 부드럽게 만든 추세선입니다. 단기 노이즈를 걸러 흐름을 보기 쉽게 하며, 기간이 짧을수록 민감·길수록 완만합니다.\n\n' +
  'Y축 범위: 각 그래프 제목 우측에서 그래프별로 조정하며, [Y축 초기화]로 모두 기본(0~200)으로 되돌립니다.';

// 대지역 선택값 인코딩: 집계지역은 "agg:전국", 시도는 "sido:41". (주간 RegionSelector와 동일)
type LargeValue = string;

// 월간 시세지표 사이드바 — 주간 RegionSelector와 동일한 UI·방식.
// 차이는 데이터 소스(월간 룩업으로 가용성 판정)뿐이다.
export const MonthlyRegionCascade: React.FC = () => {
  const {
    selectedRegions,
    regionLabels,
    addRegion,
    removeRegion,
    clearRegions,
    baseDate,
    setBaseDate,
    fromDate,
    toDate,
    setFromDate,
    setToDate,
    allDates,
  } = useMonthlyStore();

  // 거래지표 탭에선 대지역(시/도·집계)만 선택 가능 + 보기 옵션을 여기서 제어 (주간 RegionSelector와 동일)
  const {
    weeklyTab,
    allTradeRegions,
    tradeMaOn,
    tradeMaWindow,
    setTradeMaOn,
    setTradeMaWindow,
    resetTradeYRanges,
    loadTradeRegions,
    baseLineOn,
    setBaseLineOn,
  } = useMonthlyStore();
  const isTrade = weeklyTab === 'trade';
  const isPrice = weeklyTab === 'price'; // 기준월 리베이스는 시세지표 전용 (시장지표는 절대값이라 제외)

  // 거래지표 제공 지역(대지역/집계) 가용목록 로드
  useEffect(() => {
    void loadTradeRegions();
  }, [loadTradeRegions]);

  // 주간 형식 선택 키 → 월간 regionPath 해석기 (데이터 없으면 undefined)
  const [lookup, setLookup] = useState<MonthlyRegionLookup | null>(null);
  useEffect(() => {
    let active = true;
    monthlyLocal.getRegionLookup().then(l => active && setLookup(l)).catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  // 시세지표: 월간 룩업으로 가용 판정. 거래지표: 거래 JSON 제공 지역 집합으로 판정.
  const isAvail = useMemo(
    () => (key: string) => !!lookup && lookup.resolve(key) !== undefined,
    [lookup],
  );
  const tradeAvailSet = useMemo(() => new Set(allTradeRegions), [allTradeRegions]);
  const available = (key: string): boolean =>
    isTrade ? tradeAvailSet.has(key) : isAvail(key);

  // 대지역(시도) 목록 — KB Land API level 1 (주간과 동일 소스·순서)
  const [sidoList, setSidoList] = useState<RegionItem[]>([]);
  const [largeValue, setLargeValue] = useState<LargeValue>('');

  // 중지역 — KB Land API level 2 (선택 시도 기준) + buildMidOptions 평탄화
  const [midOptions, setMidOptions] = useState<MidOption[]>([]);
  const [midKey, setMidKey] = useState<string>('');
  const [loadingMid, setLoadingMid] = useState(false);

  useEffect(() => {
    let active = true;
    const cached = peekRegions(1);
    if (cached) {
      setSidoList(cached);
      for (const s of cached) prefetchRegions(2, s.code);
      return;
    }
    getRegions(1)
      .then(list => {
        if (!active) return;
        setSidoList(list);
        for (const s of list) prefetchRegions(2, s.code);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const selectedSido = useMemo(() => {
    if (!largeValue.startsWith('sido:')) return null;
    const code = largeValue.slice(5);
    return sidoList.find(s => s.code === code) ?? null;
  }, [largeValue, sidoList]);

  const selectedAggregate = useMemo(() => {
    if (!largeValue.startsWith('agg:')) return null;
    const key = largeValue.slice(4);
    return AGGREGATE_REGIONS.find(a => a.weeklyKey === key) ?? null;
  }, [largeValue]);

  // 시도 선택 시 중지역 로드 (availability는 월간 룩업으로 판정)
  useEffect(() => {
    setMidKey('');
    setMidOptions([]);
    if (!selectedSido) return;

    const cached = peekRegions(2, selectedSido.code);
    if (cached) {
      setMidOptions(buildMidOptions(cached, isAvail, selectedSido.name));
      return;
    }
    setLoadingMid(true);
    let active = true;
    getRegions(2, selectedSido.code)
      .then(list => {
        if (active) setMidOptions(buildMidOptions(list, isAvail, selectedSido.name));
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingMid(false);
      });
    return () => {
      active = false;
    };
  }, [selectedSido, isAvail]);

  // 추가 대상: 중지역 선택 시 그것, 아니면 시도/집계.
  const target = useMemo<{ key: string; display: string; available: boolean } | null>(() => {
    if (selectedAggregate) {
      return {
        key: selectedAggregate.weeklyKey,
        display: selectedAggregate.label,
        available: available(selectedAggregate.weeklyKey),
      };
    }
    if (selectedSido) {
      // 거래지표는 대지역만 — 중지역 선택은 무시하고 시도 자체를 대상으로 한다.
      if (!isTrade && midKey) {
        const opt = midOptions.find(m => m.key === midKey);
        if (opt) return { key: opt.key, display: opt.basketLabel, available: opt.available };
      }
      return { key: selectedSido.name, display: selectedSido.name, available: available(selectedSido.name) };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAggregate, selectedSido, midKey, midOptions, isAvail, isTrade, tradeAvailSet]);

  const alreadyAdded = !!target && selectedRegions.includes(target.key);
  const isFull = selectedRegions.length >= MAX_REGIONS;
  const canAdd = !!target && target.available && !alreadyAdded && !isFull;

  const handleAdd = () => {
    if (!target || !canAdd) return;
    addRegion(target.key, target.display);
  };

  const midDisabled = !selectedSido || loadingMid || isTrade;

  return (
    <div className="h-full flex flex-col bg-white">
      {/* 기간 선택 */}
      <ControlSection title="표시기간">
        <div className="mt-4">
          <PeriodSlider
            dates={allDates}
            fromDate={fromDate}
            toDate={toDate}
            setFromDate={setFromDate}
            setToDate={setToDate}
          />
        </div>
      </ControlSection>

      <div className="border-t border-gray-100" />

      <ControlSection title={isPrice ? '지수 기준월' : isTrade ? '거래지표 보기' : ''} className="min-h-[8.5rem]" style={{ paddingTop: 'var(--ctrl-section-gap)' }} headerRight={
        isPrice ? (
          <button
            onClick={() => setBaseLineOn(!baseLineOn)}
            title="각 그래프에 기준월 세로선 표시 On/Off"
            className={`ctrl-item flex-none whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
              baseLineOn ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-200 text-gray-400'
            }`}
          >
            세로선 {baseLineOn ? 'ON' : 'OFF'}
          </button>
        ) : isTrade ? (
          <InfoTip text={TRADE_VIEW_HELP} />
        ) : null
      }>
        {isPrice && (
          <>
            <p className="mb-2 text-xs text-gray-400">이 달 = 100.0</p>
            <ControlSelect
              value={baseDate}
              onChange={e => setBaseDate(e.target.value)}
            >
              {allDates.slice().reverse().map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </ControlSelect>
          </>
        )}

        {isTrade && (
          <div className="flex items-center gap-1.5">
              <button
                onClick={() => setTradeMaOn(!tradeMaOn)}
                className={`ctrl-item flex-none whitespace-nowrap rounded-md border px-2 py-1 text-xs font-semibold transition-colors ${
                  tradeMaOn ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-200 text-gray-400'
                }`}
              >
                이동평균 {tradeMaOn ? 'ON' : 'OFF'}
              </button>
              <select
                value={tradeMaWindow}
                disabled={!tradeMaOn}
                onChange={e => setTradeMaWindow(Number(e.target.value))}
                className="min-w-0 flex-1 text-xs border border-gray-200 rounded-md px-1.5 py-1 bg-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-300"
              >
                {MA_OPTIONS.map(w => (
                  <option key={w} value={w}>{MA_LABEL[w]}</option>
                ))}
              </select>
              <button
                onClick={resetTradeYRanges}
                title="모든 그래프 Y축을 기본(0~200)으로 초기화"
                className="ctrl-secondary-action flex-none whitespace-nowrap px-2 py-1"
              >
                Y축 초기화
              </button>
          </div>
        )}
      </ControlSection>

      <div className="border-t border-gray-100" />

      {/* Cascading region selector (주간 RegionSelector와 동일 구조) */}
      <ControlSection title="지역 선택" className="gap-3 border-b border-gray-100" style={{ paddingTop: 'var(--ctrl-section-gap)' }} headerRight={
        selectedRegions.length > 0 && (
          <ControlButton onClick={clearRegions} className="px-2 py-1">
            전체 해제
          </ControlButton>
        )
      }>

        {/* 대지역 */}
        <ControlField label="대지역 (시/도 · 집계)">
          <ControlSelect
            value={largeValue}
            onChange={e => setLargeValue(e.target.value)}
          >
            <option value="">선택</option>
            <optgroup label="집계 지역">
              {AGGREGATE_REGIONS.map(a => (
                <option key={a.weeklyKey} value={`agg:${a.weeklyKey}`} disabled={!available(a.weeklyKey)}>
                  {a.label}
                  {available(a.weeklyKey) ? '' : ' (데이터 없음)'}
                </option>
              ))}
            </optgroup>
            <optgroup label="시 / 도">
              {sidoList.map(s => (
                <option key={s.code} value={`sido:${s.code}`}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          </ControlSelect>
        </ControlField>

        {/* 중지역 */}
        <ControlField label="중지역 (시/군/구)">
          <ControlSelect
            value={midKey}
            disabled={midDisabled}
            onChange={e => setMidKey(e.target.value)}
          >
            <option value="">
              {isTrade
                ? '거래지표는 대지역만 선택'
                : !selectedSido
                ? selectedAggregate
                  ? '집계 지역은 중지역 없음'
                  : '대지역을 먼저 선택'
                : loadingMid
                ? '불러오는 중...'
                : `${selectedSido.name} 전체 또는 시/군/구 선택`}
            </option>
            {midOptions.map(m => (
              <option key={m.key} value={m.key} disabled={!m.available}>
                {m.label}
                {m.available ? '' : ' (데이터 없음)'}
              </option>
            ))}
          </ControlSelect>
        </ControlField>

        {/* 소지역 — 월간도 중지역까지 평탄화하므로 비활성 (주간과 동일) */}
        <ControlField label="소지역 (읍/면/동)">
          <ControlSelect
            disabled
            value=""
          >
            <option value="">월간 시계열 미지원</option>
          </ControlSelect>
        </ControlField>

        {/* 추가 버튼 */}
        <ControlButton
          variant="primary"
          onClick={handleAdd}
          disabled={!canAdd}
          title={
            isFull
              ? `비교함이 가득 찼습니다 (최대 ${MAX_REGIONS}개)`
              : target && !target.available
              ? '월간 데이터가 없는 지역입니다'
              : alreadyAdded
              ? '이미 추가된 지역입니다'
              : undefined
          }
          className="kb-accent-button w-full py-3"
        >
          {target
            ? alreadyAdded
              ? '이미 추가됨'
              : !target.available
              ? '데이터 없음'
              : `추가: ${target.display}`
            : '추가'}
        </ControlButton>
      </ControlSection>

      {/* 비교함 */}
      <div className="flex-1 overflow-y-auto py-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-gray-600">
            비교함 ({selectedRegions.length}/{MAX_REGIONS})
          </h3>
        </div>

        {selectedRegions.length === 0 ? (
          <p className="text-xs text-gray-400 py-4 text-center">위에서 지역을 선택해 추가하세요</p>
        ) : (
          <div className="space-y-1.5 mb-3">
            {selectedRegions.map((region, idx) => (
              <div
                key={region}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 bg-gray-100 text-sm"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: CHART_COLORS[idx % CHART_COLORS.length] }}
                />
                <span className="text-gray-700 truncate">{regionLabels[region] ?? region}</span>
                <button
                  onClick={() => removeRegion(region)}
                  className="ml-auto flex-none w-5 h-5 flex items-center justify-center rounded text-gray-500 hover:text-gray-800 hover:bg-gray-200 transition-colors"
                  aria-label={`${regionLabels[region] ?? region} 제거`}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M1 1l8 8M9 1L1 9"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="py-2.5 border-t border-gray-100 bg-gray-50">
        <p className="text-[11px] text-gray-400">
          월간 주택 시계열 &nbsp;·&nbsp; 최신 {allDates[allDates.length - 1] ?? '-'}
        </p>
      </div>
    </div>
  );
};
