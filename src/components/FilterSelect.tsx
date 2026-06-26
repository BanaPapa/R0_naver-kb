import React from 'react';
import { REAL_ESTATE_TYPES, TRADE_TYPES, SPACE_OPTIONS, isExclusiveSpaceType } from '../types';
import { SpaceRangeSlider } from './SpaceRangeSlider';

export type AreaMode = 'preset' | 'manual';

interface FilterSelectProps {
  realEstateType: string;
  tradeType: string;
  spaceIndex: number;
  areaMode: AreaMode;
  exclusivePyeongMin: number;
  exclusivePyeongMax: number;
  supplyPyeongMin: number;
  supplyPyeongMax: number;
  spaceUnit: 'pyeong' | 'sqm';
  onRealEstateTypeChange: (v: string) => void;
  onTradeTypeChange: (v: string) => void;
  onSpaceIndexChange: (i: number) => void;
  onAreaModeChange: (m: AreaMode) => void;
  onExclusivePyeongMinChange: (v: number) => void;
  onExclusivePyeongMaxChange: (v: number) => void;
  onSupplyPyeongMinChange: (v: number) => void;
  onSupplyPyeongMaxChange: (v: number) => void;
  onSpaceUnitChange: (u: 'pyeong' | 'sqm') => void;
  disabled?: boolean;
}

export function FilterSelect({
  realEstateType,
  tradeType,
  spaceIndex,
  areaMode,
  exclusivePyeongMin,
  exclusivePyeongMax,
  supplyPyeongMin,
  supplyPyeongMax,
  spaceUnit,
  onRealEstateTypeChange,
  onTradeTypeChange,
  onSpaceIndexChange,
  onAreaModeChange,
  onExclusivePyeongMinChange,
  onExclusivePyeongMaxChange,
  onSupplyPyeongMinChange,
  onSupplyPyeongMaxChange,
  onSpaceUnitChange,
  disabled,
}: FilterSelectProps) {
  const isExclusive = isExclusiveSpaceType(realEstateType);
  // 빌라/단독·다가구는 new.land /api/articles 직접 조회 — 평형 필터(59타입 등)가 의미 없어 숨김
  const hideAreaFilter = realEstateType === 'VL' || realEstateType === 'DDDGG';

  return (
    <div className="filter-select">
      <section className="ctrl-section form-group">
        <h2 className="ctrl-section-title form-label">상품종류</h2>
        <div className="select-wrapper">
          <select
            className="form-select"
            value={realEstateType}
            onChange={(e) => onRealEstateTypeChange(e.target.value)}
            disabled={disabled}
          >
            {REAL_ESTATE_TYPES.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="ctrl-section form-group">
        <h2 className="ctrl-section-title form-label">거래방식</h2>
        <div className="select-wrapper">
          <select
            className="form-select"
            value={tradeType}
            onChange={(e) => onTradeTypeChange(e.target.value)}
            disabled={disabled}
          >
            {TRADE_TYPES.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </section>

      {!hideAreaFilter && (isExclusive ? (
        // 오피스텔/사무실/지산: 전용면적 레인지 슬라이더
        <section className="ctrl-section form-group">
          <SpaceRangeSlider
            label="면적 (전용면적 기준)"
            min={exclusivePyeongMin}
            max={exclusivePyeongMax}
            unit={spaceUnit}
            onMinChange={onExclusivePyeongMinChange}
            onMaxChange={onExclusivePyeongMaxChange}
            onUnitChange={onSpaceUnitChange}
            disabled={disabled}
          />
        </section>
      ) : (
        // 아파트 등: 타입(고정값) 또는 직접설정(공급면적 레인지) 선택
        <section className="ctrl-section form-group">
          <div className="space-label-row">
            <h2 className="ctrl-section-title form-label" style={{ marginBottom: 0 }}>면적 (공급면적 기준)</h2>
            <div className="space-unit-toggle">
              <button
                className={`space-unit-btn ${areaMode === 'preset' ? 'active' : ''}`}
                onClick={() => onAreaModeChange('preset')}
                disabled={disabled}
                type="button"
              >
                타입
              </button>
              <button
                className={`space-unit-btn ${areaMode === 'manual' ? 'active' : ''}`}
                onClick={() => onAreaModeChange('manual')}
                disabled={disabled}
                type="button"
              >
                직접설정
              </button>
            </div>
          </div>

          {areaMode === 'preset' ? (
            <div className="select-wrapper">
              <select
                className="form-select"
                value={spaceIndex}
                onChange={(e) => onSpaceIndexChange(Number(e.target.value))}
                disabled={disabled}
              >
                {SPACE_OPTIONS.map((opt, i) => (
                  <option key={i} value={i}>{opt.label}</option>
                ))}
              </select>
            </div>
          ) : (
            <SpaceRangeSlider
              min={supplyPyeongMin}
              max={supplyPyeongMax}
              unit={spaceUnit}
              maxPyeong={100}
              onMinChange={onSupplyPyeongMinChange}
              onMaxChange={onSupplyPyeongMaxChange}
              onUnitChange={onSpaceUnitChange}
              disabled={disabled}
            />
          )}
        </section>
      ))}
    </div>
  );
}
