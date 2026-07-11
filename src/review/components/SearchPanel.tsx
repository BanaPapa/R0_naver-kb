import React from 'react';
import { RegionSelect } from '../../components/RegionSelect';
import type { RegionSelection } from '../../types';

export type AptType = 'apt-all' | 'ot-all';

interface SearchPanelProps {
  region: RegionSelection;
  onRegionChange: (r: RegionSelection) => void;
  aptType: AptType;
  onAptTypeChange: (t: AptType) => void;
  onSearch: () => void;
  isSearching: boolean;
  disabled?: boolean;
  analysesCount: number;
  onOpenAnalyses: () => void;
}

export default function SearchPanel({
  region,
  onRegionChange,
  aptType,
  onAptTypeChange,
  onSearch,
  isSearching,
  disabled,
  analysesCount,
  onOpenAnalyses,
}: SearchPanelProps) {
  const canSearch = !!region?.small?.code;

  return (
    <aside className="sidebar">
      <div className="sidebar-body">
        {/* 지역 선택 (R0 RegionSelect 재사용) */}
        <RegionSelect value={region} onChange={onRegionChange} disabled={disabled} />

        {/* 단지 유형 */}
        <div className="search-section">
          <span className="section-label">단지 유형</span>
          <div className="radio-group">
            <label className="radio-chip">
              <input
                type="radio"
                name="reviewAptType"
                value="apt-all"
                checked={aptType === 'apt-all'}
                onChange={() => onAptTypeChange('apt-all')}
              />
              아파트
            </label>
            <label className="radio-chip">
              <input
                type="radio"
                name="reviewAptType"
                value="ot-all"
                checked={aptType === 'ot-all'}
                onChange={() => onAptTypeChange('ot-all')}
              />
              오피스텔
            </label>
          </div>
        </div>

        {/* 단지 조회 */}
        <button className="btn-primary" onClick={onSearch} disabled={!canSearch || isSearching}>
          {isSearching ? (
            <>
              <span className="spinner" /> 조회 중…
            </>
          ) : (
            '단지 조회'
          )}
        </button>

        {!canSearch && (
          <p style={{ fontSize: 14, color: 'var(--muted)', textAlign: 'center', marginTop: -8 }}>
            읍/면/동까지 선택해주세요
          </p>
        )}

        <div className="sidebar-divider" />

        {/* 분석 슬롯 — 검색결과와 무관하게 저장된 분석 관리 */}
        <button className="btn-ghost nav-analysis" onClick={onOpenAnalyses} style={{ width: '100%' }}>
          <span>📊 분석</span>
          {analysesCount > 0 && <span className="tab-badge">{analysesCount}</span>}
        </button>
      </div>
    </aside>
  );
}
