import { useState, useEffect, useRef, useMemo } from 'react';
import AnalysisModal from './AnalysisModal';
import { SpaceRangeSlider } from './SpaceRangeSlider';
import { AreaOption, LogEntry, RegionCode, CrawlerStatus, TransactionProperty } from './types';
import { fetchRegionList, peekRegionList, prefetchRegionList } from './services/api';
import { TransactionService } from './services/transactionService';
import { Play, Loader2, Download, BarChart2, Building2, RotateCw, Layers, Activity, AlertTriangle } from 'lucide-react';
import './realdeal.css';

// Default for Transaction (Exclusive Area)
const INITIAL_TRANS_APT_OPTIONS: AreaOption[] = [
  { id: 1, name: '59미만', min: 0, max: 57 },
  { id: 2, name: '59', min: 57, max: 60 },
  { id: 3, name: '65', min: 60, max: 70 },
  { id: 4, name: '74', min: 70, max: 80 },
  { id: 5, name: '84', min: 80, max: 85 },
  { id: 6, name: '85초과', min: 85, max: 500 }
];

// Default for Officetel (Exclusive Area)
const INITIAL_TRANS_OPST_OPTIONS: AreaOption[] = [
  { id: 1, name: '6평 미만', min: 0, max: 19.83 },
  { id: 2, name: '6~9평', min: 19.83, max: 29.75 },
  { id: 3, name: '9~12평', min: 29.75, max: 39.67 },
  { id: 4, name: '12~15평', min: 39.67, max: 49.59 },
  { id: 5, name: '15~18평', min: 49.59, max: 59.5 },
  { id: 6, name: '18평 이상', min: 59.5, max: 9999 }
];

// Generate Year/Month options for Transaction Period
const generateYearMonthOptions = () => {
  const options: { value: string; label: string }[] = [];
  const now = new Date();
  const currentYear = now.getFullYear();
  const startYear = currentYear - 10;

  for (let y = currentYear; y >= startYear; y--) {
    for (let m = 12; m >= 1; m--) {
      const val = `${y}${m.toString().padStart(2, '0')}`;
      const label = `${y}년 ${m}월`;
      options.push({ value: val, label });
    }
  }
  return options;
};

interface SortConfig {
  key: string;
  direction: 'asc' | 'desc';
}

const PRODUCT_LABELS: Record<string, string> = {
  APT: '아파트', OFFICETEL: '오피스텔', BUNYANGWON: '분양권', COMMERCIAL: '상업/업무',
};
const TYPE_LABELS: Record<string, string> = { TRADE: '매매', JEONSE: '전세', WOLSE: '월세' };

