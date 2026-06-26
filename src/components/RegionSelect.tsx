import React, { useEffect, useState } from 'react';
import { RegionItem, RegionSelection } from '../types';
import { getRegions } from '../services/kbland';

interface RegionSelectProps {
  value: RegionSelection;
  onChange: (selection: RegionSelection) => void;
  disabled?: boolean;
}

export function RegionSelect({ value, onChange, disabled }: RegionSelectProps) {
  const [largeList, setLargeList] = useState<RegionItem[]>([]);
  const [midList, setMidList] = useState<RegionItem[]>([]);
  const [smallList, setSmallList] = useState<RegionItem[]>([]);

  const [loadingLarge, setLoadingLarge] = useState(false);
  const [loadingMid, setLoadingMid] = useState(false);
  const [loadingSmall, setLoadingSmall] = useState(false);

  // 대지역 로드
  useEffect(() => {
    setLoadingLarge(true);
    getRegions(1)
      .then(setLargeList)
      .catch(console.error)
      .finally(() => setLoadingLarge(false));
  }, []);

  // 대지역 변경 시 중지역 로드
  const handleLargeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = largeList.find((r) => r.code === e.target.value) ?? null;
    onChange({ large: selected, mid: null, small: null });
    setMidList([]);
    setSmallList([]);

    if (selected) {
      setLoadingMid(true);
      getRegions(2, selected.code)
        .then(setMidList)
        .catch(console.error)
        .finally(() => setLoadingMid(false));
    }
  };

  // 중지역 변경 시 소지역 로드
  const handleMidChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = midList.find((r) => r.code === e.target.value) ?? null;
    onChange({ ...value, mid: selected, small: null });
    setSmallList([]);

    if (selected) {
      setLoadingSmall(true);
      getRegions(3, selected.code)
        .then(setSmallList)
        .catch(console.error)
        .finally(() => setLoadingSmall(false));
    }
  };

  const handleSmallChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = smallList.find((r) => r.code === e.target.value) ?? null;
    onChange({ ...value, small: selected });
  };

  return (
    <section className="ctrl-section region-select">
      <h2 className="ctrl-section-title form-label">지역 선택</h2>
      <div className="region-select-row">
        <div className="select-wrapper">
          <select
            className="form-select"
            value={value.large?.code ?? ''}
            onChange={handleLargeChange}
            disabled={disabled || loadingLarge}
          >
            <option value="">{loadingLarge ? '로딩 중...' : '시/도 선택'}</option>
            {largeList.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        <div className="select-wrapper">
          <select
            className="form-select"
            value={value.mid?.code ?? ''}
            onChange={handleMidChange}
            disabled={disabled || !value.large || loadingMid}
          >
            <option value="">{loadingMid ? '로딩 중...' : '시/군/구 선택'}</option>
            {midList.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        <div className="select-wrapper">
          <select
            className="form-select"
            value={value.small?.code ?? ''}
            onChange={handleSmallChange}
            disabled={disabled || !value.mid || loadingSmall}
          >
            <option value="">{loadingSmall ? '로딩 중...' : '읍/면/동 선택'}</option>
            {smallList.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </section>
  );
}
