import React, { useEffect, useMemo, useState } from 'react';
import { useKbPriceStore } from './store';
import { ProcessedData, PriceType } from './types';
import { DataProcessor } from './dataProcessor';
import { ExportService } from './exportService';
import {
  type AreaUnit,
  type PriceUnit,
  AREA_UNIT_LABEL,
  PRICE_UNIT_LABEL,
  formatArea,
  convertPrice,
} from './units';
import { 입주연도, format입주연차, 평당가만원, format평당가 } from './tableFormat';

// 소지역(동) 필터 — 전체 선택 시 사용하는 센티넬 값
const ALL_DONG = '__ALL__';

// 시세 유형별 컬럼 정의 (상위 → 일반 → 하위 순서)
const PRICE_TYPE_DEFS = [
  { type: '상위', key: '상위평균', label: '상위' },
  { type: '일반', key: '일반평균', label: '일반' },
  { type: '하위', key: '하위평균', label: '하위' },
] as const;

type SortDir = 'asc' | 'desc';

// 상위/일반/하위를 색상 화살표로 표현 (헤더 길이 단축, 전체 의미는 툴팁으로)
function TypeIcon({ type }: { type: PriceType }) {
  if (type === '상위') return <span className="kbp-arrow up">↑</span>;
  if (type === '하위') return <span className="kbp-arrow down">↓</span>;
  return <span className="kbp-arrow mid">−</span>;
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="sort-icon">↕</span>;
  return <span className="sort-icon active">{dir === 'asc' ? '↑' : '↓'}</span>;
}

// KPI 카드 한 칸
function Kpi({
  tone,
  label,
  value,
  desc,
  icon,
}: {
  tone: 'b' | 't' | 'p' | 'a';
  label: string;
  value: string;
  desc: string;
  icon: React.ReactNode;
}) {
  return (
    <div className={`eos-kpi ${tone}`}>
      <div className="kl">
        {icon}
        {label}
      </div>
      <div className="kv tnum">{value}</div>
      <div className="kd">{desc}</div>
    </div>
  );
}

interface KbPriceResultsProps {
  canSave: boolean;
  savedCount: number;
  onSaveSlot: () => void;
  onOpenSlots: () => void;
}