// 실거래 다운로드 모듈 — 통합 셸(naver-kb)의 '실거래가' 탭에서 렌더된다.
// 원본 R4_Real 앱의 App.tsx에서 좌측 사이드바(Sidebar)와 eos-app 래퍼·설정 모달·폰트
// 옵션을 제거하고, 콘텐츠(헤더 + 작업영역 + 분석/장애 모달)만 호스트의 eos-main 안에
// 마운트한다. 모든 스타일은 .rd-scope 로 한정(realdeal.css)되어 타 탭 화면에 영향이 없다.
// 공공데이터포털 serviceKey는 클라이언트가 알지 못하며 /molit-api 프록시가 서버측에서 주입한다.
export function RealDealTab() {
  const [isAnalysisOpen, setIsAnalysisOpen] = useState(false);
  const [ctrlCollapsed, setCtrlCollapsed] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null); // data.go.kr 일시 장애 안내 모달

  // -- Area Options (기본 프리셋; 편집 UI는 v1 미이식) --
  const transAptOptions = INITIAL_TRANS_APT_OPTIONS;
  const transOpstOptions = INITIAL_TRANS_OPST_OPTIONS;

  // Region State
  const [sido, setSido] = useState('');
  const [sigungu, setSigungu] = useState('');
  const [dong, setDong] = useState('');
  const [sidoList, setSidoList] = useState<RegionCode[]>([]);
  const [sigunguList, setSigunguList] = useState<RegionCode[]>([]);
  const [dongList, setDongList] = useState<RegionCode[]>([]);
  const [, setIsLoadingRegion] = useState(false);

  // Transaction State
  const transDateOptions = useMemo(() => generateYearMonthOptions(), []);
  const [transProduct, setTransProduct] = useState<'APT' | 'OFFICETEL' | 'BUNYANGWON' | 'COMMERCIAL'>('APT');
  const [transType, setTransType] = useState<'TRADE' | 'JEONSE' | 'WOLSE'>('TRADE');
  const [transSelectedArea, setTransSelectedArea] = useState<string>('');
  // 면적 지정 2-모드: 'preset'(타입 프리셋 선택) / 'range'(직접설정 레인지)
  const [transAreaMode, setTransAreaMode] = useState<'preset' | 'range'>('preset');
  const [transAreaMinPy, setTransAreaMinPy] = useState(0); // 평
  const [transAreaMaxPy, setTransAreaMaxPy] = useState(0); // 평
  const [transSpaceUnit, setTransSpaceUnit] = useState<'pyeong' | 'sqm'>('sqm');
  // 전용률(%) — 아파트 직접설정 시 전용면적을 공급면적으로 역산 표기에 사용 (단지별로 다름)
  const [transExclusiveRatio, setTransExclusiveRatio] = useState(() => Number(localStorage.getItem('transExclusiveRatio')) || 74);
  const [transPeriodType, setTransPeriodType] = useState<'RECENT' | 'RANGE'>('RECENT');
  const [transRecent, setTransRecent] = useState<'3M' | '6M' | '1Y' | '2Y' | '3Y' | '5Y'>('3M');
  const [transStartRange, setTransStartRange] = useState(transDateOptions[0]?.value);
  const [transEndRange, setTransEndRange] = useState(transDateOptions[0]?.value);
  const [transProperties, setTransProperties] = useState<TransactionProperty[]>([]);

  // Common State
  const [, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<CrawlerStatus>({ step: '대기 중', progress: 0, clustersFound: 0, propertiesFound: 0, isRunning: false });

  // Sorting State (Multi-level)
  const [sortConfig, setSortConfig] = useState<SortConfig[]>([]);

  const transCrawlerRef = useRef<TransactionService | null>(null);

  // 시/도 로드 (+ 모든 시/군/구 백그라운드 선로딩으로 다음 선택을 즉시 반영)
  useEffect(() => {
    const cached = peekRegionList('sido');
    if (cached) {
      setSidoList(cached);
      cached.forEach(r => prefetchRegionList('sigungu', r.region_cd));
      return;
    }
    const loadSido = async () => {
      try {
        const data = await fetchRegionList('sido');
        setSidoList(data);
        data.forEach(r => prefetchRegionList('sigungu', r.region_cd));
      }
      catch (e: any) { log(`초기 지역 목록 로딩 실패: ${e.message}`, 'error'); }
    };
    loadSido();
  }, []);

  const log = (message: string, type: 'info' | 'error' = 'info') => {
    const time = new Date().toTimeString().split(' ')[0];
    setLogs(prev => [...prev, { timestamp: time, message, type }]);
  };

  // Region Handlers
  const handleSidoChange = async (code: string) => {
    setSido(code); setSigungu(''); setDong(''); setSigunguList([]); setDongList([]);
    if (!code) return;

    const cached = peekRegionList('sigungu', code);
    if (cached) {
      setSigunguList(cached);
      cached.forEach(r => prefetchRegionList('dong', r.region_cd));
      return;
    }
    setIsLoadingRegion(true);
    try {
      const rows = await fetchRegionList('sigungu', code);
      setSigunguList(rows);
      rows.forEach(r => prefetchRegionList('dong', r.region_cd));
    }
    catch (e: any) { log(`지역 데이터 로딩 실패: ${e.message}`, 'error'); }
    finally { setIsLoadingRegion(false); }
  };

  const handleSigunguChange = async (code: string) => {
    setSigungu(code); setDong(''); setDongList([]);
    if (!code) return;

    const cached = peekRegionList('dong', code);
    if (cached) {
      setDongList(cached);
      return;
    }
    setIsLoadingRegion(true);
    try { const rows = await fetchRegionList('dong', code); setDongList(rows); }
    catch (e: any) { log(`읍/면/동 로딩 실패: ${e.message}`, 'error'); }
    finally { setIsLoadingRegion(false); }
  };

  const handleDongChange = (code: string) => {
    setDong(code);
  };

  const startTransactionCrawling = async () => {
    if (!sigungu) { log('시/군/구를 선택해주세요.', 'error'); return; }
    setTransProperties([]); setLogs([]);
    setSortConfig([{ key: 'date', direction: 'desc' }]);

    const months: string[] = [];
    if (transPeriodType === 'RECENT') {
      const now = new Date();
      let subMonths = 3;
      if (transRecent === '6M') subMonths = 6;
      else if (transRecent === '1Y') subMonths = 12;
      else if (transRecent === '2Y') subMonths = 24;
      else if (transRecent === '3Y') subMonths = 36;
      else if (transRecent === '5Y') subMonths = 60;

      for (let i = 0; i < subMonths; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
      }
    } else {
      let start = transStartRange;
      let end = transEndRange;
      if (start > end) [start, end] = [end, start];

      let currY = parseInt(start.substring(0, 4));
      let currM = parseInt(start.substring(4, 6));
      const endY = parseInt(end.substring(0, 4));
      const endM = parseInt(end.substring(4, 6));

      while (currY < endY || (currY === endY && currM <= endM)) {
        months.push(`${currY}${String(currM).padStart(2, '0')}`);
        currM++;
        if (currM > 12) { currM = 1; currY++; }
      }
    }

    let areaMin: number | undefined;
    let areaMax: number | undefined;
    if (transAreaMode === 'range') {
      // 직접설정(레인지): 평 → ㎡ 변환 (전용면적 필터는 ㎡ 기준)
      const PY_TO_SQM = 3.30579;
      if (transAreaMinPy > 0) areaMin = transAreaMinPy * PY_TO_SQM;
      if (transAreaMaxPy > 0) areaMax = transAreaMaxPy * PY_TO_SQM;
    } else if (transSelectedArea) {
      // 타입(프리셋): 기존 면적 옵션 선택
      const options = transProduct === 'OFFICETEL' ? transOpstOptions : transAptOptions;
      const selected = options.find(o => o.name === transSelectedArea);
      if (selected) {
        areaMin = selected.min;
        areaMax = selected.max;
      }
    }

    const lawdCd = sigungu.substring(0, 5);
    const sigunguName = sigunguList.find(r => r.region_cd === sigungu)?.locatadd_nm || '';
    const dongName = dongList.find(d => d.region_cd === dong)?.locatadd_nm || 'All';

    transCrawlerRef.current = new TransactionService(log, (s) => setStatus(p => ({ ...p, ...s })));
    try {
      const results = await transCrawlerRef.current.run({
        product: transProduct,
        type: transType,
        areaMin,
        areaMax,
        months,
        regionCode: lawdCd,
        regionName: sigunguName,
        dongName: dongName === 'All' ? undefined : dongName,
      });
      setTransProperties(results);
    } catch (e: any) {
      if (e.message === 'AUTH_ERROR') {
        setServerError('공공데이터포털 인증키(MOLIT_API_KEY)가 서버에 설정되지 않았거나 유효하지 않습니다 (HTTP 401). data.go.kr 실거래가 API 키를 서버 환경변수(MOLIT_API_KEY)에 등록했는지 확인해 주세요. — 데이터포털 서버 장애가 아니라 키 설정 문제입니다.');
      } else if (e.message === 'SERVER_UNAVAILABLE') {
        setServerError('국토교통부 실거래가 서버(data.go.kr)가 일시적으로 응답하지 않습니다 (502 Bad Gateway). 자동 재시도에도 실패했습니다. 데이터포털 서버 측 일시 장애이니 잠시 후 다시 시도해 주세요.');
      } else {
        log(`실거래 데이터 오류: ${e.message}`, 'error');
      }
    }
  };

  const handleProductChange = (val: typeof transProduct) => {
    setTransProduct(val);
    setTransSelectedArea('');
    if (val === 'BUNYANGWON' || val === 'COMMERCIAL') {
      setTransType('TRADE');
    }
  };

  const handleSort = (key: string) => {
    setSortConfig(prev => {
      const existing = prev.find(s => s.key === key);
      let direction: 'asc' | 'desc' = 'asc';
      if (existing) {
        if (prev[0]?.key === key) {
          direction = existing.direction === 'asc' ? 'desc' : 'asc';
        } else {
          direction = 'asc';
        }
      }
      const next = prev.filter(s => s.key !== key);
      return [{ key, direction }, ...next];
    });
  };

  const currentData = transProperties;

  const processedData = useMemo(() => {
    let result = [...currentData] as any[];
    if (sortConfig.length > 0) {
      result.sort((a, b) => {
        for (const { key, direction } of sortConfig) {
          let aClean = typeof a[key] === 'string' ? a[key].replace(/,/g, '') : a[key];
          let bClean = typeof b[key] === 'string' ? b[key].replace(/,/g, '') : b[key];
          const aNum = parseFloat(aClean);
          const bNum = parseFloat(bClean);
          if (!isNaN(aNum) && !isNaN(bNum) &&
            key !== 'region' && key !== 'name' && key !== 'dong' &&
            key !== 'date' && key !== 'cancelDate') {
            aClean = aNum;
            bClean = bNum;
          }
          if (aClean < bClean) return direction === 'asc' ? -1 : 1;
          if (aClean > bClean) return direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
    return result;
  }, [currentData, sortConfig]);

  const sortIcon = (key: string) => {
    const primary = sortConfig[0];
    if (primary?.key !== key) return <span className="sort-icon">↕</span>;
    return <span className="sort-icon active">{primary.direction === 'asc' ? '↑' : '↓'}</span>;
  };

  const exportData = (format: 'csv' | 'json') => {
    if (currentData.length === 0) return;
    const filename = `data_transaction_${new Date().toISOString().slice(0, 10)}.${format}`;
    let content = '';

    if (format === 'json') {
      content = JSON.stringify(currentData, null, 2);
    } else {
      let headers: string[] = [];
      let rows: string[] = [];
      if (transType === 'TRADE') {
        headers = ['No', '거래지역', '법정동', '단지명', '전용M2', '실거래층', '실거래가', '실거래일', '거래유형', '해제유무'];
        rows = (currentData as TransactionProperty[]).map((p, index) => [
          index + 1, `"${p.region}"`, `"${p.dong}"`, `"${p.name}"`, p.area, p.floor, `"${p.price}"`, p.date, `"${p.type}"`, `"${p.cancelDate}"`
        ].join(','));
      } else {
        headers = ['No', '지역코드', '법정동', '단지명', '전용면적', '층', '보증금', '월세', '거래일', '계약구분'];
        rows = (currentData as TransactionProperty[]).map((p, index) => [
          index + 1, `"${p.region}"`, `"${p.dong}"`, `"${p.name}"`, p.area, p.floor, `"${p.price}"`, `"${p.monthlyRent}"`, p.date, `"${p.type}"`
        ].join(','));
      }
      content = '﻿' + [headers.join(','), ...rows].join('\n');
    }
    const blob = new Blob([content], { type: `${format === 'json' ? 'application/json' : 'text/csv'};charset=utf-8;` });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const TRANS_COLUMNS = transType === 'TRADE' ? [
    { key: 'no', label: 'No.' },
    { key: 'region', label: '거래지역' },
    { key: 'dong', label: '법정동' },
    { key: 'name', label: '단지명' },
    { key: 'area', label: '전용M2' },
    { key: 'floor', label: '실거래층' },
    { key: 'price', label: '실거래가' },
    { key: 'date', label: '실거래일' },
    { key: 'type', label: '거래유형' },
    { key: 'cancelDate', label: '해제유무' },
  ] : [
    { key: 'no', label: 'No.' },
    { key: 'region', label: '지역코드' },
    { key: 'dong', label: '법정동' },
    { key: 'name', label: '단지명' },
    { key: 'area', label: '전용면적' },
    { key: 'floor', label: '층' },
    { key: 'price', label: '보증금' },
    { key: 'monthlyRent', label: '월세' },
    { key: 'date', label: '거래일' },
    { key: 'type', label: '계약구분' },
  ];

  // Status helpers
  const badge = status.isRunning
    ? { label: '수집 중', cls: 'badge-running' }
    : status.step === '오류 발생'
      ? { label: '오류', cls: 'badge-error' }
      : transProperties.length > 0
        ? { label: '완료', cls: 'badge-done' }
        : { label: '대기', cls: 'badge-idle' };

  const statusText = status.isRunning
    ? '데이터 수집 중'
    : transProperties.length > 0
      ? `${transProperties.length.toLocaleString()}건 수집됨`
      : status.step === '오류 발생'
        ? '오류 발생'
        : '국토교통부 실거래가 · 대기 중';

  const hasData = processedData.length > 0;

  return (
    <div className="rd-scope">
      <div className="rd-main">
        <header className="rd-hdr">
          <div className="rd-crumb">
            <svg className="home" viewBox="0 0 24 24"><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></svg>
            <svg className="sep" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
            <span>분석 모듈</span>
            <svg className="sep" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
            <b>실거래 다운로드</b>
            <span className="tag">LIVE</span>
          </div>
          <div className="rd-hdr-right">
            <div className={`rd-ws ${status.isRunning ? 'run' : 'off'}`}>
              <span className="wd" />
              <span>{statusText}</span>
            </div>
          </div>
        </header>

        <div className={`rd-work${ctrlCollapsed ? ' ctrl-collapsed' : ''}`}>
          {/* ── Control panel (search conditions) ── */}
          <aside className="rd-ctrl">
            <div className="rd-ctrl-head">
              <div className="ch-ic">
                <svg viewBox="0 0 24 24"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
              </div>
              <b>검색 조건</b>
              <button className="rd-ctrl-toggle" title="패널 접기" onClick={() => setCtrlCollapsed(v => !v)}>
                <svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
            </div>

            <div className="rd-ctrl-body">
              {/* 지역 */}
              <div className="region-select">
                <label className="form-label">지역 선택</label>
                <div className="region-select-row">
                  <div className="select-wrapper">
                    <select className="form-select" value={sido} onChange={e => handleSidoChange(e.target.value)}>
                      <option value="">시/도 선택</option>
                      {sidoList.map(r => <option key={r.region_cd} value={r.region_cd}>{r.locatadd_nm}</option>)}
                    </select>
                  </div>
                  <div className="select-wrapper">
                    <select className="form-select" value={sigungu} onChange={e => handleSigunguChange(e.target.value)} disabled={!sigunguList.length}>
                      <option value="">시/군/구 선택</option>
                      {sigunguList.map(r => <option key={r.region_cd} value={r.region_cd}>{r.locatadd_nm}</option>)}
                    </select>
                  </div>
                  <div className="select-wrapper">
                    <select className="form-select" value={dong} onChange={e => handleDongChange(e.target.value)} disabled={!dongList.length}>
                      <option value="">읍/면/동 (선택)</option>
                      {dongList.map(r => <option key={r.region_cd} value={r.region_cd}>{r.locatadd_nm}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {/* 대상 (상품 / 거래방식) */}
              <div className="form-group">
                <label className="form-label">대상</label>
                <div className="region-select-row">
                  <div className="select-wrapper">
                    <select className="form-select" value={transProduct} onChange={e => handleProductChange(e.target.value as any)}>
                      <option value="APT">아파트</option>
                      <option value="OFFICETEL">오피스텔</option>
                      <option value="BUNYANGWON">분양권</option>
                      <option value="COMMERCIAL">상업/업무</option>
                    </select>
                  </div>
                  <div className="select-wrapper">
                    <select className="form-select" value={transType} onChange={e => setTransType(e.target.value as any)} disabled={transProduct === 'BUNYANGWON' || transProduct === 'COMMERCIAL'}>
                      <option value="TRADE">매매</option>
                      <option value="JEONSE">전세</option>
                      <option value="WOLSE">월세</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* 면적 — 2가지 방식: 타입(프리셋 선택) / 직접설정(레인지) */}
              {(() => {
                const areaDisabled = transProduct === 'BUNYANGWON' || transProduct === 'COMMERCIAL';
                const areaOptions = transProduct === 'OFFICETEL' ? transOpstOptions : transAptOptions;
                return (
                  <div className="form-group">
                    <div className="space-label-row">
                      <label className="form-label" style={{ marginBottom: 0 }}>면적 (전용면적 기준)</label>
                      <div className="space-unit-toggle">
                        <button
                          type="button"
                          className={`space-unit-btn ${transAreaMode === 'preset' ? 'active' : ''}`}
                          onClick={() => setTransAreaMode('preset')}
                          disabled={areaDisabled}
                        >타입</button>
                        <button
                          type="button"
                          className={`space-unit-btn ${transAreaMode === 'range' ? 'active' : ''}`}
                          onClick={() => setTransAreaMode('range')}
                          disabled={areaDisabled}
                        >직접설정</button>
                      </div>
                    </div>

                    {transAreaMode === 'preset' ? (
                      <div className="select-wrapper">
                        <select
                          className="form-select"
                          value={transSelectedArea}
                          onChange={e => setTransSelectedArea(e.target.value)}
                          disabled={areaDisabled}
                        >
                          <option value="">전체 면적</option>
                          {areaOptions.map(o => (
                            <option key={o.id} value={o.name}>{o.name}</option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <>
                        {transProduct === 'APT' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>전용률</span>
                            <input
                              type="number"
                              className="search-input"
                              style={{ width: 64, height: 30 }}
                              value={transExclusiveRatio}
                              min={1}
                              max={100}
                              disabled={areaDisabled}
                              onChange={e => {
                                const v = Number(e.target.value) || 0;
                                setTransExclusiveRatio(v);
                                localStorage.setItem('transExclusiveRatio', String(v));
                              }}
                            />
                            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>% → 공급면적 환산 표기</span>
                          </div>
                        )}
                        <SpaceRangeSlider
                          min={transAreaMinPy}
                          max={transAreaMaxPy}
                          unit={transSpaceUnit}
                          maxPyeong={100}
                          supplyRatio={transProduct === 'APT' && transExclusiveRatio > 0 ? transExclusiveRatio / 100 : undefined}
                          onMinChange={setTransAreaMinPy}
                          onMaxChange={setTransAreaMaxPy}
                          onUnitChange={setTransSpaceUnit}
                          disabled={areaDisabled}
                        />
                      </>
                    )}
                  </div>
                );
              })()}

              {/* 기간 */}
              <div className="form-group">
                <label className="form-label">기간</label>
                <div className="region-select-row">
                  <div className="select-wrapper">
                    <select className="form-select" value={transPeriodType} onChange={e => setTransPeriodType(e.target.value as any)}>
                      <option value="RECENT">최근 기준</option>
                      <option value="RANGE">기간 지정</option>
                    </select>
                  </div>
                  {transPeriodType === 'RECENT' ? (
                    <div className="select-wrapper">
                      <select className="form-select" value={transRecent} onChange={e => setTransRecent(e.target.value as any)}>
                        <option value="3M">최근 3개월</option>
                        <option value="6M">최근 6개월</option>
                        <option value="1Y">최근 1년</option>
                        <option value="2Y">최근 2년</option>
                        <option value="3Y">최근 3년</option>
                        <option value="5Y">최근 5년</option>
                      </select>
                    </div>
                  ) : (
                    <>
                      <div className="select-wrapper">
                        <select className="form-select" value={transStartRange} onChange={e => setTransStartRange(e.target.value)}>
                          {transDateOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      <div className="select-wrapper">
                        <select className="form-select" value={transEndRange} onChange={e => setTransEndRange(e.target.value)}>
                          {transDateOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="rd-ctrl-foot">
              <button className="rd-run-btn" onClick={startTransactionCrawling} disabled={status.isRunning || !sigungu}>
                {status.isRunning
                  ? <><Loader2 className="spin" /> 수집 중...</>
                  : <><Play /> 데이터 수집 실행</>}
              </button>
            </div>
          </aside>

          {/* ── Main view ── */}
          <main className="rd-view">
            <div className="rd-mod-head">
              <div>
                <h1>실거래 다운로드</h1>
                <p>국토교통부 실거래가 데이터를 지역·조건별로 수집합니다 · <span style={{ color: 'var(--muted-2)' }}>data.go.kr</span></p>
              </div>
              <div className="mh-right">
                <span className={`status-badge ${badge.cls}`}>{badge.label}</span>
              </div>
            </div>

            {/* KPI strip */}
            <div className="rd-kpis">
              <div className="rd-kpi t">
                <div className="kl"><Building2 size={14} /> 수집 건수</div>
                <div className="kv accent tnum">{status.propertiesFound.toLocaleString()}</div>
                <div className="kd">건</div>
              </div>
              <div className="rd-kpi b">
                <div className="kl"><RotateCw size={14} /> 진행률</div>
                <div className="kv tnum">{status.progress}%</div>
                <div className="kd">{status.step}</div>
              </div>
              <div className="rd-kpi p">
                <div className="kl"><Layers size={14} /> 대상</div>
                <div className="kv" style={{ fontSize: 18 }}>{PRODUCT_LABELS[transProduct]}</div>
                <div className="kd">{TYPE_LABELS[transType]}</div>
              </div>
              <div className="rd-kpi a">
                <div className="kl"><Activity size={14} /> 상태</div>
                <div className="kv" style={{ fontSize: 18 }}>{badge.label}</div>
                <div className="kd">{status.isRunning ? 'LIVE' : 'IDLE'}</div>
              </div>
            </div>

            {status.isRunning && (
              <div className="nv-progress">
                <div className="nv-progress-bar"><i style={{ width: `${Math.max(status.progress, 5)}%` }} /></div>
                <div className="nv-progress-pct">{status.progress}%</div>
              </div>
            )}

            {/* Result card */}
            <div className="rd-card grow">
              <div className="result-header">
                <span className="result-title">수집 결과{hasData ? ` (${processedData.length.toLocaleString()})` : ''}</span>
                <div className="result-unit-controls">
                  <button className="btn-outline btn-sm" onClick={() => exportData('csv')} disabled={!hasData}>
                    <Download size={13} /> CSV
                  </button>
                  <button className="btn-outline btn-sm" onClick={() => exportData('json')} disabled={!hasData}>
                    <Download size={13} /> JSON
                  </button>
                  <button className="btn-outline btn-sm" onClick={() => setIsAnalysisOpen(true)} disabled={!hasData || status.isRunning}>
                    <BarChart2 size={13} /> 분석
                  </button>
                </div>
              </div>

              <div className="result-table-container">
                <div className="table-wrapper">
                  <table className="result-table">
                    <thead>
                      <tr>
                        {TRANS_COLUMNS.map(c => (
                          <th key={c.key} onClick={() => handleSort(c.key)}>
                            {c.label} {sortIcon(c.key)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {!hasData ? (
                        <tr>
                          <td colSpan={TRANS_COLUMNS.length} className="table-empty">
                            {status.isRunning ? '데이터를 수집하는 중입니다...' : '수집된 실거래 데이터가 없습니다'}
                          </td>
                        </tr>
                      ) : (
                        processedData.map((p, i) => (
                          <tr key={i}>
                            <td className="td-region">{i + 1}</td>
                            <td className="td-region">{(p as TransactionProperty).region}</td>
                            <td className="td-region">{(p as TransactionProperty).dong}</td>
                            <td className="td-complex"><span className="complex-name">{(p as TransactionProperty).name}</span></td>
                            <td className="td-region">{(p as TransactionProperty).area}</td>
                            <td className="td-region">{(p as TransactionProperty).floor}</td>
                            <td className="td-pyeong">{(p as TransactionProperty).price}</td>
                            {transType !== 'TRADE' && (
                              <td className="td-pyeong" style={{ color: 'var(--amber)' }}>{(p as TransactionProperty).monthlyRent}</td>
                            )}
                            <td className="td-region">{(p as TransactionProperty).date}</td>
                            <td className="td-region">{(p as TransactionProperty).type}</td>
                            {transType === 'TRADE' && (
                              <td className="td-region" style={{ color: 'var(--red)' }}>{(p as TransactionProperty).cancelDate}</td>
                            )}
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>

      <AnalysisModal
        isOpen={isAnalysisOpen}
        onClose={() => setIsAnalysisOpen(false)}
        data={transProperties}
        title="실거래가 분석"
        unit="만원"
        getValue={(item) => {
          const val = (item as any).price.replace(/,/g, '');
          return parseInt(val, 10);
        }}
        getLabel={(item) => (item as any).name}
        fontFamily="Pretendard"
        fontSizeOffset={0}
      />

      {/* 데이터 서버 일시 장애 안내 모달 */}
      {serverError && (
        <div className="modal-overlay" onClick={() => setServerError(null)}>
          <div
            className="modal-card"
            style={{ width: 'min(460px, 92vw)', padding: '28px 26px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 14 }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', display: 'grid', placeItems: 'center', color: 'var(--amber)', background: 'var(--yellow-dim)', boxShadow: 'inset 0 0 0 1px rgba(245,184,92,0.3)' }}>
                <AlertTriangle size={28} />
              </div>
              <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--fg)' }}>데이터 서버 일시 오류</h3>
              <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.6 }}>{serverError}</p>
              <div style={{ display: 'flex', gap: 10, marginTop: 8, width: '100%' }}>
                <button className="btn-outline" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setServerError(null)}>닫기</button>
                <button
                  className="rd-run-btn"
                  style={{ flex: 1, height: 40 }}
                  onClick={() => { setServerError(null); startTransactionCrawling(); }}
                >
                  <RotateCw /> 다시 시도
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
