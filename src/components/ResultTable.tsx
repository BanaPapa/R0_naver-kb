import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Property, SearchMeta, TRADE_TYPE_LABELS, TRADE_TYPES, isExclusiveSpaceType, isPresaleType } from '../types';
import {
  formatPriceByUnit, formatDirection, cleanBrokerageName, pyeongUnitPriceWon,
  exportExcel, exportJSON, buildExportBaseName, PriceUnit, AreaUnit,
} from '../services/api';
import { getArticleDetail, ArticleDetailResult } from '../services/naverApi';

interface ResultTableProps {
  properties: Property[];
  realEstateType: string;
  areaUnit: AreaUnit;
  priceUnit: PriceUnit;
  meta: SearchMeta;
  userId: string | null;
}

type SortKey =
  | 'midName' | 'smallName' | 'tradeType' | 'complexName' | 'dongName' | 'floorInfo' | 'direction'
  | 'supplySpaceName' | 'supplySpace' | 'exclusiveSpace' | 'contractSpace' | 'dealPrice' | 'pyeongPrice'
  | 'premiumPrice' | 'optionPrice' | 'totalBuyPrice' | 'realPyeongPrice';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE     = 50;
const PYEONG_TO_SQM = 3.30579;
const SQM_TO_PYEONG = 0.3025;

// ─── Column widths ───────────────────────────────────────────────────────────
const COL_WIDTHS_KEY = 'col_widths_v2_';
const DEFAULT_COL_WIDTHS: Record<string, number> = {
  midName: 72, smallName: 72, tradeType: 56, complexName: 156,
  dongName: 52, floorInfo: 62, direction: 52, supplySpaceName: 64,
  exclusiveSpace: 88, supplySpace: 88,
  dealPrice: 110, pyeongPrice: 110,
  premiumPrice: 96, optionPrice: 96, totalBuyPrice: 110, realPyeongPrice: 110,
  warrantyPrice: 110, rentPrice: 84,
  feature: 200, brokerage: 200,
};

function loadColWidths(userId: string | null): Record<string, number> {
  try {
    const raw = localStorage.getItem(COL_WIDTHS_KEY + (userId ?? 'anon'));
    if (!raw) return { ...DEFAULT_COL_WIDTHS };
    return { ...DEFAULT_COL_WIDTHS, ...JSON.parse(raw) };
  } catch { return { ...DEFAULT_COL_WIDTHS }; }
}

