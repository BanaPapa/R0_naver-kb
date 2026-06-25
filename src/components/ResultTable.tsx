import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Property, SearchMeta, TRADE_TYPE_LABELS, TRADE_TYPES, isExclusiveSpaceType, isPresaleType } from '../types';
import {
  formatPriceByUnit, formatPremiumByUnit, formatDirection, cleanBrokerageName, pyeongUnitPriceWon,
  exportExcel, exportJSON, exportMarkdown, buildExportBaseName, PriceUnit, AreaUnit,
} from '../services/api';
import {
  getArticleDetail, ArticleDetailResult,
  getComplexDetail, ComplexDetailResult,
  getAcquisitionCost, AcquisitionCostResult,
} from '../services/naverApi';
import { randomDelay } from '../services/utils';
import { RangeSlider } from './RangeSlider';

export interface TableStats {
  avgDealPrice: number;    // 원 단위
  avgPyeongPrice: number;  // 원/평 단위
  avgPresaleTotal: number; // 원 단위 (분양권 총 매수비용, 0 if non-presale)
  count: number;           // 평균 계산 대상 매물 수
}

interface ResultTableProps {
  searchKey: number;      // 새 검색마다 증가 — sort/filter 유지하되 캐시만 초기화
  status: string;         // 크롤 상태 — 수집 완료(done/stopped) 후 분양권 가격 prefetch 트리거
  properties: Property[];
  realEstateType: string;
  areaUnit: AreaUnit;
  priceUnit: PriceUnit;
  meta: SearchMeta;
  userId: string | null;
  onStatsChange?: (stats: TableStats) => void;
}

type SortKey =
  | 'midName' | 'smallName' | 'tradeType' | 'complexName' | 'dongName' | 'floorInfo' | 'direction'
  | 'supplySpaceName' | 'supplySpace' | 'exclusiveSpace' | 'contractSpace' | 'dealPrice' | 'pyeongPrice'
  | 'isalePrice' | 'isalePyeong' | 'premiumPrice' | 'optionPrice' | 'totalBuyPrice' | 'realPyeongPrice';
type SortDir = 'asc' | 'desc';
type ExportFormat = 'excel' | 'json' | 'md';
const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = { excel: 'Excel', json: 'JSON', md: '마크다운' };

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
  isalePrice: 104, isalePyeong: 110, premiumPrice: 72, optionPrice: 88, totalBuyPrice: 110, realPyeongPrice: 120,
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

function stablePropertyIdentity(p: Property): string {
  const primary = p.articleNumber?.trim();
  if (primary) return primary;
  return stableVisualIdentity(p);
}

function stableVisualIdentity(p: Property): string {
  return [
    p.groupId ?? '',
    p.complexNumber,
    p.complexName,
    p.dongName,
    p.floorInfo,
    p.direction,
    p.supplySpaceName,
    p.supplySpace,
    p.exclusiveSpace,
    p.dealPrice,
    p.warrantyPrice,
    p.rentPrice,
    p.premiumPrice,
    p.optionPrice,
    p.brokerageName,
    p.articleFeature,
  ].join('|');
}

function stableRepresentativeIdentity(p: Property): string {
  return p.groupId?.trim() || stablePropertyIdentity(p);
}

function stableChildIdentity(p: Property): string {
  return stableVisualIdentity(p);
}