export function KbPriceResults({ canSave, savedCount, onSaveSlot, onOpenSlots }: KbPriceResultsProps) {
  const {
    results,
    loading,
    error,
    searchParams,
    regionSelection,
    areaUnit,
    priceUnit,
    setAreaUnit,
    setPriceUnit,
    resetResults,
  } = useKbPriceStore();
  const [showRepresentativeOnly, setShowRepresentativeOnly] = useState(false);
  // 탑층제외 기본 ON
  const [excludeTopFloor, setExcludeTopFloor] = useState(true);
  // 소지역(동) 필터 — 결과를 동 단위로 좁혀서 보기
  const [selectedDong, setSelectedDong] = useState<string>(ALL_DONG);
  // 정렬 상태 — 행 단위가 아니라 단지 단위 그룹 정렬을 직접 적용
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // 결과에 존재하는 동 목록 + 건수 (검색한 동 순서 유지)
  const dongOptions = useMemo(() => {
    const order: string[] = [];
    const counts = new Map<string, number>();
    for (const r of results) {
      const dong = r.동;
      if (!dong) continue;
      if (!counts.has(dong)) order.push(dong);
      counts.set(dong, (counts.get(dong) ?? 0) + 1);
    }
    return order.map((name) => ({ name, count: counts.get(name) ?? 0 }));
  }, [results]);

  // 결과가 바뀌어 선택한 동이 더 이상 없으면 전체로 되돌림
  useEffect(() => {
    if (selectedDong !== ALL_DONG && !dongOptions.some((d) => d.name === selectedDong)) {
      setSelectedDong(ALL_DONG);
    }
  }, [dongOptions, selectedDong]);

  const filteredResults = useMemo(() => {
    let filtered = [...results];
    if (selectedDong !== ALL_DONG) {
      filtered = filtered.filter((r) => r.동 === selectedDong);
    }
    if (showRepresentativeOnly) {
      filtered = DataProcessor.filterRepresentativeTypes(filtered);
    }
    if (excludeTopFloor) {
      filtered = DataProcessor.filterTopFloor(filtered, true);
    }
    return filtered;
  }, [results, selectedDong, showRepresentativeOnly, excludeTopFloor]);

  const { priceTypes } = searchParams;

  // 결과 요약 KPI (필터 반영)
  const stats = useMemo(() => {
    const complexes = new Set(filteredResults.map((r) => r.단지기본일련번호)).size;
    const dongs = new Set(filteredResults.map((r) => r.동).filter(Boolean)).size;
    const priceVals = filteredResults
      .map((r) => DataProcessor.getPrimaryPrice(r, priceTypes))
      .filter((v) => v > 0);
    const avg = priceVals.length ? priceVals.reduce((a, b) => a + b, 0) / priceVals.length : 0;
    return { count: filteredResults.length, complexes, dongs, avg };
  }, [filteredResults, priceTypes]);

  // 정렬 기준 컬럼의 행 값(숫자) 추출
  const getSortValue = (row: ProcessedData, field: string): number => {
    switch (field) {
      case '세대수':
        return row.세대수 ?? 0;
      case '입주연차':
        return 입주연도(row.입주년월);
      case '전용면적':
        return row.전용면적;
      case '공급면적':
        return row.공급면적;
      case '계약면적':
        return row.계약면적;
      case '상위평균':
        return row.상위평균;
      case '일반평균':
        return row.일반평균;
      case '하위평균':
        return row.하위평균;
      default:
        if (field.startsWith('평당가-')) {
          const pk = field.slice('평당가-'.length) as '상위평균' | '일반평균' | '하위평균';
          return 평당가만원(row, row[pk]);
        }
        return 0;
    }
  };

  // 단지 단위 그룹 정렬:
  // - 같은 단지(단지기본일련번호)의 행은 항상 붙여서 표시
  // - 정렬 시 단지 내부 행을 정렬한 뒤, 각 단지의 대표값(정렬 방향의 극값)으로 단지들끼리 정렬
  // - 정렬 미적용 시 검색 순서(첫 등장 순)대로 단지를 묶어서 표시
  const orderedData = useMemo(() => {
    const groups = new Map<number, ProcessedData[]>();
    const firstIdx = new Map<number, number>();
    filteredResults.forEach((r, i) => {
      if (!groups.has(r.단지기본일련번호)) {
        groups.set(r.단지기본일련번호, []);
        firstIdx.set(r.단지기본일련번호, i);
      }
      groups.get(r.단지기본일련번호)!.push(r);
    });
    const ids = [...groups.keys()];

    if (!sortField) {
      ids.sort((a, b) => firstIdx.get(a)! - firstIdx.get(b)!);
      return ids.flatMap((id) => groups.get(id)!);
    }

    const dir = sortDir === 'asc' ? 1 : -1;
    const groupKey = new Map<number, number>();
    for (const id of ids) {
      const items = groups.get(id)!;
      items.sort((a, b) => (getSortValue(a, sortField) - getSortValue(b, sortField)) * dir);
      // 정렬 후 첫 행이 해당 방향의 극값 → 단지 대표값
      groupKey.set(id, getSortValue(items[0], sortField));
    }
    ids.sort((a, b) => {
      const d = (groupKey.get(a)! - groupKey.get(b)!) * dir;
      return d !== 0 ? d : firstIdx.get(a)! - firstIdx.get(b)!;
    });
    return ids.flatMap((id) => groups.get(id)!);
  }, [filteredResults, sortField, sortDir]);

  // 헤더 클릭 → 오름차순 → 내림차순 → 정렬 해제 순환
  const handleSort = (field: string) => {
    if (sortField !== field) {
      setSortField(field);
      setSortDir('asc');
    } else if (sortDir === 'asc') {
      setSortDir('desc');
    } else {
      setSortField(null);
      setSortDir('asc');
    }
  };

  const handleExport = (format: 'excel' | 'csv') => {
    if (filteredResults.length === 0) return;
    const exportOptions = {
      areaUnit,
      priceUnit,
      regionName: 지역명,
      priceTypes,
      excludeTopFloor,
      propertyType: searchParams.propertyType,
    };
    if (format === 'excel') {
      ExportService.exportToExcel(filteredResults, 'KB부동산_시세조회', exportOptions);
    } else {
      ExportService.exportToCSV(filteredResults, 'KB부동산_시세조회', exportOptions);
    }
  };

  // 오피스텔: 공급면적 없이 전용/계약면적으로 구분
  const isOfficetel = searchParams.propertyType === 2;

  // 선택된 시세 유형을 상위 → 일반 → 하위 순서로 정렬
  const selectedPriceDefs = PRICE_TYPE_DEFS.filter((d) => priceTypes.includes(d.type));

  // 번호열 대체: 선택된 소지역(동) 이름 (없으면 상위 지역으로 대체)
  const 지역명 = regionSelection.small?.name ?? regionSelection.mid?.name ?? '-';

  const areaSuffix = AREA_UNIT_LABEL[areaUnit];
  const priceLabel = PRICE_UNIT_LABEL[priceUnit];
  const renderPrice = (v: number) => (v > 0 ? convertPrice(v, priceUnit).toLocaleString() : '-');

  // 모듈 헤더 부제: 지역 · 거래/상품 유형
  const propertyLabel = isOfficetel ? '오피스텔' : '아파트';
  const subtitle =
    results.length > 0
      ? `${지역명} · ${searchParams.dealType} · ${propertyLabel}`
      : '좌측에서 지역과 조건을 설정한 뒤 데이터를 수집하세요';

  const avgDisplay = stats.avg > 0 ? `${(stats.avg / 10000).toFixed(2)}억` : '-';

  const secondAreaField = isOfficetel ? '계약면적' : '공급면적';
  const totalCols =
    7 + (excludeTopFloor ? 0 : 1) + selectedPriceDefs.length * 2;

  // key={field}: map() 안에서도 그대로 쓸 수 있도록 필드명을 key로 부여
  const sortableTh = (field: string, label: React.ReactNode, className?: string) => (
    <th
      key={field}
      className={className}
      style={{ cursor: 'pointer', userSelect: 'none' }}
      onClick={() => handleSort(field)}
    >
      {label}
      <SortIcon active={sortField === field} dir={sortDir} />
    </th>
  );

  return (
    <main className="eos-view">
      {/* 모듈 헤더 */}
      <div className="eos-mod-head">
        <div>
          <h1>데이터 수집 &amp; 시세 조회</h1>
          <p>{subtitle}</p>
        </div>
        <div className="mh-right">
          <span className="eos-pill">
            <span className="d t" />
            KB 부동산 시세
          </span>
          <span className="eos-pill">
            <span className="d b" />
            {loading ? '수집 중' : results.length > 0 ? '데이터 준비됨' : '대기'}
          </span>
        </div>
      </div>

      {/* KPI 요약 */}
      <div className="eos-kpis kbp-kpis">
        <Kpi
          tone="b"
          label="수집 시세"
          value={stats.count.toLocaleString()}
          desc="필터 적용 결과 건수"
          icon={
            <svg viewBox="0 0 24 24">
              <path d="M3 3v18h18" />
              <path d="M7 14l3-4 3 2 4-6" />
            </svg>
          }
        />
        <Kpi
          tone="t"
          label="단지 수"
          value={stats.complexes.toLocaleString()}
          desc="중복 제거 단지"
          icon={
            <svg viewBox="0 0 24 24">
              <path d="M5 21h14M6 21V8l6-4 6 4v13" />
              <path d="M10 21v-5h4v5" />
            </svg>
          }
        />
        <Kpi
          tone="p"
          label="소지역(동)"
          value={stats.dongs.toLocaleString()}
          desc="결과에 포함된 동"
          icon={
            <svg viewBox="0 0 24 24">
              <path d="M12 21s-7-5.2-7-11a7 7 0 0 1 14 0c0 5.8-7 11-7 11z" />
              <circle cx="12" cy="10" r="2.5" />
            </svg>
          }
        />
        <Kpi
          tone="a"
          label="평균 시세"
          value={avgDisplay}
          desc="대표 시세 평균 (억)"
          icon={
            <svg viewBox="0 0 24 24">
              <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          }
        />
      </div>

      {error && (
        <div className="kbp-error">
          <b>검색 오류</b>
          <span>{error}</span>
        </div>
      )}

      {/* 결과 테이블 카드 — 헤더 구성은 매물시세(result-header)와 동일 */}
      <div className="eos-card grow kbp-card">
        <div className="result-header">
          <span className="result-title">데이터 조회 결과</span>
          <div className="result-unit-controls">
            <div className="result-unit-group">
              <span className="result-unit-label">면적</span>
              <div className="space-unit-toggle">
                {(['sqm', 'pyeong'] as AreaUnit[]).map((u) => (
                  <button
                    key={u}
                    type="button"
                    className={`space-unit-btn ${areaUnit === u ? 'active' : ''}`}
                    onClick={() => setAreaUnit(u)}
                  >
                    {AREA_UNIT_LABEL[u]}
                  </button>
                ))}
              </div>
            </div>
            <div className="result-unit-group">
              <span className="result-unit-label">가격</span>
              <div className="space-unit-toggle">
                {(['cheonwon', 'manwon'] as PriceUnit[]).map((u) => (
                  <button
                    key={u}
                    type="button"
                    className={`space-unit-btn ${priceUnit === u ? 'active' : ''}`}
                    onClick={() => setPriceUnit(u)}
                  >
                    {PRICE_UNIT_LABEL[u]}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="btn-outline btn-sm"
              onClick={onSaveSlot}
              disabled={!canSave}
              title="현재 수집 결과를 슬롯에 저장"
            >
              슬롯 저장
            </button>
            <button className="btn-outline btn-sm" onClick={onOpenSlots}>
              저장 슬롯 {savedCount > 0 ? `(${savedCount})` : ''}
            </button>
            {results.length > 0 && (
              <button className="btn-ghost btn-sm" onClick={resetResults}>
                초기화
              </button>
            )}
          </div>
        </div>

        {/* 결과 요약 라인 */}
        <div className="kbp-summary">
          총 <b>{filteredResults.length.toLocaleString()}</b>건 표시
          {filteredResults.length !== results.length &&
            ` (전체 ${results.length.toLocaleString()}건)`}
          {' · '}
          {stats.complexes.toLocaleString()}개 단지
        </div>

        {/* 필터/표시 옵션 툴바 — 좌측 필터, 우측 내보내기 (매물시세와 동일 배치) */}
        <div className="kbp-toolbar">
          {dongOptions.length > 1 && (
            <>
              <div className="select-wrapper kbp-dong-select">
                <select
                  className="form-select"
                  value={selectedDong}
                  onChange={(e) => setSelectedDong(e.target.value)}
                >
                  <option value={ALL_DONG}>전체 지역 ({results.length})</option>
                  {dongOptions.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name} ({d.count})
                    </option>
                  ))}
                </select>
              </div>
              <span className="tb-sep" />
            </>
          )}

          <label className="kbp-check">
            <input
              type="checkbox"
              checked={showRepresentativeOnly}
              onChange={(e) => setShowRepresentativeOnly(e.target.checked)}
            />
            <span>대표타입만</span>
          </label>
          <label className="kbp-check">
            <input
              type="checkbox"
              checked={excludeTopFloor}
              onChange={(e) => setExcludeTopFloor(e.target.checked)}
            />
            <span>탑층제외</span>
          </label>

          <span className="tb-grow" />

          <button
            className="btn-outline btn-sm"
            onClick={() => handleExport('excel')}
            disabled={filteredResults.length === 0}
          >
            Excel 내보내기
          </button>
          <button
            className="btn-outline btn-sm"
            onClick={() => handleExport('csv')}
            disabled={filteredResults.length === 0}
          >
            CSV 내보내기
          </button>
        </div>

        <div className="table-wrapper kbp-table-wrap">
          <table className="result-table">
            <thead>
              <tr>
                <th>동</th>
                <th className="kbp-th-name">단지명</th>
                {sortableTh('세대수', '세대수')}
                {sortableTh('입주연차', '입주연차')}
                {sortableTh('전용면적', `전용(${areaSuffix})`)}
                {isOfficetel
                  ? sortableTh('계약면적', `계약(${areaSuffix})`)
                  : sortableTh('공급면적', `공급(${areaSuffix})`)}
                <th>타입</th>
                {!excludeTopFloor && <th>탑층</th>}
                {selectedPriceDefs.map((d) =>
                  sortableTh(
                    d.key,
                    <span title={`${d.label}평균 (${priceLabel})`} style={{ whiteSpace: 'nowrap' }}>
                      <TypeIcon type={d.type} /> 평균
                    </span>,
                  ),
                )}
                {selectedPriceDefs.map((d) =>
                  sortableTh(
                    `평당가-${d.key}`,
                    <span title={`${d.label} 평당가 (${priceLabel})`} style={{ whiteSpace: 'nowrap' }}>
                      <TypeIcon type={d.type} /> 평당가
                    </span>,
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={totalCols} className="table-empty">
                    데이터 수집 중...
                  </td>
                </tr>
              ) : orderedData.length === 0 ? (
                <tr>
                  <td colSpan={totalCols} className="table-empty">
                    {results.length === 0
                      ? '검색 조건을 입력하고 데이터 수집을 실행해주세요'
                      : '필터 조건에 맞는 결과가 없습니다'}
                  </td>
                </tr>
              ) : (
                orderedData.map((r) => (
                  <tr key={r.id}>
                    <td className="center">{r.동 || 지역명}</td>
                    <td className="kbp-td-name" title={r.단지명}>{r.단지명}</td>
                    <td className="center">{r.세대수 ? r.세대수.toLocaleString() : '-'}</td>
                    <td className="center">{format입주연차(r.입주년월)}</td>
                    <td className="center">{formatArea(r.전용면적, areaUnit)}</td>
                    <td className="center">{formatArea(r[secondAreaField], areaUnit)}</td>
                    <td className="center">{r.타입}</td>
                    {!excludeTopFloor && (
                      <td className="center">{r.탑층여부 === '탑층' ? '탑층' : ''}</td>
                    )}
                    {selectedPriceDefs.map((d) => (
                      <td key={d.key} className="center tnum">{renderPrice(r[d.key])}</td>
                    ))}
                    {selectedPriceDefs.map((d) => (
                      <td key={`py-${d.key}`} className="center tnum">
                        {format평당가(r, r[d.key], priceUnit)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
