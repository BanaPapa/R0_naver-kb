import React, { useEffect, useState } from 'react';
import { RegionItem, RegionSelection } from '../types';
import { getRegions } from '../services/kbland';
import { ControlSection, ControlSelect } from './control-panel';

interface RegionSelectProps {
  value: RegionSelection;
  onChange: (selection: RegionSelection) => void;
  disabled?: boolean;
  // 시/도만 노출 (중·소지역 select 숨김). 청약현황처럼 시/도 단위 데이터에 사용.
  sidoOnly?: boolean;
  // 시/도 옵션 필터 (예: 청약홈에 매핑되는 시/도만 노출).
  filterLarge?: (item: RegionItem) => boolean;
  // 대지역 드롭다운 최상단에 추가할 '전체' 옵션 (예: 청약홈 공급지역 전체).
  // 선택 시 중·소지역 로딩 없이 large 만 세팅된다.
  allOption?: RegionItem;
}

export function RegionSelect({ value, onChange, disabled, sidoOnly, filterLarge, allOption }: RegionSelectProps) {
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
      .then((list) => setLargeList(filterLarge ? list.filter(filterLarge) : list))
      .catch(console.error)
      .finally(() => setLoadingLarge(false));
  }, [filterLarge]);

  // 대지역 변경 시 중지역 로드
  const handleLargeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const code = e.target.value;
    const isAll = !!allOption && code === allOption.code;
    const selected = isAll ? allOption : (largeList.find((r) => r.code === code) ?? null);
    onChange({ large: selected, mid: null, small: null });
    setMidList([]);
    setSmallList([]);

    // '전체'(공급지역 전체)는 하위 지역이 없으므로 중지역을 로드하지 않는다.
    if (selected && !isAll) {
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
    <ControlSection title="지역 선택" className="region-select">
      <div className="region-select-row">
        <ControlSelect
          value={value.large?.code ?? ''}
          onChange={handleLargeChange}
          disabled={disabled || loadingLarge}
        >
          <option value="">{loadingLarge ? '로딩 중...' : '시/도 선택'}</option>
          {allOption && !loadingLarge && (
            <option value={allOption.code}>{allOption.name}</option>
          )}
          {largeList.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </ControlSelect>

        {!sidoOnly && (
        <ControlSelect
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
        </ControlSelect>
        )}

        {!sidoOnly && (
        <ControlSelect
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
        </ControlSelect>
        )}
      </div>
    </ControlSection>
  );
}
