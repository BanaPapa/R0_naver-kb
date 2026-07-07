import React, { useState } from 'react';
import { RegionSelect } from '../components/RegionSelect';
import { ControlSection, ControlSelect } from '../components/control-panel';
import { SpaceRangeSlider } from '../components/SpaceRangeSlider';
import { useKbPriceStore } from './store';
import { executeKbSearch } from './runSearch';
import { KB_SPACE_OPTIONS, type PriceType } from './types';

const PYEONG_TO_SQM = 3.30579;

const PRICE_TYPE_OPTIONS: { label: string; value: PriceType }[] = [
  { label: '상위평균', value: '상위' },
  { label: '일반평균', value: '일반' },
  { label: '하위평균', value: '하위' },
];

interface KbPriceSearchPanelProps {
  onToggleCollapse: () => void;
}

export function KbPriceSearchPanel({ onToggleCollapse }: KbPriceSearchPanelProps) {
  const {
    searchParams,
    regionSelection,
    loading,
    setSearchParams,
    setRegionSelection,
  } = useKbPriceStore();

  // 면적 직접설정 슬라이더 — 호스트 SpaceRangeSlider는 평 단위 정수로 동작.
  // 스토어(searchParams.areaMin/Max)는 ㎡ 기준이므로 패널 로컬 상태(평)를 진실로 두고
  // 변경 시 ㎡로 환산해 스토어에 반영한다(반올림 왕복 오차 방지).
  const [pyeongMin, setPyeongMin] = useState(0);
  const [pyeongMax, setPyeongMax] = useState(0);
  const [spaceUnit, setSpaceUnit] = useState<'pyeong' | 'sqm'>('pyeong');

  const handlePyeongMin = (v: number) => {
    setPyeongMin(v);
    setSearchParams({ areaMin: v > 0 ? Math.round(v * PYEONG_TO_SQM) : 0 });
  };
  const handlePyeongMax = (v: number) => {
    setPyeongMax(v);
    setSearchParams({ areaMax: v > 0 ? Math.round(v * PYEONG_TO_SQM) : 0 });
  };

  const togglePriceType = (value: PriceType) => {
    const cur = searchParams.priceTypes;
    const next = cur.includes(value) ? cur.filter((t) => t !== value) : [...cur, value];
    setSearchParams({ priceTypes: next });
  };

  const isOfficetel = searchParams.propertyType === 2;
  const manualMode = isOfficetel || searchParams.areaMode === 'manual';

  // 검색 실행은 슬롯 '재검색'과 공유하는 runSearch 모듈로 위임
  const handleSearch = () => void executeKbSearch();

  return (
    <aside className="eos-ctrl">
      <div className="eos-ctrl-head">
        <div className="ch-ic">
          <svg viewBox="0 0 24 24">
            <path d="M3 5h18M6 12h12M10 19h4" />
          </svg>
        </div>
        <b>검색 조건</b>
        <button className="eos-ctrl-toggle" title="패널 접기" onClick={onToggleCollapse}>
          <svg viewBox="0 0 24 24">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      </div>

      <div className="eos-ctrl-body">
        <RegionSelect value={regionSelection} onChange={setRegionSelection} disabled={loading} />

        {searchParams.regionCode && (
          <div className="keyword-preview">
            <span className="keyword-label">지역</span>
            <span className="keyword-value">
              {[regionSelection.mid?.name, regionSelection.small?.name]
                .map((s) => s?.trim())
                .filter(Boolean)
                .join(' ') || regionSelection.large?.name.trim()}
            </span>
            <span className="keyword-code">{searchParams.regionCode}</span>
          </div>
        )}

        {/* 상품 유형 — 오피스텔 선택 시 면적은 직접설정만 가능 */}
        <ControlSection title="상품 유형" className="form-group">
          <div className="kbp-segmented">
            <button
              type="button"
              className={`space-unit-btn ${searchParams.propertyType === 1 ? 'active' : ''}`}
              onClick={() => setSearchParams({ propertyType: 1 })}
              disabled={loading}
            >
              아파트
            </button>
            <button
              type="button"
              className={`space-unit-btn ${searchParams.propertyType === 2 ? 'active' : ''}`}
              onClick={() => setSearchParams({ propertyType: 2, areaMode: 'manual' })}
              disabled={loading}
            >
              오피스텔
            </button>
          </div>
        </ControlSection>

        {/* 거래 유형 */}
        <ControlSection title="거래 유형" className="form-group">
          <div className="kbp-segmented">
            {(['매매', '전세', '월세'] as const).map((dt) => (
              <button
                key={dt}
                type="button"
                className={`space-unit-btn ${searchParams.dealType === dt ? 'active' : ''}`}
                onClick={() => setSearchParams({ dealType: dt })}
                disabled={loading}
              >
                {dt}
              </button>
            ))}
          </div>
        </ControlSection>

        {/* 시세 유형 (1~3개 다중 선택) */}
        <ControlSection
          title="시세 유형"
          className="form-group"
          headerRight={<span className="kbp-count-badge">{searchParams.priceTypes.length} 선택</span>}
        >
          <div className="kbp-checks">
            {PRICE_TYPE_OPTIONS.map((opt) => (
              <label key={opt.value} className="kbp-check">
                <input
                  type="checkbox"
                  checked={searchParams.priceTypes.includes(opt.value)}
                  onChange={() => togglePriceType(opt.value)}
                  disabled={loading}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </ControlSection>

        {/* 면적 — 아파트: 프리셋(전용면적)/직접설정(공급면적), 오피스텔: 직접설정(전용면적)만 */}
        <ControlSection
          title={`면적 (${isOfficetel ? '전용' : manualMode ? '공급' : '전용'}면적 기준)`}
          className="form-group"
          headerRight={
            !isOfficetel ? (
              <div className="space-unit-toggle">
                <button
                  type="button"
                  className={`space-unit-btn ${searchParams.areaMode === 'preset' ? 'active' : ''}`}
                  onClick={() => setSearchParams({ areaMode: 'preset' })}
                  disabled={loading}
                >
                  타입
                </button>
                <button
                  type="button"
                  className={`space-unit-btn ${searchParams.areaMode === 'manual' ? 'active' : ''}`}
                  onClick={() => setSearchParams({ areaMode: 'manual' })}
                  disabled={loading}
                >
                  직접설정
                </button>
              </div>
            ) : undefined
          }
        >
          {!manualMode ? (
            <ControlSelect
              value={searchParams.spaceIndex}
              onChange={(e) => setSearchParams({ spaceIndex: Number(e.target.value) })}
              disabled={loading}
            >
              {KB_SPACE_OPTIONS.map((opt, i) => (
                <option key={i} value={i}>{opt.label}</option>
              ))}
            </ControlSelect>
          ) : (
            <SpaceRangeSlider
              min={pyeongMin}
              max={pyeongMax}
              unit={spaceUnit}
              maxPyeong={80}
              onMinChange={handlePyeongMin}
              onMaxChange={handlePyeongMax}
              onUnitChange={setSpaceUnit}
              disabled={loading}
            />
          )}
        </ControlSection>

        <div className="run-btn-wrap">
          <button
            className="eos-run-btn ctrl-button-2"
            onClick={handleSearch}
            disabled={loading || !regionSelection.mid}
          >
            {loading ? '데이터 수집 중...' : '데이터 수집 실행'}
          </button>
        </div>
      </div>
    </aside>
  );
}
