import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../shared/lib/store';
import { useMonthlyStore } from '../../shared/lib/monthly-store';
import { MAX_REGIONS, CHART_COLORS } from '../../shared/config';
import { AGGREGATE_REGIONS } from '../../shared/config/kb-aggregates';
import { getRegions, peekRegions, prefetchRegions, type RegionItem } from '../../shared/lib/kb-region-api';
import { buildMidOptions, type MidOption } from '../../shared/lib/kb-mid-options';
import { InfoTip } from '../../shared/ui/InfoTip';
import { PeriodSlider } from './PeriodSlider';
import { RegionPresets } from './RegionPresets';
import { ControlButton, ControlField, ControlSection, ControlSelect } from '../../../components/control-panel';
import { getAdminRoleTip, useAdminUi } from '../../../components/admin-ui';

// 이동평균 기간 선택지(주)
const MA_OPTIONS = [4, 13, 26, 52];
const MA_LABEL: Record<number, string> = { 4: '4주', 13: '13주(분기)', 26: '26주(반기)', 52: '52주(1년)' };
const TRADE_VIEW_HELP =
  '확산지수: 0~200 범위, 100이 중립. 100을 넘으면 강세(매수세·수요·거래 우위), 미만이면 약세.\n\n' +
  '이동평균: 매주 오르내리는 값을 최근 N주 평균으로 부드럽게 만든 추세선입니다. 단기 노이즈를 걸러 흐름을 보기 쉽게 하며, 기간이 짧을수록 민감·길수록 완만합니다.\n\n' +
  'Y축 범위: 각 그래프 제목 우측에서 그래프별로 조정하며, [Y축 초기화]로 모두 기본(0~200)으로 되돌립니다.';

// 대지역 선택값 인코딩: 집계지역은 "agg:전국", 시도는 "sido:41".
type LargeValue = string;

export const RegionSelector: React.FC = () => {
  const { isAdmin } = useAdminUi();
  const {
    allRegions,
    allTradeRegions,
    selectedRegions,
    regionLabels,
    addRegion,
    removeRegion,
    clearRegions,
    baseDate,
    setBaseDate,
    allDates,
    latestDate,
    totalRecords,
  } = useAppStore();

  // 거래지표 탭에선 대지역(시/도·집계)만 선택 가능 + 보기 옵션을 여기서 제어
  const {
    weeklyTab,
    tradeMaOn,
    tradeMaWindow,
    setTradeMaOn,
    setTradeMaWindow,
    resetTradeYRanges,
    baseLineOn,
    setBaseLineOn,
  } = useMonthlyStore();
  const isTrade = weeklyTab === 'trade';

  const availableSet = useMemo(
    () => new Set(isTrade ? allTradeRegions : allRegions),
    [isTrade, allRegions, allTradeRegions],
  );

  // 대지역(시도) 목록 — KB Land API level 1
  const [sidoList, setSidoList] = useState<RegionItem[]>([]);
  const [largeValue, setLargeValue] = useState<LargeValue>('');

  // 중지역 — KB Land API level 2 (선택 시도 기준)
  const [midOptions, setMidOptions] = useState<MidOption[]>([]);
  const [midKey, setMidKey] = useState<string>('');
  const [loadingMid, setLoadingMid] = useState(false);

  // 시도 목록 로드 (+ 캐시 즉시 반영)
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

  // 시도 선택 시 중지역 로드
  useEffect(() => {
    setMidKey('');
    setMidOptions([]);
    if (!selectedSido) return;

    const cached = peekRegions(2, selectedSido.code);
    if (cached) {
      setMidOptions(buildMidOptions(cached, k => availableSet.has(k), selectedSido.name));
      return;
    }
    setLoadingMid(true);
    let active = true;
    getRegions(2, selectedSido.code)
      .then(list => {
        if (active) setMidOptions(buildMidOptions(list, k => availableSet.has(k), selectedSido.name));
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingMid(false);
      });
    return () => {
      active = false;
    };
  }, [selectedSido, availableSet]);

  // 추가 대상 결정: 중지역 선택 시 그것, 아니면 시도 자체 / 집계지역.
  const target = useMemo<{ key: string; display: string; available: boolean } | null>(() => {
    if (selectedAggregate) {
      return {
        key: selectedAggregate.weeklyKey,
        display: selectedAggregate.label,
        available: availableSet.has(selectedAggregate.weeklyKey),
      };
    }
    if (selectedSido) {
      if (!isTrade && midKey) {
        const opt = midOptions.find(m => m.key === midKey);
        if (opt) return { key: opt.key, display: opt.basketLabel, available: opt.available };
      }
      return {
        key: selectedSido.name,
        display: selectedSido.name,
        available: availableSet.has(selectedSido.name),
      };
    }
    return null;
  }, [selectedAggregate, selectedSido, midKey, midOptions, availableSet, isTrade]);

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
        <div>
          <PeriodSlider />
        </div>
      </ControlSection>

      <div className="border-t border-gray-100" />

      <ControlSection title={!isTrade ? '지수 기준일' : '거래지표 보기'} className="min-h-[8.5rem]" style={{ paddingTop: 'var(--ctrl-section-gap)' }} headerRight={
        !isTrade ? (
          <button
            onClick={() => setBaseLineOn(!baseLineOn)}
            title={isAdmin ? undefined : '각 그래프에 기준일 세로선 표시 On/Off'}
            data-admin-role-tip={getAdminRoleTip(isAdmin, '버튼1')}
            className={`ctrl-item flex-none whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
              baseLineOn ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-200 text-gray-400'
            }`}
          >
            세로선 {baseLineOn ? 'ON' : 'OFF'}
          </button>
        ) : (
          <InfoTip text={TRADE_VIEW_HELP} />
        )
      }>
        {!isTrade && (
          <>
            <p className="mb-1 text-xs text-gray-400">이 주 = 100.0</p>
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
                data-admin-role-tip={getAdminRoleTip(isAdmin, '버튼1')}
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
                title={isAdmin ? undefined : '모든 그래프 Y축을 기본(0~200)으로 초기화'}
                data-admin-role-tip={getAdminRoleTip(isAdmin, '버튼1')}
                className="ctrl-secondary-action flex-none whitespace-nowrap px-2 py-1"
              >
                Y축 초기화
              </button>
          </div>
        )}
      </ControlSection>

      <div className="border-t border-gray-100" />

      {/* Cascading region selector */}
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
                <option key={a.weeklyKey} value={`agg:${a.weeklyKey}`} disabled={!availableSet.has(a.weeklyKey)}>
                  {a.label}
                  {availableSet.has(a.weeklyKey) ? '' : ' (데이터 없음)'}
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

        {/* 소지역 — 주간은 항상 비활성 */}
        <ControlField label="소지역 (읍/면/동)">
          <ControlSelect
            disabled
            value=""
          >
            <option value="">주간 시계열 미지원</option>
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
              ? '주간 데이터가 없는 지역입니다'
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

        <RegionPresets />

        {selectedRegions.length === 0 ? (
          <p className="text-xs text-gray-400 py-4 text-center">
            위에서 지역을 선택해 추가하세요
          </p>
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
          최신 데이터: {latestDate ?? '-'} &nbsp;·&nbsp; 총 {totalRecords.toLocaleString()}건
        </p>
      </div>
    </div>
  );
};
