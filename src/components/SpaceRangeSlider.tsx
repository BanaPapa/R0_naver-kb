import React from 'react';

const PYEONG_TO_SQM = 3.30579;

interface SpaceRangeSliderProps {
  /** 슬라이더 위에 표시할 라벨 (예: "면적 (전용면적 기준)"). 생략 시 라벨 없이 단위 토글만 우측 정렬 */
  label?: string;
  min: number;            // 평 단위
  max: number;            // 평 단위
  unit: 'pyeong' | 'sqm'; // 표시 단위
  maxPyeong?: number;     // 슬라이더 상한(평). 기본 50
  onMinChange: (v: number) => void;
  onMaxChange: (v: number) => void;
  onUnitChange: (u: 'pyeong' | 'sqm') => void;
  disabled?: boolean;
}

function formatPyeong(val: number, unit: 'pyeong' | 'sqm', isMin: boolean): string {
  if (val === 0) return isMin ? '최소' : '최대';
  if (unit === 'pyeong') return `${val}평`;
  return `${(val * PYEONG_TO_SQM).toFixed(1)}㎡`;
}

// 평 단위 면적 레인지 슬라이더 (오피스텔 전용면적 / 아파트 공급면적 직접설정 공용)
export function SpaceRangeSlider({
  label,
  min,
  max,
  unit,
  maxPyeong = 50,
  onMinChange,
  onMaxChange,
  onUnitChange,
  disabled,
}: SpaceRangeSliderProps) {
  const handleMinChange = (v: number) => {
    onMinChange(v);
    if (max > 0 && v > max) onMaxChange(v);
  };

  const handleMaxChange = (v: number) => {
    if (v > 0 && v < min) onMaxChange(min);
    else onMaxChange(v);
  };

  return (
    <>
      <div className="space-label-row">
        {label
          ? <h2 className="ctrl-section-title form-label" style={{ marginBottom: 0 }}>{label}</h2>
          : <span />}
        <div className="space-unit-toggle">
          <button
            className={`space-unit-btn ${unit === 'pyeong' ? 'active' : ''}`}
            onClick={() => onUnitChange('pyeong')}
            disabled={disabled}
            type="button"
          >
            평
          </button>
          <button
            className={`space-unit-btn ${unit === 'sqm' ? 'active' : ''}`}
            onClick={() => onUnitChange('sqm')}
            disabled={disabled}
            type="button"
          >
            ㎡
          </button>
        </div>
      </div>
      <div className="space-slider-wrap">
        <div className="space-slider-label">
          {formatPyeong(min, unit, true)} ~ {formatPyeong(max, unit, false)}
        </div>
        <div className="space-slider-row">
          <span className="space-slider-text">최소</span>
          <input
            type="range"
            className="space-range"
            min={0}
            max={maxPyeong}
            step={1}
            value={min}
            onChange={(e) => handleMinChange(Number(e.target.value))}
            disabled={disabled}
          />
          <span className="space-slider-text" style={{ textAlign: 'right' }}>
            {min === 0 ? '전체' : `${min}평`}
          </span>
        </div>
        <div className="space-slider-row">
          <span className="space-slider-text">최대</span>
          <input
            type="range"
            className="space-range"
            min={0}
            max={maxPyeong}
            step={1}
            value={max}
            onChange={(e) => handleMaxChange(Number(e.target.value))}
            disabled={disabled}
          />
          <span className="space-slider-text" style={{ textAlign: 'right' }}>
            {max === 0 ? '전체' : `${max}평`}
          </span>
        </div>
      </div>
    </>
  );
}