function getSortValue(p: Property, key: SortKey, realEstateType: string): number | string {
  if (key === 'dealPrice')     return priceSortValue(p);
  if (key === 'pyeongPrice')   return pyeongUnitPriceWon(p, realEstateType);
  if (key === 'isalePrice')    return p.isalePrice;
  if (key === 'isalePyeong') {
    const area = realEstateType === 'OBYG' ? p.exclusiveSpace : p.supplySpace;
    const pyeong = area * SQM_TO_PYEONG;
    return pyeong > 0 && p.isalePrice > 0 ? p.isalePrice / pyeong : 0;
  }
  if (key === 'premiumPrice')  return p.premiumPrice;
  if (key === 'optionPrice')   return p.optionPrice;
  if (key === 'totalBuyPrice') return p.isalePrice + p.premiumPrice + p.optionPrice;
  if (key === 'realPyeongPrice') {
    const area = realEstateType === 'OBYG' ? p.exclusiveSpace : p.supplySpace;
    const pyeong = area * SQM_TO_PYEONG;
    return pyeong > 0 ? (p.isalePrice + p.premiumPrice + p.optionPrice) / pyeong : 0;
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
      style={{ cursor: sortK ? 'pointer' : 'default', userSelect: 'none' }}
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
type CachedDetail         = ArticleDetailResult   | 'loading' | 'error';

// 분양권 총매매가(원) — 상세캐시(detailCache)에 가격이 있으면 그 값, 없으면 base property 값.
// 정렬·필터·슬라이더 범위가 화면 표시값과 일치하도록 공용으로 쓴다.
function effPresaleTotalWon(p: Property, cache: Map<string, CachedDetail>): number {
  const d = cache.get(p.articleNumber);
  const ok = d && d !== 'loading' && d !== 'error';
  return (ok ? d.isalePrice : p.isalePrice)
    + (ok ? d.premiumPrice : p.premiumPrice)
    + (ok ? d.optionPrice : p.optionPrice);
}
type CachedComplexDetail  = ComplexDetailResult   | 'loading' | 'error';
type CachedAcquisitionCost = AcquisitionCostResult | 'loading' | 'error';

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

// ─── 단지 정보 모달 ───────────────────────────────────────────────────────────
function ComplexInfoModal({ detail }: { detail: CachedComplexDetail | undefined }) {
  const fmtDate = (d: string) =>
    d && d.length >= 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}` : (d || '-');

  return (
    <div className="detail-modal-content">
      <h3 className="detail-modal-title">단지 정보</h3>
      {(!detail || detail === 'loading') && <span className="detail-modal-loading">불러오는 중…</span>}
      {detail === 'error' && <span className="detail-modal-error">정보를 불러올 수 없습니다.</span>}
      {detail && detail !== 'loading' && detail !== 'error' && (
        <table className="realtor-info-table">
          <tbody>
            <tr><th>입주일</th><td>{fmtDate(detail.aptUseApproveYmd)}</td></tr>
            <tr><th>세대수</th><td>
              {detail.aptHouseholdCount > 0 ? `${detail.aptHouseholdCount.toLocaleString()}세대` : '-'}
              {detail.totalDongCount > 0 && ` (${detail.totalDongCount}개동`}
              {detail.complexHighestFloor > 0 && `, ${detail.complexHighestFloor}F`}
              {detail.totalDongCount > 0 && ')'}
            </td></tr>
            <tr><th>세대당 주차</th><td>
              {detail.aptParkingCountPerHousehold > 0 ? `${detail.aptParkingCountPerHousehold}대` : '-'}
            </td></tr>
            <tr><th>시공사</th><td>{detail.aptConstructionCompanyName || '-'}</td></tr>
            <tr><th>용적률/건폐율</th><td>
              {detail.floorAreaRatio > 0 ? `${detail.floorAreaRatio}%` : '-'}
              {detail.buildingCoverageRatio > 0 && ` / ${detail.buildingCoverageRatio}%`}
            </td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── 매입비용 모달 ────────────────────────────────────────────────────────────
function AcquisitionCostModal({ detail, buyPrice }: { detail: CachedAcquisitionCost | undefined; buyPrice: number }) {
  const [includeFees, setIncludeFees] = React.useState(false);
  const fmtWon = (v: number) => v > 0 ? `${v.toLocaleString()}원` : '-';
  const adjTotal = detail && detail !== 'loading' && detail !== 'error'
    ? buyPrice + detail.totalPrice : 0;

  return (
    <div className="detail-modal-content">
      <h3 className="detail-modal-title">매입비용</h3>
      <label className="acq-include-toggle">
        <input type="checkbox" checked={includeFees} onChange={(e) => setIncludeFees(e.target.checked)} />
        매입비용을 매수비용에 포함
        {includeFees && adjTotal > 0 && (
          <span className="acq-total-incl"> → {adjTotal.toLocaleString()}원</span>
        )}
      </label>
      {(!detail || detail === 'loading') && <span className="detail-modal-loading">불러오는 중…</span>}
      {detail === 'error' && <span className="detail-modal-error">비용을 계산할 수 없습니다.</span>}
      {detail && detail !== 'loading' && detail !== 'error' && (
        <table className="realtor-info-table acq-table">
          <tbody>
            <tr><th>취득세</th><td>{fmtWon(detail.acquisitionTax)}</td></tr>
            <tr><th>교육세</th><td>{fmtWon(detail.eduTax)}</td></tr>
            <tr><th>농어촌특별세</th><td>{fmtWon(detail.specialTax)}</td></tr>
            <tr className="acq-total-row"><th>매입비용 총액</th><td>{fmtWon(detail.totalPrice)}</td></tr>
            <tr><th>중개보수</th><td>{fmtWon(detail.brokerFee)}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
interface ModalState {
  kind: 'desc' | 'realtor' | 'complex-info' | 'acquisition-cost';
  articleNo: string;
  articleFeature: string;
  brokerageName: string;
  complexNo?: number;   // complex-info
  buyPrice?: number;    // acquisition-cost: 원 단위
}

export function ResultTable({ searchKey, status, properties, realEstateType, areaUnit, priceUnit, meta, userId, onStatsChange }: ResultTableProps) {
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
  const [priceMin, setPriceMin]             = useState(0); // 만원 단위
  const [priceMax, setPriceMax]             = useState(0); // 만원 단위
  const [page, setPage]                     = useState(0);
  const [selectedRow, setSelectedRow]       = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [modalState, setModalState]         = useState<ModalState | null>(null);
  const [detailCache, setDetailCache]             = useState<Map<string, CachedDetail>>(new Map());
  const [complexInfoCache, setComplexInfoCache]   = useState<Map<number, CachedComplexDetail>>(new Map());
  const [acquisitionCostCache, setAcquisitionCostCache] = useState<Map<string, CachedAcquisitionCost>>(new Map());
  const [colWidths, setColWidths]           = useState<Record<string, number>>(() => loadColWidths(userId));
  const [isDupHidden, setIsDupHidden]       = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [exportFetchProgress, setExportFetchProgress] = useState<{ current: number; total: number } | null>(null);
  const [exportConfirm, setExportConfirm]   = useState<ExportFormat | null>(null);
  const [exportIncludeDup, setExportIncludeDup]       = useState(true);
  const [exportIncludeDetail, setExportIncludeDetail] = useState(false);
  const exportCancelRef = useRef(false);

  const openExportConfirm = useCallback((format: ExportFormat) => {
    setExportIncludeDup(true);
    setExportIncludeDetail(false);
    setExportConfirm(format);
  }, []);

  // Sync colWidths when userId changes (login/logout)
  useEffect(() => { setColWidths(loadColWidths(userId)); }, [userId]);

  // 새 검색 감지: sort/filter는 유지하고 페이지·단지필터·상세캐시만 초기화
  const prevSearchKeyRef = useRef(searchKey);
  useEffect(() => {
    if (prevSearchKeyRef.current === searchKey) return;
    prevSearchKeyRef.current = searchKey;
    setPage(0);
    setComplexFilter('');
    setExpandedGroups(new Set());
    setSelectedRow(null);
    setSelectedGroupId(null);
    setModalState(null);
    detailCacheRef.current = new Map();
    setDetailCache(new Map());
    complexInfoCacheRef.current = new Map();
    setComplexInfoCache(new Map());
    acquisitionCostCacheRef.current = new Map();
    setAcquisitionCostCache(new Map());
  }, [searchKey]);

  const priceUnitLabel = priceUnit === 'thousand' ? '천원' : '만원';

  // ── Detail / ComplexInfo / AcquisitionCost cache refs (persist across renders) ──
  const complexInfoCacheRef      = useRef<Map<number, CachedComplexDetail>>(new Map());
  const acquisitionCostCacheRef  = useRef<Map<string, CachedAcquisitionCost>>(new Map());

  // ── Detail cache (lazy fetch) ──
  const detailCacheRef = useRef<Map<string, CachedDetail>>(new Map());
  const ensureDetail = useCallback((p: Property) => {
    const key = p.articleNumber;
    // 성공 결과 또는 진행 중이면 스킵. 'error'는 재시도 허용(일시적 오프라인 대비).
    const cur = detailCacheRef.current.get(key);
    if (cur && cur !== 'error') return;
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

  const ensureComplexDetail = useCallback((complexNo: number) => {
    if (complexInfoCacheRef.current.has(complexNo)) return;
    complexInfoCacheRef.current.set(complexNo, 'loading');
    setComplexInfoCache(new Map(complexInfoCacheRef.current));
    void getComplexDetail(complexNo)
      .then((r) => { complexInfoCacheRef.current.set(complexNo, r ?? 'error'); setComplexInfoCache(new Map(complexInfoCacheRef.current)); })
      .catch(() => { complexInfoCacheRef.current.set(complexNo, 'error'); setComplexInfoCache(new Map(complexInfoCacheRef.current)); });
  }, []);

  const ensureAcquisitionCost = useCallback((articleNo: string, complexNo: number, priceWon: number) => {
    if (acquisitionCostCacheRef.current.has(articleNo)) return;
    acquisitionCostCacheRef.current.set(articleNo, 'loading');
    setAcquisitionCostCache(new Map(acquisitionCostCacheRef.current));
    void getAcquisitionCost(articleNo, complexNo, priceWon)
      .then((r) => { acquisitionCostCacheRef.current.set(articleNo, r ?? 'error'); setAcquisitionCostCache(new Map(acquisitionCostCacheRef.current)); })
      .catch(() => { acquisitionCostCacheRef.current.set(articleNo, 'error'); setAcquisitionCostCache(new Map(acquisitionCostCacheRef.current)); });
  }, []);

  const openModal = useCallback((kind: 'desc' | 'realtor', p: Property) => {
    setModalState({ kind, articleNo: p.articleNumber, articleFeature: p.articleFeature, brokerageName: p.brokerageName });
    ensureDetail(p);
  }, [ensureDetail]);

  const openComplexModal = useCallback((p: Property) => {
    setModalState({ kind: 'complex-info', articleNo: p.articleNumber, articleFeature: '', brokerageName: '', complexNo: p.complexNumber });
    if (p.complexNumber > 0) ensureComplexDetail(p.complexNumber);
  }, [ensureComplexDetail]);

  const openAcquisitionModal = useCallback((p: Property, priceWon: number) => {
    setModalState({ kind: 'acquisition-cost', articleNo: p.articleNumber, articleFeature: '', brokerageName: '', complexNo: p.complexNumber, buyPrice: priceWon });
    ensureAcquisitionCost(p.articleNumber, p.complexNumber, priceWon);
  }, [ensureAcquisitionCost]);

  // ── Table wrapper ref (scroll-to-top on sort) ──
  const tableWrapperRef = useRef<HTMLDivElement>(null);

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
    setIsDupHidden(true);
    setExpandedGroups(new Set());
    setSelectedRow(null);
    setSelectedGroupId(null);
    setPage(0);
    tableWrapperRef.current?.scrollTo({ top: 0 });
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
    // 1. 모든 필터는 '대표(rep)' 에만 적용한다. 중복(children)은 독립적으로
    //    필터/정렬하지 않고, 통과한 대표를 따라다니는 '접힌 폴더'로 취급한다.
    const uniqueReps: Property[] = [];
    const seenReps = new Set<string>();
    for (const p of properties) {
      if (p.isDuplicate) continue;
      const key = stableRepresentativeIdentity(p);
      if (seenReps.has(key)) continue;
      seenReps.add(key);
      uniqueReps.push(p);
    }

    let reps = uniqueReps;
    if (complexFilter)    reps = reps.filter((p) => p.complexName === complexFilter);
    if (tradeTypeFilter)  reps = reps.filter((p) => p.tradeType   === tradeTypeFilter);

    if (spaceMin > 0 || spaceMax > 0) {
      const toSqm = (v: number) => areaUnit === 'pyeong' ? v * PYEONG_TO_SQM : v;
      const lo = spaceMin > 0 ? toSqm(spaceMin) : 0;
      const hi = spaceMax > 0 ? toSqm(spaceMax) : Number.POSITIVE_INFINITY;
      reps = reps.filter((p) => {
        if (p.supplySpace <= 0 && p.exclusiveSpace <= 0) return true;
        return (
          (p.supplySpace    > 0 && p.supplySpace    >= lo && p.supplySpace    <= hi) ||
          (p.exclusiveSpace > 0 && p.exclusiveSpace >= lo && p.exclusiveSpace <= hi)
        );
      });
    }

    if (priceMin > 0 || priceMax > 0) {
      const lo = priceMin > 0 ? priceMin * 10_000 : 0;
      const hi = priceMax > 0 ? priceMax * 10_000 : Number.POSITIVE_INFINITY;
      reps = reps.filter((p) => {
        // 대표 가격(원): 분양권=총매매가(상세캐시 반영), 전세=보증금, 월세=월세, 그 외=매매가
        const price = isPresale
          ? effPresaleTotalWon(p, detailCache)
          : p.tradeType === 'B1' ? p.warrantyPrice
            : p.tradeType === 'B2' ? p.rentPrice
              : p.dealPrice;
        if (price <= 0) return true; // 가격 미상 매물은 제외하지 않음 (면적 필터와 동일 정책)
        return price >= lo && price <= hi;
      });
    }

    if (filterText.trim()) {
      const q = filterText.trim().toLowerCase();
      reps = reps.filter((p) =>
        p.complexName.toLowerCase().includes(q) ||
        p.dongName.toLowerCase().includes(q)    ||
        p.articleFeature.toLowerCase().includes(q),
      );
    }

    // 2. 통과한 대표의 자식(중복)을 원래 순서 그대로 attach.
    //    자식은 필터 대상이 아니므로, 대표가 통과하면 그 자식은 전부 따라온다.
    const passedGroupIds = new Set(reps.map((p) => p.groupId).filter(Boolean) as string[]);
    const childMap = new Map<string, Property[]>();
    const seenChildrenByGroup = new Map<string, Set<string>>();
    let dupCnt = 0;
    for (const p of properties) {
      if (p.isDuplicate && p.groupId && passedGroupIds.has(p.groupId)) {
        const childKey = stableChildIdentity(p);
        const seenChildren = seenChildrenByGroup.get(p.groupId) ?? new Set<string>();
        if (seenChildren.has(childKey)) continue;
        seenChildren.add(childKey);
        seenChildrenByGroup.set(p.groupId, seenChildren);

        const arr = childMap.get(p.groupId) ?? [];
        arr.push(p);
        childMap.set(p.groupId, arr);
        dupCnt++;
      }
    }

    // 3. 정렬은 '대표' 에만 적용. 분양권 가격 컬럼은 상세캐시(detailCache) 반영값으로
    //    정렬해 화면 표시값과 어긋나지 않게 한다.
    const PRESALE_PRICE_KEYS = new Set<SortKey>([
      'isalePrice', 'isalePyeong', 'premiumPrice', 'optionPrice', 'totalBuyPrice', 'realPyeongPrice',
    ]);
    const sortVal = (p: Property): number | string => {
      if (isPresale && PRESALE_PRICE_KEYS.has(sortKey)) {
        const d = detailCache.get(p.articleNumber);
        const ok = d && d !== 'loading' && d !== 'error';
        const isale   = ok ? d.isalePrice   : p.isalePrice;
        const premium = ok ? d.premiumPrice : p.premiumPrice;
        const option  = ok ? d.optionPrice  : p.optionPrice;
        const area    = realEstateType === 'OBYG' ? p.exclusiveSpace : p.supplySpace;
        const pyeong  = area * SQM_TO_PYEONG;
        switch (sortKey) {
          case 'isalePrice':      return isale;
          case 'isalePyeong':     return pyeong > 0 && isale > 0 ? isale / pyeong : 0;
          case 'premiumPrice':    return premium;
          case 'optionPrice':     return option;
          case 'totalBuyPrice':   return isale + premium + option;
          case 'realPyeongPrice': return pyeong > 0 ? (isale + premium + option) / pyeong : 0;
        }
      }
      return getSortValue(p, sortKey, realEstateType);
    };
    const cmp = (a: Property, b: Property): number => {
      const av = sortVal(a);
      const bv = sortVal(b);
      const c = (typeof av === 'number' && typeof bv === 'number')
        ? av - bv
        : String(av).localeCompare(String(bv), 'ko');
      return sortDir === 'asc' ? c : -c;
    };

    const sortedReps = [...reps].sort(cmp);

    // 4. All data for export (reps sorted + each rep's children in original order)
    const allFil: Property[] = sortedReps
      .flatMap((rep) => [rep, ...(childMap.get(rep.groupId!) ?? [])]);

    // 5. Display rows with expansion state
    const isGroupExpanded = (gid: string) =>
      !isDupHidden || expandedGroups.has(gid);

    // 부모(rep)만 정렬 기준으로 순서 결정.
    // 자식은 정렬 대상이 아니며, 부모 바로 아래에 원래 순서 그대로 붙는다.
    // 부모가 어디로 이동하든 자식은 항상 해당 부모 바로 아래에만 위치한다.
    const displayGroups: Property[][] = sortedReps.map((rep) => {
      const children = rep.groupId ? (childMap.get(rep.groupId) ?? []) : [];
      const expanded = rep.groupId ? isGroupExpanded(rep.groupId) : false;
      return expanded ? [rep, ...children] : [rep];
    });

    // 6. Paginate
    const pages: Property[][] = [];
    let curPage: Property[] = [];
    for (const group of displayGroups) {
      if (curPage.length > 0 && curPage.length + group.length > PAGE_SIZE) {
        pages.push(curPage);
        curPage = [];
      }
      curPage.push(...group);
    }
    if (curPage.length > 0) pages.push(curPage);

    const total = pages.length;
    const safe  = Math.min(page, Math.max(0, total - 1));
    const pag   = pages[safe] ?? [];

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
    properties, complexFilter, tradeTypeFilter, spaceMin, spaceMax, priceMin, priceMax, areaUnit,
    filterText, sortKey, sortDir, page, realEstateType, isDupHidden, expandedGroups, detailCache,
  ]);

  // 내보내기: 상세특징/중개업소 정보는 "+" 버튼을 눌러야만 채워지는 지연 캐시이므로,
  // 사용자가 포함을 선택한 경우에만 캐시에 없는 매물을 상세 API로 보강 수집한다 (차단 회피용 순차 + 딜레이).
  const performExport = useCallback(async (format: ExportFormat, includeDetail: boolean, includeDup: boolean) => {
    const rows = includeDup ? allFiltered : filteredReps;
    if (rows.length === 0) return;
    const filenameBase = buildExportBaseName(meta, rows.length);

    if (includeDetail) {
      const missing = rows.filter((p) => {
        const cur = detailCacheRef.current.get(p.articleNumber);
        return !cur || cur === 'error';
      });

      if (missing.length > 0) {
        exportCancelRef.current = false;
        setExportFetchProgress({ current: 0, total: missing.length });
        for (let i = 0; i < missing.length; i++) {
          if (exportCancelRef.current) break;
          const p = missing[i];
          try {
            const result = await getArticleDetail(p.articleNumber, p.complexNumber > 0 ? p.complexNumber : undefined);
            detailCacheRef.current.set(p.articleNumber, result ?? 'error');
          } catch {
            detailCacheRef.current.set(p.articleNumber, 'error');
          }
          setExportFetchProgress({ current: i + 1, total: missing.length });
          if (i < missing.length - 1 && !exportCancelRef.current) await randomDelay(150, 400);
        }
        setDetailCache(new Map(detailCacheRef.current));
        setExportFetchProgress(null);
      }
    }

    const detailArg = includeDetail ? detailCacheRef.current : undefined;
    if (format === 'excel') {
      await exportExcel(rows, priceUnit, areaUnit, realEstateType, filenameBase, detailArg);
    } else if (format === 'json') {
      exportJSON(rows, filenameBase, detailArg);
    } else {
      exportMarkdown(rows, priceUnit, areaUnit, realEstateType, filenameBase, detailArg);
    }
  }, [allFiltered, filteredReps, priceUnit, areaUnit, realEstateType, meta]);

  // ── 평균 통계 (필터+중복숨김 상태 반영) ──
  const tableStats = useMemo<TableStats>(() => {
    const rows = isDupHidden ? filteredReps : allFiltered;
    const a1Rows = rows.filter((p) => p.tradeType === 'A1');
    if (a1Rows.length === 0) return { avgDealPrice: 0, avgPyeongPrice: 0, avgPresaleTotal: 0, count: 0 };

    const avgDealPrice = Math.round(a1Rows.reduce((s, p) => s + p.dealPrice, 0) / a1Rows.length);

    const withArea = a1Rows.filter((p) => {
      const area = isExclusiveSpaceType(realEstateType) ? p.exclusiveSpace : p.supplySpace;
      return area > 0;
    });
    const avgPyeongPrice = withArea.length > 0
      ? Math.round(withArea.reduce((s, p) => s + pyeongUnitPriceWon(p, realEstateType), 0) / withArea.length)
      : 0;

    let avgPresaleTotal = 0;
    if (isPresale) {
      const totals = a1Rows.map((p) => {
        const d = detailCache.get(p.articleNumber);
        const ei = (d && d !== 'loading' && d !== 'error') ? d.isalePrice   : p.isalePrice;
        const ep = (d && d !== 'loading' && d !== 'error') ? d.premiumPrice : p.premiumPrice;
        const eo = (d && d !== 'loading' && d !== 'error') ? d.optionPrice  : p.optionPrice;
        return ei + ep + eo;
      });
      avgPresaleTotal = Math.round(totals.reduce((s, v) => s + v, 0) / totals.length);
    }

    return { avgDealPrice, avgPyeongPrice, avgPresaleTotal, count: a1Rows.length };
  }, [filteredReps, allFiltered, isDupHidden, realEstateType, isPresale, detailCache]);

  useEffect(() => {
    onStatsChange?.(tableStats);
  }, [tableStats, onStatsChange]);

  // 분양권 가격 fallback prefetch.
  // 신규 수집은 크롤러가 완료 전에 가격을 properties에 채우므로 보통 여기서 할 일이 없다.
  // 단, 가격이 비어있는 매물(예: 가격 보강 이전에 저장된 슬롯 데이터)만 상세 API로 보강한다.
  // 캐시는 searchKey 변경 시에만 초기화 → 정렬·필터·페이지·브라우저 탭 전환에 재요청 없음.
  useEffect(() => {
    if (!isPresale) return;
    if (status !== 'done' && status !== 'stopped') return;
    if (properties.length === 0) return;

    const pageKeys = new Set(paginated.map((p) => p.articleNumber));
    const ordered = [
      ...properties.filter((p) => pageKeys.has(p.articleNumber)),
      ...properties.filter((p) => !pageKeys.has(p.articleNumber)),
    ];
    // 이미 가격이 있는 매물은 제외 (크롤러가 채운 경우)
    const pending = ordered.filter(
      (p) => p.isalePrice <= 0 && p.premiumPrice === 0 && p.optionPrice === 0,
    );
    if (pending.length === 0) return;

    let cancelled = false;
    (async () => {
      for (const p of pending) {
        if (cancelled) return;
        const cur = detailCacheRef.current.get(p.articleNumber);
        if (cur && cur !== 'error') continue; // 이미 성공 캐시됨 → 스킵
        ensureDetail(p);
        await new Promise((r) => setTimeout(r, 160)); // 차단 회피용 간격
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresale, status, searchKey, properties.length]);

  const hasActiveFilter = !!(complexFilter || tradeTypeFilter || filterText || spaceMin > 0 || spaceMax > 0 || priceMin > 0 || priceMax > 0);

  // 면적/가격 슬라이더의 상한 — 수집 데이터 기준 (표시 단위/상세캐시 반영).
  const { areaSliderMax, priceSliderMax } = useMemo(() => {
    let aMaxSqm = 0;
    let pMaxWon = 0;
    for (const p of properties) {
      const a = Math.max(p.supplySpace, p.exclusiveSpace);
      if (a > aMaxSqm) aMaxSqm = a;
      const price = isPresale
        ? effPresaleTotalWon(p, detailCache)
        : p.tradeType === 'B1' ? p.warrantyPrice
          : p.tradeType === 'B2' ? p.rentPrice
            : p.dealPrice;
      if (price > pMaxWon) pMaxWon = price;
    }
    const aDisplay = areaUnit === 'pyeong' ? aMaxSqm * SQM_TO_PYEONG : aMaxSqm;
    return {
      areaSliderMax: Math.max(10, Math.ceil(aDisplay)),
      priceSliderMax: Math.max(1000, Math.ceil(pMaxWon / 10_000)), // 만원 단위
    };
  }, [properties, areaUnit, isPresale, detailCache]);
  const priceStep = priceSliderMax > 100_000 ? 1000 : priceSliderMax > 10_000 ? 100 : 10;

  // 현재 페이지에서 각 단지의 첫 번째 매물 → 단지 정보 버튼 표시 대상
  const firstComplexInPage = useMemo(() => {
    const seen = new Set<number | string>();
    const result = new Set<string>(); // articleNumber 기준
    for (const p of paginated) {
      const key = p.complexNumber > 0 ? p.complexNumber : p.complexName;
      if (!seen.has(key)) { seen.add(key); result.add(p.articleNumber); }
    }
    return result;
  }, [paginated]);
  const areaCols = useMemo(() => buildAreaCols(areaUnit, useContract), [areaUnit, useContract]);

  // ── Active column keys for colgroup ──
  const activeColKeys = useMemo(() => {
    const keys = ['midName', 'smallName', 'tradeType', 'complexName', 'dongName', 'floorInfo', 'direction', 'supplySpaceName'];
    areaCols.forEach((c) => keys.push(c.key));
    if (!isPresale && dataInfo.hasA1) keys.push('dealPrice', 'pyeongPrice');
    if (isPresale) keys.push('isalePrice', 'isalePyeong', 'premiumPrice', 'optionPrice', 'totalBuyPrice', 'realPyeongPrice');
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
  const isDetailLoading = (p: Property) => detailCache.get(p.articleNumber) === 'loading';
  const getEffIsale = (p: Property) => {
    const d = detailCache.get(p.articleNumber);
    return (d && d !== 'loading' && d !== 'error') ? d.isalePrice : p.isalePrice;
  };
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

          <RangeSlider
            label="면적"
            min={0} max={areaSliderMax} step={1}
            lo={spaceMin} hi={spaceMax}
            unit={areaUnit === 'pyeong' ? '평' : '㎡'}
            onChange={(lo, hi) => {
              setSpaceMin(lo <= 0 ? 0 : lo);
              setSpaceMax(hi >= areaSliderMax ? 0 : hi);
              setPage(0);
            }}
          />

          <RangeSlider
            label="가격"
            min={0} max={priceSliderMax} step={priceStep}
            lo={priceMin} hi={priceMax}
            unit="만원"
            onChange={(lo, hi) => {
              setPriceMin(lo <= 0 ? 0 : lo);
              setPriceMax(hi >= priceSliderMax ? 0 : hi);
              setPage(0);
            }}
          />

          <input className="search-input" type="text" placeholder="단지명/특징 검색..."
            value={filterText} onChange={(e) => { setFilterText(e.target.value); setPage(0); }} />

          <button className="btn-outline btn-sm"
            onClick={() => openExportConfirm('excel')}
            disabled={allFiltered.length === 0}>
            Excel 내보내기
          </button>
          <button className="btn-outline btn-sm"
            onClick={() => openExportConfirm('json')}
            disabled={allFiltered.length === 0}>
            JSON 내보내기
          </button>
          <button className="btn-outline btn-sm"
            onClick={() => openExportConfirm('md')}
            disabled={allFiltered.length === 0}>
            MD 내보내기
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="table-wrapper" ref={tableWrapperRef}>
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
              {!isPresale && dataInfo.hasA1 && (
                <Th colKey="dealPrice"  label="매매가"  sortK="dealPrice"  {...thProps} />
              )}
              {!isPresale && dataInfo.hasA1 && (
                <Th colKey="pyeongPrice" label="평당가" sortK="pyeongPrice" {...thProps} />
              )}
              {isPresale && (
                <Th colKey="isalePrice"      label="분양가"       sortK="isalePrice"      {...thProps} />
              )}
              {isPresale && (
                <Th colKey="isalePyeong"     label="평당가(분양)" sortK="isalePyeong"     {...thProps} />
              )}
              {isPresale && (
                <Th colKey="premiumPrice"    label="P"            sortK="premiumPrice"    {...thProps} />
              )}
              {isPresale && (
                <Th colKey="optionPrice"     label="옵션비용"     sortK="optionPrice"     {...thProps} />
              )}
              {isPresale && (
                <Th colKey="totalBuyPrice"   label="매매가"       sortK="totalBuyPrice"   {...thProps} />
              )}
              {isPresale && (
                <Th colKey="realPyeongPrice" label="평당가(분양권)" sortK="realPyeongPrice" {...thProps} />
              )}
              {dataInfo.hasB && (
                <Th colKey="warrantyPrice" label="보증금" sortK="dealPrice" {...thProps} />
              )}
              {dataInfo.hasB2 && (
                <Th colKey="rentPrice" label="월세" curSortKey={sortKey} curSortDir={sortDir} onSort={handleSort} onResizeStart={handleResizeStart} />
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
                const rowKey = p._uid
                  ? String(p._uid)
                  : [
                      p.isDuplicate ? 'dup' : 'rep',
                      p.groupId ?? '',
                      p.articleNumber ?? '',
                      p.brokerageName ?? '',
                      p.articleFeature ?? '',
                      p.dongName ?? '',
                      p.floorInfo ?? '',
                      idx,
                    ].join('|');
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
                  !isDupHidden || expandedGroups.has(p.groupId!)
                );
                // 대표 행을 선택하면 중복 하위 행도 같이 강조
                const isInSelectedGroup = !!(isDup && p.groupId && selectedGroupId === p.groupId);
                const isHighlighted = selectedRow === rowKey || isInSelectedGroup;

                const loading     = isDetailLoading(p);
                const effIsale   = getEffIsale(p);
                const effPremium = getEffPremium(p);
                const effOption  = getEffOption(p);
                const totalBuy   = effIsale + effPremium + effOption;
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
                        {firstComplexInPage.has(p.articleNumber) && p.complexNumber > 0 && (
                          <button
                            className="detail-plus-btn complex-info-btn"
                            title="단지 정보"
                            onClick={(e) => { e.stopPropagation(); openComplexModal(p); }}
                          >+</button>
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

                    {!isPresale && dataInfo.hasA1 && (
                      <td className={`td-price${p.tradeType === 'A1' ? ' price-accent' : ''}`}>
                        <div className="td-price-inner">
                          {p.tradeType === 'A1' ? (
                            <>
                              <span className="price-value">{formatPriceByUnit(p.dealPrice, priceUnit)}</span>
                              <PriceCell p={p} showPriceUp={true} />
                              <button
                                className="detail-plus-btn"
                                title="매입비용 계산"
                                onClick={(e) => { e.stopPropagation(); openAcquisitionModal(p, p.dealPrice); }}
                              >+</button>
                            </>
                          ) : <span className="td-empty">-</span>}
                        </div>
                      </td>
                    )}

                    {!isPresale && dataInfo.hasA1 && (
                      <td className={`td-pyeong${p.tradeType === 'A1' ? ' price-accent' : ''}`}>
                        {p.tradeType === 'A1'
                          ? formatPriceByUnit(pyeongUnitPriceWon(p, realEstateType), priceUnit)
                          : '-'}
                      </td>
                    )}

                    {isPresale && (
                      <td className="td-price presale-col">
                        {loading ? <span className="td-loading">…</span>
                          : effIsale > 0 ? formatPriceByUnit(effIsale, priceUnit) : '-'}
                      </td>
                    )}
                    {isPresale && (
                      <td className="td-pyeong presale-col">
                        {loading ? <span className="td-loading">…</span>
                          : effIsale > 0 && realPyeong > 0
                            ? formatPriceByUnit(effIsale / realPyeong, priceUnit) : '-'}
                      </td>
                    )}
                    {isPresale && (
                      <td className={`td-price presale-col${effPremium < 0 ? ' premium-negative' : ''}`}>
                        {loading ? <span className="td-loading">…</span>
                          : formatPremiumByUnit(effPremium, priceUnit)}
                      </td>
                    )}
                    {isPresale && (
                      <td className="td-price presale-col">
                        {loading ? <span className="td-loading">…</span>
                          : effOption > 0 ? formatPriceByUnit(effOption, priceUnit) : '-'}
                      </td>
                    )}
                    {isPresale && (
                      <td className="td-price presale-col presale-total">
                        <div className="td-price-inner">
                          {loading ? <span className="td-loading">…</span>
                            : totalBuy > 0 ? (
                              <>
                                <span className="price-value presale-main-price">{formatPriceByUnit(totalBuy, priceUnit)}</span>
                                <button
                                  className="detail-plus-btn"
                                  title="매입비용 계산"
                                  onClick={(e) => { e.stopPropagation(); openAcquisitionModal(p, totalBuy); }}
                                >+</button>
                              </>
                            ) : <span className="td-empty">-</span>}
                        </div>
                      </td>
                    )}
                    {isPresale && (
                      <td className="td-pyeong presale-col">
                        {loading ? <span className="td-loading">…</span>
                          : realPyeongPrice > 0
                            ? <span className="presale-main-price">{formatPriceByUnit(realPyeongPrice, priceUnit)}</span>
                            : '-'}
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

      {/* Detail / Realtor / ComplexInfo / AcquisitionCost modal */}
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
            {modalState.kind === 'complex-info' && (
              <ComplexInfoModal
                detail={modalState.complexNo ? complexInfoCache.get(modalState.complexNo) : undefined}
              />
            )}
            {modalState.kind === 'acquisition-cost' && (
              <AcquisitionCostModal
                detail={acquisitionCostCache.get(modalState.articleNo)}
                buyPrice={modalState.buyPrice ?? 0}
              />
            )}
          </div>
        </div>
      )}

      {/* 내보내기 옵션 확인 모달 — 중복 매물 포함 여부 + 상세정보 포함 여부 */}
      {exportConfirm && (
        <div className="modal-overlay" onClick={() => setExportConfirm(null)}>
          <div className="modal-card detail-modal-card" onClick={(e) => e.stopPropagation()}>
            <button className="cm-close" onClick={() => setExportConfirm(null)}>✕</button>
            <div className="detail-modal-content">
              <h3 className="detail-modal-title">{EXPORT_FORMAT_LABEL[exportConfirm]} 내보내기 옵션</h3>

              <div className="export-option-group">
                <span className="export-option-label">중복 매물</span>
                <div className="export-option-cards">
                  <button type="button"
                    className={`export-option-card${exportIncludeDup ? ' active' : ''}`}
                    onClick={() => setExportIncludeDup(true)}>
                    <span className="eoc-title">중복 매물 포함</span>
                    <span className="eoc-sub">전체 {allFiltered.length.toLocaleString()}건</span>
                  </button>
                  <button type="button"
                    className={`export-option-card${!exportIncludeDup ? ' active' : ''}`}
                    onClick={() => setExportIncludeDup(false)}>
                    <span className="eoc-title">대표 매물만</span>
                    <span className="eoc-sub">{filteredReps.length.toLocaleString()}건</span>
                  </button>
                </div>
              </div>

              <div className="export-option-group">
                <span className="export-option-label">상세정보</span>
                <div className="export-option-cards">
                  <button type="button"
                    className={`export-option-card${!exportIncludeDetail ? ' active' : ''}`}
                    onClick={() => setExportIncludeDetail(false)}>
                    <span className="eoc-title">현재 데이터만</span>
                    <span className="eoc-sub">즉시 내보내기</span>
                  </button>
                  <button type="button"
                    className={`export-option-card${exportIncludeDetail ? ' active' : ''}`}
                    onClick={() => setExportIncludeDetail(true)}>
                    <span className="eoc-title">상세정보 포함</span>
                    <span className="eoc-sub">상세특징·중개업소 정보 추가 조회</span>
                  </button>
                </div>
              </div>

              <button className="eos-run-btn export-confirm-go" onClick={() => {
                const format = exportConfirm;
                setExportConfirm(null);
                void performExport(format, exportIncludeDetail, exportIncludeDup);
              }}>
                내보내기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 내보내기 상세정보 보강 수집 진행 모달 — 100% 완료 시 자동으로 닫히고 다운로드가 시작됨 */}
      {exportFetchProgress && (
        <div className="modal-overlay">
          <div className="modal-card export-progress-modal">
            <div className="cm-live">
              <div className="cm-live-spin" />
              <div className="export-progress-title">데이터 포장 중…</div>
              <div className="cp-bar export-progress-bar">
                <i style={{ width: `${Math.round((exportFetchProgress.current / exportFetchProgress.total) * 100)}%` }} />
              </div>
              <div className="cm-live-frac">
                {Math.round((exportFetchProgress.current / exportFetchProgress.total) * 100)}%
                {' · '}{exportFetchProgress.current.toLocaleString()} / {exportFetchProgress.total.toLocaleString()}건
              </div>
              <button className="eos-run-btn stop cm-stop-btn" onClick={() => { exportCancelRef.current = true; }}>
                <svg viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
                내보내기 중지
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