function saveColWidths(userId: string | null, widths: Record<string, number>): void {
  try {
    localStorage.setItem(COL_WIDTHS_KEY + (userId ?? 'anon'), JSON.stringify(widths));
  } catch {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtSqm(sqm: number): string { return sqm > 0 ? `${sqm}㎡` : '-'; }
function fmtPy(sqm: number): string  { return sqm > 0 ? `${(sqm * SQM_TO_PYEONG).toFixed(2)}평` : '-'; }

interface AreaCol {
  key: string;
  label: string;
  sortK?: SortKey;
  render: (p: Property) => React.ReactNode;
}

function buildAreaCols(areaUnit: AreaUnit, useContract: boolean): AreaCol[] {
  const fmt = areaUnit === 'pyeong' ? fmtPy : fmtSqm;
  const u   = areaUnit === 'pyeong' ? '평' : '㎡';
  const secondLabel = useContract ? '계약' : '공급';
  const secondValue = useContract
    ? (p: Property) => (p.contractSpace > 0 ? p.contractSpace : p.supplySpace)
    : (p: Property) => p.supplySpace;
  const secondSortK: SortKey = useContract ? 'contractSpace' : 'supplySpace';
  return [
    { key: 'exclusiveSpace', label: `전용(${u})`, sortK: 'exclusiveSpace', render: (p) => fmt(p.exclusiveSpace) },
    { key: 'supplySpace',    label: `${secondLabel}(${u})`, sortK: secondSortK, render: (p) => fmt(secondValue(p)) },
  ];
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="sort-icon">↕</span>;
  return <span className="sort-icon active">{dir === 'asc' ? '↑' : '↓'}</span>;
}

function priceSortValue(p: Property): number {
  if (p.tradeType === 'A1') return p.dealPrice;
  if (p.tradeType === 'B1' || p.tradeType === 'B2') return p.warrantyPrice;
  return 0;
}

function getSortValue(p: Property, key: SortKey, realEstateType: string): number | string {
  if (key === 'dealPrice')     return priceSortValue(p);
  if (key === 'pyeongPrice')   return pyeongUnitPriceWon(p, realEstateType);
  if (key === 'premiumPrice')  return p.premiumPrice;
  if (key === 'optionPrice')   return p.optionPrice;
  if (key === 'totalBuyPrice') return p.dealPrice + p.premiumPrice + p.optionPrice;
  if (key === 'realPyeongPrice') {
    const area = realEstateType === 'OBYG' ? p.exclusiveSpace : p.supplySpace;
    const pyeong = area * SQM_TO_PYEONG;
    return pyeong > 0 ? (p.dealPrice + p.premiumPrice + p.optionPrice) / pyeong : 0;
  }
  if (key === 'supplySpace')   return p.supplySpace;
  if (key === 'exclusiveSpace') return p.exclusiveSpace;
  if (key === 'contractSpace') return p.contractSpace > 0 ? p.contractSpace : p.supplySpace;
  if (key === 'floorInfo') {
    const m = p.floorInfo.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  const v = p[key as keyof Property];
  return (v as number | string) ?? '';
}

function PriceCell({ p, showPriceUp }: { p: Property; showPriceUp: boolean }) {
  return (
    <>
      {showPriceUp && p.priceChangeStatus === 1  && <span className="price-up">↑</span>}
      {showPriceUp && p.priceChangeStatus === -1 && <span className="price-down">↓</span>}
    </>
  );
}

// ─── Th with resize handle ───────────────────────────────────────────────────
interface ThProps {
  colKey: string;
  label: string;
  sortK?: SortKey;
  curSortKey: SortKey;
  curSortDir: SortDir;
  onSort: (k: SortKey) => void;
  onResizeStart: (colKey: string, e: React.MouseEvent) => void;
  className?: string;
}
function Th({ colKey, label, sortK, curSortKey, curSortDir, onSort, onResizeStart, className }: ThProps) {
  return (
    <th
      className={className}
      style={{ cursor: sortK ? 'pointer' : 'default', userSelect: 'none', position: 'relative' }}
      onClick={sortK ? () => onSort(sortK) : undefined}
    >
      {label}
      {sortK && <SortIcon active={curSortKey === sortK} dir={curSortDir} />}
      <div
        className="col-resize-handle"
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onResizeStart(colKey, e); }}
        onClick={(e) => e.stopPropagation()}
      />
    </th>
  );
}

// ─── Detail modals ────────────────────────────────────────────────────────────
type CachedDetail = ArticleDetailResult | 'loading' | 'error';

function DescModal({ detail, feature }: { detail: CachedDetail | undefined; feature: string }) {
  return (
    <div className="detail-modal-content">
      <h3 className="detail-modal-title">매물 상세설명</h3>
      {feature && <p className="detail-modal-feature">{feature}</p>}
      <div className="detail-modal-body">
        {(!detail || detail === 'loading') && (
          <span className="detail-modal-loading">불러오는 중…</span>
        )}
        {detail === 'error' && (
          <span className="detail-modal-error">데이터를 불러올 수 없습니다.</span>
        )}
        {detail && detail !== 'loading' && detail !== 'error' && (
          detail.detailDescription
            ? <pre className="detail-modal-desc">{detail.detailDescription}</pre>
            : <span className="detail-modal-empty">상세설명이 없습니다.</span>
        )}
      </div>
    </div>
  );
}

function RealtorModal({ detail, brokerageName }: { detail: CachedDetail | undefined; brokerageName: string }) {
  const clean = cleanBrokerageName(brokerageName);
  return (
    <div className="detail-modal-content">
      <h3 className="detail-modal-title">중개업소 정보</h3>
      {(!detail || detail === 'loading') && (
        <span className="detail-modal-loading">불러오는 중…</span>
      )}
      {detail === 'error' && (
        <span className="detail-modal-error">데이터를 불러올 수 없습니다.</span>
      )}
      {detail && detail !== 'loading' && detail !== 'error' && (
        <table className="realtor-info-table">
          <tbody>
            <tr><th>업소</th><td>{detail.realtorName || clean || '-'}</td></tr>
            <tr><th>주소</th><td>{detail.realtorAddress || '-'}</td></tr>
            <tr><th>연락처1</th><td>{detail.cellPhoneNo || '-'}</td></tr>
            <tr><th>연락처2</th><td>{detail.representativeTelNo || '-'}</td></tr>
            <tr><th>매매매물</th><td>{detail.dealCount}건</td></tr>
            <tr><th>전세매물</th><td>{detail.leaseCount}건</td></tr>
            <tr><th>월세매물</th><td>{detail.rentCount}건</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
interface ModalState {
  kind: 'desc' | 'realtor';
  articleNo: string;
  articleFeature: string;
  brokerageName: string;
}

export function ResultTable({ properties, realEstateType, areaUnit, priceUnit, meta, userId }: ResultTableProps) {
  const useContract = isExclusiveSpaceType(realEstateType);
  const isPresale   = isPresaleType(realEstateType);
  const presaleUseExclusive = realEstateType === 'OBYG';

  const [sortKey, setSortKey]               = useState<SortKey>('dealPrice');
  const [sortDir, setSortDir]               = useState<SortDir>('asc');
  const [filterText, setFilterText]         = useState('');
  const [complexFilter, setComplexFilter]   = useState('');
  const [tradeTypeFilter, setTradeTypeFilter] = useState('');
  const [spaceMin, setSpaceMin]             = useState(0);
  const [spaceMax, setSpaceMax]             = useState(0);
  const [page, setPage]                     = useState(0);
  const [selectedRow, setSelectedRow]       = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [modalState, setModalState]         = useState<ModalState | null>(null);
  const [detailCache, setDetailCache]       = useState<Map<string, CachedDetail>>(new Map());
  const [colWidths, setColWidths]           = useState<Record<string, number>>(() => loadColWidths(userId));
  const [isDupHidden, setIsDupHidden]       = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Sync colWidths when userId changes (login/logout)
  useEffect(() => { setColWidths(loadColWidths(userId)); }, [userId]);

  // 분양권 페이지 자동 detail 패치 (프리미엄/옵션비용은 fin.land 목록 API에 없음)
  useEffect(() => {
    if (!isPresale) return;
    const toFetch = paginated.filter((p) => !detailCacheRef.current.has(p.articleNumber));
    if (toFetch.length === 0) return;
    const timers = toFetch.map((p, i) =>
      setTimeout(() => {
        if (!detailCacheRef.current.has(p.articleNumber)) ensureDetail(p);
      }, i * 450),
    );
    return () => timers.forEach(clearTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paginated, isPresale]);

  const priceUnitLabel = priceUnit === 'thousand' ? '천원' : '만원';

  // ── Detail cache (lazy fetch) ──
  const detailCacheRef = useRef<Map<string, CachedDetail>>(new Map());
  const ensureDetail = useCallback((p: Property) => {
    const key = p.articleNumber;
    if (detailCacheRef.current.has(key)) return;
    detailCacheRef.current.set(key, 'loading');
    setDetailCache(new Map(detailCacheRef.current));
    void getArticleDetail(key, p.complexNumber > 0 ? p.complexNumber : undefined)
      .then((result) => {
        detailCacheRef.current.set(key, result ?? 'error');
        setDetailCache(new Map(detailCacheRef.current));
      })
      .catch(() => {
        detailCacheRef.current.set(key, 'error');
        setDetailCache(new Map(detailCacheRef.current));
      });
  }, []);

  const openModal = useCallback((kind: 'desc' | 'realtor', p: Property) => {
    setModalState({ kind, articleNo: p.articleNumber, articleFeature: p.articleFeature, brokerageName: p.brokerageName });
    ensureDetail(p);
  }, [ensureDetail]);

  // ── Column resize ──
  const colWidthsRef = useRef(colWidths);
  colWidthsRef.current = colWidths;
  const resizeState = useRef<{ key: string; startX: number; startW: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const rs = resizeState.current;
      if (!rs) return;
      const delta = e.clientX - rs.startX;
      const newW  = Math.max(40, rs.startW + delta);
      setColWidths((w) => ({ ...w, [rs.key]: newW }));
    };
    const onUp = () => {
      if (!resizeState.current) return;
      resizeState.current = null;
      saveColWidths(userId, colWidthsRef.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [userId]);

  const handleResizeStart = useCallback((key: string, e: React.MouseEvent) => {
    resizeState.current = {
      key,
      startX: e.clientX,
      startW: colWidthsRef.current[key] ?? DEFAULT_COL_WIDTHS[key] ?? 80,
    };
  }, []);

  const cw = (key: string) => colWidths[key] ?? DEFAULT_COL_WIDTHS[key] ?? 80;

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(0);
  };

  const dataInfo = useMemo(() => ({
    hasA1: properties.some((p) => p.tradeType === 'A1'),
    hasB:  properties.some((p) => p.tradeType === 'B1' || p.tradeType === 'B2'),
    hasB2: properties.some((p) => p.tradeType === 'B2'),
  }), [properties]);

  const complexNames = useMemo(() => {
    const set = new Set<string>();
    for (const p of properties) if (p.complexName) set.add(p.complexName);
    return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
  }, [properties]);

  // ── Grouped + sorted rows ──
  const {
    filteredReps,
    childrenByGroup,
    allFiltered,
    paginated,
    totalPages,
    safePage,
    dupCount,
  } = useMemo(() => {
    // 1. Filter all properties (reps + children)
    let fil = [...properties];
    if (complexFilter)    fil = fil.filter((p) => p.complexName === complexFilter);
    if (tradeTypeFilter)  fil = fil.filter((p) => p.tradeType   === tradeTypeFilter);

    if (spaceMin > 0 || spaceMax > 0) {
      const toSqm = (v: number) => areaUnit === 'pyeong' ? v * PYEONG_TO_SQM : v;
      const lo = spaceMin > 0 ? toSqm(spaceMin) : 0;
      const hi = spaceMax > 0 ? toSqm(spaceMax) : Number.POSITIVE_INFINITY;
      fil = fil.filter((p) => {
        if (p.supplySpace <= 0 && p.exclusiveSpace <= 0) return true;
        return (
          (p.supplySpace    > 0 && p.supplySpace    >= lo && p.supplySpace    <= hi) ||
          (p.exclusiveSpace > 0 && p.exclusiveSpace >= lo && p.exclusiveSpace <= hi)
        );
      });
    }

    if (filterText.trim()) {
      const q = filterText.trim().toLowerCase();
      fil = fil.filter((p) =>
        p.complexName.toLowerCase().includes(q) ||
        p.dongName.toLowerCase().includes(q)    ||
        p.articleFeature.toLowerCase().includes(q),
      );
    }

    // 2. Separate reps and children
    const reps = fil.filter((p) => !p.isDuplicate);
    const childrenArr = fil.filter((p) => !!p.isDuplicate);

    // Only keep children whose parent rep also passed the filter
    const repGroupIds = new Set(reps.map((p) => p.groupId).filter(Boolean) as string[]);
    const childMap = new Map<string, Property[]>();
    let dupCnt = 0;
    for (const child of childrenArr) {
      if (child.groupId && repGroupIds.has(child.groupId)) {
        const arr = childMap.get(child.groupId) ?? [];
        arr.push(child);
        childMap.set(child.groupId, arr);
        dupCnt++;
      }
    }

    // 3. Sort reps only
    const sortedReps = [...reps].sort((a, b) => {
      const av = getSortValue(a, sortKey, realEstateType);
      const bv = getSortValue(b, sortKey, realEstateType);
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv;
      } else {
        cmp = String(av).localeCompare(String(bv), 'ko');
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    // 4. All data for export (always fully expanded)
    const allFil: Property[] = sortedReps.flatMap((rep) => {
      const children = rep.groupId ? (childMap.get(rep.groupId) ?? []) : [];
      return [rep, ...children];
    });

    // 5. Display rows with expansion state
    const isGroupExpanded = (gid: string) =>
      isDupHidden ? expandedGroups.has(gid) : !expandedGroups.has(gid);

    const displayRows: Property[] = sortedReps.flatMap((rep) => {
      const children = rep.groupId ? (childMap.get(rep.groupId) ?? []) : [];
      const expanded = rep.groupId ? isGroupExpanded(rep.groupId) : false;
      return expanded ? [rep, ...children] : [rep];
    });

    // 6. Paginate
    const total = Math.ceil(displayRows.length / PAGE_SIZE);
    const safe  = Math.min(page, Math.max(0, total - 1));
    const pag   = displayRows.slice(safe * PAGE_SIZE, (safe + 1) * PAGE_SIZE);

    return {
      filteredReps: sortedReps,
      childrenByGroup: childMap,
      allFiltered: allFil,
      paginated: pag,
      totalPages: total,
      safePage: safe,
      dupCount: dupCnt,
    };
  }, [
    properties, complexFilter, tradeTypeFilter, spaceMin, spaceMax, areaUnit,
    filterText, sortKey, sortDir, page, realEstateType, isDupHidden, expandedGroups,
  ]);

  const hasActiveFilter = !!(complexFilter || tradeTypeFilter || filterText || spaceMin > 0 || spaceMax > 0);
  const areaCols = useMemo(() => buildAreaCols(areaUnit, useContract), [areaUnit, useContract]);

  // ── Active column keys for colgroup ──
  const activeColKeys = useMemo(() => {
    const keys = ['midName', 'smallName', 'tradeType', 'complexName', 'dongName', 'floorInfo', 'direction', 'supplySpaceName'];
    areaCols.forEach((c) => keys.push(c.key));
    if (dataInfo.hasA1) keys.push('dealPrice', 'pyeongPrice');
    if (isPresale) keys.push('premiumPrice', 'optionPrice', 'totalBuyPrice', 'realPyeongPrice');
    if (dataInfo.hasB) keys.push('warrantyPrice');
    if (dataInfo.hasB2) keys.push('rentPrice');
    keys.push('feature', 'brokerage');
    return keys;
  }, [areaCols, dataInfo, isPresale]);

  const totalTableWidth = useMemo(
    () => activeColKeys.reduce((sum, k) => sum + cw(k), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeColKeys, colWidths],
  );

  // ── Presale effective values (use detail cache if available) ──
  const getEffPremium = (p: Property) => {
    const d = detailCache.get(p.articleNumber);
    return (d && d !== 'loading' && d !== 'error') ? d.premiumPrice : p.premiumPrice;
  };
  const getEffOption = (p: Property) => {
    const d = detailCache.get(p.articleNumber);
    return (d && d !== 'loading' && d !== 'error') ? d.optionPrice : p.optionPrice;
  };

  // ── Common th props ──
  const thProps = { curSortKey: sortKey, curSortDir: sortDir, onSort: handleSort, onResizeStart: handleResizeStart };

  const totalCols = activeColKeys.length;

  return (
    <div className="result-table-container">
      {/* Toolbar */}
      <div className="result-toolbar">
        <div className="result-info">
          <span className="result-count">
            총 <strong>{(filteredReps.length + dupCount).toLocaleString()}</strong>건
            {dupCount > 0 && <span className="dup-count-hint"> (대표 {filteredReps.length.toLocaleString()}건, 중복 {dupCount.toLocaleString()}건)</span>}
            {' · '}<strong>{complexNames.length.toLocaleString()}</strong>개 단지
            {hasActiveFilter && ` → 필터: ${filteredReps.length.toLocaleString()}건`}
          </span>
        </div>

        <div className="result-actions">
          {dupCount > 0 && (
            <button
              className="btn-outline btn-sm dup-toggle-btn"
              onClick={() => {
                setIsDupHidden((prev) => !prev);
                setExpandedGroups(new Set());
                setPage(0);
              }}
            >
              {isDupHidden ? `중복 표시 (${dupCount})` : '중복 숨김'}
            </button>
          )}

          <select className="form-select" style={{ width: 'auto', minWidth: '140px' }}
            value={complexFilter} onChange={(e) => { setComplexFilter(e.target.value); setPage(0); }}>
            <option value="">전체 단지</option>
            {complexNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>

          <select className="form-select" style={{ width: 'auto', minWidth: '100px' }}
            value={tradeTypeFilter} onChange={(e) => { setTradeTypeFilter(e.target.value); setPage(0); }}>
            <option value="">전체 거래</option>
            {TRADE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>

          <div className="result-space-filter">
            <input type="number" className="search-input" style={{ width: '70px' }} placeholder="최소"
              min={0} value={spaceMin || ''} onChange={(e) => { setSpaceMin(Number(e.target.value) || 0); setPage(0); }} />
            <span className="space-tilde">~</span>
            <input type="number" className="search-input" style={{ width: '70px' }} placeholder="최대"
              min={0} value={spaceMax || ''} onChange={(e) => { setSpaceMax(Number(e.target.value) || 0); setPage(0); }} />
            <span className="space-unit-hint" title="면적 표시 단위는 검색 조건에서 변경">
              {areaUnit === 'pyeong' ? '평' : '㎡'}
            </span>
          </div>

          <input className="search-input" type="text" placeholder="단지명/특징 검색..."
            value={filterText} onChange={(e) => { setFilterText(e.target.value); setPage(0); }} />

          <button className="btn-outline btn-sm"
            onClick={() => void exportExcel(allFiltered, priceUnit, areaUnit, realEstateType, buildExportBaseName(meta, allFiltered.length))}
            disabled={allFiltered.length === 0}>
            Excel 내보내기
          </button>
          <button className="btn-outline btn-sm"
            onClick={() => exportJSON(allFiltered, buildExportBaseName(meta, allFiltered.length))}
            disabled={allFiltered.length === 0}>
            JSON 내보내기
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="table-wrapper">
        <table className="result-table" style={{ tableLayout: 'fixed', width: totalTableWidth }}>
          <colgroup>
            {activeColKeys.map((k) => <col key={k} style={{ width: cw(k) }} />)}
          </colgroup>
          <thead>
            <tr>
              <Th colKey="midName"       label="중지역"     sortK="midName"         {...thProps} className="th-region" />
              <Th colKey="smallName"     label="소지역"     sortK="smallName"       {...thProps} className="th-region" />
              <Th colKey="tradeType"     label="거래"       sortK="tradeType"       {...thProps} />
              <Th colKey="complexName"   label="단지명"     sortK="complexName"     {...thProps} />
              <Th colKey="dongName"      label="동"         sortK="dongName"        {...thProps} />
              <Th colKey="floorInfo"     label="층"         sortK="floorInfo"       {...thProps} />
              <Th colKey="direction"     label="방향"       sortK="direction"       {...thProps} />
              <Th colKey="supplySpaceName" label="타입"     sortK="supplySpaceName" {...thProps} />
              {areaCols.map((col) => (
                <Th key={col.key} colKey={col.key} label={col.label} sortK={col.sortK} {...thProps} />
              ))}
              {dataInfo.hasA1 && (
                <Th colKey="dealPrice"  label={`매매가(${priceUnitLabel})`}  sortK="dealPrice"  {...thProps} />
              )}
              {dataInfo.hasA1 && (
                <Th colKey="pyeongPrice" label={`평당가(${priceUnitLabel})`} sortK="pyeongPrice" {...thProps} />
              )}
              {isPresale && (
                <Th colKey="premiumPrice"   label={`프리미엄(${priceUnitLabel})`}  sortK="premiumPrice"   {...thProps} />
              )}
              {isPresale && (
                <Th colKey="optionPrice"    label={`옵션비용(${priceUnitLabel})`}  sortK="optionPrice"    {...thProps} />
              )}
              {isPresale && (
                <Th colKey="totalBuyPrice"  label={`매수비용(${priceUnitLabel})`}  sortK="totalBuyPrice"  {...thProps} />
              )}
              {isPresale && (
                <Th colKey="realPyeongPrice" label={`실평당가(${priceUnitLabel})`} sortK="realPyeongPrice" {...thProps} />
              )}
              {dataInfo.hasB && (
                <Th colKey="warrantyPrice" label={`보증금(${priceUnitLabel})`} sortK="dealPrice" {...thProps} />
              )}
              {dataInfo.hasB2 && (
                <Th colKey="rentPrice" label={`월세(${priceUnitLabel})`} curSortKey={sortKey} curSortDir={sortDir} onSort={handleSort} onResizeStart={handleResizeStart} />
              )}
              <Th colKey="feature"   label="특징"     {...thProps} />
              <Th colKey="brokerage" label="중개업소" {...thProps} />
            </tr>
          </thead>
          <tbody>
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={totalCols} className="table-empty">
                  {properties.length === 0 ? '수집된 매물이 없습니다' : '검색 결과가 없습니다'}
                </td>
              </tr>
            ) : (
              paginated.map((p, idx) => {
                const rowKey = p._uid ? String(p._uid) : (p.articleNumber || String(idx));
                const isSelected = selectedRow === rowKey;
                const isDup = !!p.isDuplicate;

                // Badge: actual children count for rep, or legacy realtorCount fallback
                const actualChildCount = (!isDup && p.groupId)
                  ? (childrenByGroup.get(p.groupId)?.length ?? 0)
                  : 0;
                const badgeCount = actualChildCount > 0
                  ? actualChildCount
                  : (!isDup && p.realtorCount > 1 ? p.realtorCount - 1 : 0);
                const isExpandable = !isDup && !!p.groupId && actualChildCount > 0;
                const isExpanded = isExpandable && (
                  isDupHidden ? expandedGroups.has(p.groupId!) : !expandedGroups.has(p.groupId!)
                );
                // 대표 행을 선택하면 중복 하위 행도 같이 강조
                const isInSelectedGroup = !!(isDup && p.groupId && selectedGroupId === p.groupId);
                const isHighlighted = selectedRow === rowKey || isInSelectedGroup;

                const effPremium = getEffPremium(p);
                const effOption  = getEffOption(p);
                const totalBuy   = p.dealPrice + effPremium + effOption;
                const presaleArea = presaleUseExclusive ? p.exclusiveSpace : p.supplySpace;
                const realPyeong  = presaleArea * SQM_TO_PYEONG;
                const realPyeongPrice = realPyeong > 0 ? totalBuy / realPyeong : 0;

                return (
                  <tr
                    key={rowKey}
                    className={[
                      isHighlighted ? 'row-selected' : '',
                      isDup ? 'row-duplicate' : '',
                    ].filter(Boolean).join(' ') || undefined}
                    onClick={() => {
                      const isAlreadySel = selectedRow === rowKey;
                      setSelectedRow(isAlreadySel ? null : rowKey);
                      setSelectedGroupId(isAlreadySel ? null : (p.groupId ?? null));
                    }}
                    onDoubleClick={() => {
                      if (!isExpandable) return;
                      setExpandedGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.groupId!)) next.delete(p.groupId!);
                        else next.add(p.groupId!);
                        return next;
                      });
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <td className="td-region">{p.midName || '-'}</td>
                    <td className="td-region">{p.smallName || '-'}</td>
                    <td>
                      <span className={`trade-badge trade-${p.tradeType}`}>
                        {TRADE_TYPE_LABELS[p.tradeType] ?? p.tradeType}
                      </span>
                    </td>
                    <td>
                      <div className="td-complex">
                        {isDup && <span className="dup-indent">└</span>}
                        <span className="complex-name">{p.complexName}</span>
                        {badgeCount > 0 && (
                          <span
                            className="realtor-badge"
                            title={isExpandable ? '더블클릭으로 펼치기/접기' : undefined}
                          >
                            +{badgeCount}
                          </span>
                        )}
                        {isExpandable && (
                          <span className="group-expand-icon">{isExpanded ? '▾' : '▸'}</span>
                        )}
                      </div>
                    </td>
                    <td>{p.dongName || '-'}</td>
                    <td>{p.floorInfo || '-'}</td>
                    <td>{formatDirection(p.direction) || '-'}</td>
                    <td>{p.supplySpaceName || '-'}</td>
                    {areaCols.map((col) => (
                      <td key={col.key} className="td-space">{col.render(p)}</td>
                    ))}

                    {dataInfo.hasA1 && (
                      <td className="td-price">
                        <div className="td-price-inner">
                          {p.tradeType === 'A1' ? (
                            <>
                              <span className="price-value">{formatPriceByUnit(p.dealPrice, priceUnit)}</span>
                              <PriceCell p={p} showPriceUp={true} />
                            </>
                          ) : <span className="td-empty">-</span>}
                        </div>
                      </td>
                    )}

                    {dataInfo.hasA1 && (
                      <td className="td-pyeong">
                        {p.tradeType === 'A1'
                          ? formatPriceByUnit(pyeongUnitPriceWon(p, realEstateType), priceUnit)
                          : '-'}
                      </td>
                    )}

                    {isPresale && (
                      <td className="td-price presale-col">
                        {effPremium > 0 ? formatPriceByUnit(effPremium, priceUnit) : '-'}
                      </td>
                    )}
                    {isPresale && (
                      <td className="td-price presale-col">
                        {effOption > 0 ? formatPriceByUnit(effOption, priceUnit) : '-'}
                      </td>
                    )}
                    {isPresale && (
                      <td className="td-price presale-col presale-total">
                        {totalBuy > 0 ? formatPriceByUnit(totalBuy, priceUnit) : '-'}
                      </td>
                    )}
                    {isPresale && (
                      <td className="td-pyeong presale-col">
                        {realPyeongPrice > 0 ? formatPriceByUnit(realPyeongPrice, priceUnit) : '-'}
                      </td>
                    )}

                    {dataInfo.hasB && (
                      <td className="td-price">
                        <div className="td-price-inner">
                          {(p.tradeType === 'B1' || p.tradeType === 'B2') ? (
                            <>
                              <span className="price-value">{formatPriceByUnit(p.warrantyPrice, priceUnit)}</span>
                              <PriceCell p={p} showPriceUp={p.tradeType === 'B1'} />
                            </>
                          ) : <span className="td-empty">-</span>}
                        </div>
                      </td>
                    )}

                    {dataInfo.hasB2 && (
                      <td className="td-price">
                        <div className="td-price-inner">
                          {p.tradeType === 'B2'
                            ? <span className="price-value">{formatPriceByUnit(p.rentPrice, priceUnit)}</span>
                            : <span className="td-empty">-</span>}
                        </div>
                      </td>
                    )}

                    {/* 특징 + 상세설명 버튼 */}
                    <td className="td-feature">
                      <div className="td-cell-with-btn">
                        <span className="td-cell-text">{p.articleFeature || '-'}</span>
                        <button
                          className="detail-plus-btn"
                          title="상세설명 보기"
                          onClick={(e) => { e.stopPropagation(); openModal('desc', p); }}
                        >+</button>
                      </div>
                    </td>

                    {/* 중개업소 + 상세정보 버튼 */}
                    <td className="td-brokerage">
                      <div className="td-cell-with-btn">
                        <span className="td-cell-text">{cleanBrokerageName(p.brokerageName) || '-'}</span>
                        <button
                          className="detail-plus-btn"
                          title="중개업소 정보 보기"
                          onClick={(e) => { e.stopPropagation(); openModal('realtor', p); }}
                        >+</button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="pagination">
          <button className="btn-ghost btn-sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}>
            ← 이전
          </button>
          <span className="page-info">{safePage + 1} / {totalPages}</span>
          <button className="btn-ghost btn-sm"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={safePage >= totalPages - 1}>
            다음 →
          </button>
        </div>
      )}

      {/* Detail / Realtor modal */}
      {modalState && (
        <div className="modal-overlay" onClick={() => setModalState(null)}>
          <div className="modal-card detail-modal-card" onClick={(e) => e.stopPropagation()}>
            <button className="cm-close" onClick={() => setModalState(null)}>✕</button>
            {modalState.kind === 'desc' && (
              <DescModal
                detail={detailCache.get(modalState.articleNo)}
                feature={modalState.articleFeature}
              />
            )}
            {modalState.kind === 'realtor' && (
              <RealtorModal
                detail={detailCache.get(modalState.articleNo)}
                brokerageName={modalState.brokerageName}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
