import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ModalPortal } from '../../../shared/ui/ModalPortal';
import { Monitor, SlidersHorizontal, Bookmark, type LucideIcon } from 'lucide-react';
import { useAppStore } from '../../../shared/lib/store';
import { useMonthlyStore } from '../../../shared/lib/monthly-store';
import { runAnalysis, type AnalysisRequest, type AnalysisScope, type AnalysisTab, type AnalysisDataset, type TokenUsage } from '../../../entities/analysis';
import { collectCurrentView, collectFor, selectedRegionUnion, type CollectForParams } from '../lib/collect';
import { summarizeScope, formatUsage } from '../lib/saved';
import { friendlyError } from '../lib/error-message';
import { toExportMarkdown, toExportJson, toXlsxBlob, toClipboardMarkdown, downloadTextFile, downloadBlob, exportBaseName } from '../lib/export';
import { useSavedStore } from '../model/saved-store';
import type { SavedAnalysis } from '../model/saved.types';
import { MetricTree } from './MetricTree';
import { AnalysisRegionPicker, MAX_ANALYSIS_REGIONS, type PickedRegion } from './AnalysisRegionPicker';
import { SlotPickerList } from './SlotPickerList';
import { SavedAnalysisList } from './SavedAnalysisList';
import type { ChartSetSnapshot, SlotEntry } from '../../chart-slots';
import { AnalysisReport, parseReportTabs, type ReportTab } from './AnalysisResult';
import { PrintReportView } from './PrintReportView';
import { ResultBoundary } from './ResultBoundary';
import { AskPanel } from './AskPanel';
import { TokenEstimate } from './TokenEstimate';
import { ProviderSelector } from './ProviderSelector';
import { ProviderManager } from './ProviderManager';
import { getProvider, useProviderStore } from '../../../entities/provider';
import { logSearch } from '../../../../services/searchLogsRepo';

type Phase = 'idle' | 'loading' | 'done' | 'error';
type Panel = 'current' | 'custom' | 'slot';

interface AnalysisModalProps {
  open: boolean;
  onClose: () => void;
}

interface PeriodOverride {
  from: string;
  to: string;
  base: string;
}

const TAB_LABEL: Record<'price' | 'trade' | 'market', string> = {
  price: '시세지표',
  trade: '거래지표',
  market: '시장지표',
};

// 슬롯 요약용 전체 탭 라벨.
const TAB_FULL_LABEL: Record<AnalysisTab, string> = {
  'weekly-price': '주간 시세지표',
  'weekly-trade': '주간 거래지표',
  'monthly-price': '월간 시세지표',
  'monthly-trade': '월간 거래지표',
  'monthly-market': '월간 시장지표',
};

// 분석 방법 카드 정의 — 처음 보는 사용자가 한눈에 고르도록 아이콘·제목·설명을 함께 제공.
const METHODS: { id: Panel; title: string; desc: string; Icon: LucideIcon }[] = [
  { id: 'current', title: '현재 화면', desc: '지금 보고 있는 차트를 그대로 분석', Icon: Monitor },
  { id: 'custom', title: '직접 선택', desc: '지표·지역·기간을 직접 골라 분석', Icon: SlidersHorizontal },
  { id: 'slot', title: '저장 슬롯', desc: '저장해 둔 구성을 불러와 분석', Icon: Bookmark },
];

export const AnalysisModal: React.FC<AnalysisModalProps> = ({ open, onClose }) => {
  const mode = useMonthlyStore(s => s.mode);
  const weeklyTab = useMonthlyStore(s => s.weeklyTab);

  const wSel = useAppStore(s => s.selectedRegions);
  const wLabels = useAppStore(s => s.regionLabels);
  const wFrom = useAppStore(s => s.fromDate);
  const wTo = useAppStore(s => s.toDate);
  const mSel = useMonthlyStore(s => s.selectedRegions);
  const mLabels = useMonthlyStore(s => s.regionLabels);
  const mFrom = useMonthlyStore(s => s.fromDate);
  const mTo = useMonthlyStore(s => s.toDate);

  const isWeekly = mode === 'weekly';
  const curRegions = isWeekly ? wSel : mSel;
  const curLabels = isWeekly ? wLabels : mLabels;
  const curFrom = isWeekly ? wFrom : mFrom;
  const curTo = isWeekly ? wTo : mTo;

  const [panel, setPanel] = useState<Panel>('current');
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState('');
  const [resultModel, setResultModel] = useState('');
  const [resultUsage, setResultUsage] = useState<TokenUsage | undefined>();
  const [resultScope, setResultScope] = useState<AnalysisScope | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null); // 현재 결과가 이미 저장됨(또는 저장된 항목을 연 경우)
  const [showSaved, setShowSaved] = useState(false);
  const [error, setError] = useState('');
  const saveAnalysis = useSavedStore(s => s.save);
  const savedCount = useSavedStore(s => s.items.length);
  const [selTabs, setSelTabs] = useState<Set<AnalysisTab>>(new Set());
  const [pickedRegions, setPickedRegions] = useState<PickedRegion[]>([]);
  const [weeklyOverride, setWeeklyOverride] = useState<PeriodOverride | undefined>();
  const [monthlyOverride, setMonthlyOverride] = useState<PeriodOverride | undefined>();
  const abortRef = useRef<AbortController | null>(null);
  const [showManager, setShowManager] = useState(false);
  const [fontScale, setFontScale] = useState(1); // 결과 글자 배율 (0.8~1.8)
  const [regionNotice, setRegionNotice] = useState<string | null>(null); // 지역 수 초과 알림
  const selectedProviderId = useProviderStore(s => s.selectedProviderId);
  const selectedModelId = useProviderStore(s => s.selectedModelId);
  const providerModels = useProviderStore(s => s.models);
  const selectedModel = useMemo(
    () => providerModels[selectedProviderId]?.find(m => m.id === selectedModelId),
    [providerModels, selectedProviderId, selectedModelId],
  );
  const [customPayload, setCustomPayload] = useState<AnalysisRequest | null>(null);
  const [customEstLoading, setCustomEstLoading] = useState(false);
  const [resultDatasets, setResultDatasets] = useState<AnalysisDataset[] | null>(null); // Q&A 백데이터
  const [resultDataLoading, setResultDataLoading] = useState(false); // 저장분석 재오픈 시 재수집 중
  const [activeTab, setActiveTab] = useState<ReportTab | null>(null); // 결과 활성 탭(Q&A 컨텍스트 한정용)
  const [exportOpen, setExportOpen] = useState(false); // 내보내기 드롭다운
  const [printOpen, setPrintOpen] = useState(false); // A4 보고서 인쇄 미리보기
  const [copied, setCopied] = useState(false); // 복사하기 피드백
  const [slotIndex, setSlotIndex] = useState<number | null>(null); // 저장 슬롯 패널에서 선택된 슬롯
  const lastCollectRef = useRef<CollectForParams | null>(null); // 직전 분석의 수집 파라미터(저장용)

  // 모달 열릴 때 초기화
  useEffect(() => {
    if (!open) return;
    const union = selectedRegionUnion();
    setPickedRegions(union.map(u => ({ key: u.region, label: u.label })));
    const curTab = `${mode}-${weeklyTab}` as AnalysisTab;
    setSelTabs(new Set([curTab]));
    setWeeklyOverride(undefined);
    setMonthlyOverride(undefined);
    setPanel('current');
    setShowManager(false);
    setFontScale(1);
    setRegionNotice(null);
    setShowSaved(false);
    setPhase('idle');
    setResult('');
    setResultModel('');
    setResultUsage(undefined);
    setResultScope(null);
    setResultDatasets(null);
    setResultDataLoading(false);
    setActiveTab(null);
    setExportOpen(false);
    setPrintOpen(false);
    setSlotIndex(null);
    lastCollectRef.current = null;
    setSavedId(null);
    setError('');
    // 월간 거래지표 가용 지역 목록 확보(지역 선택기 availability용)
    void useMonthlyStore.getState().loadTradeRegions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 닫힐 때 진행 중 요청 취소
  useEffect(() => {
    if (!open) abortRef.current?.abort();
  }, [open]);

  // 직접 선택 폼의 수집 파라미터. (훅이 아니지만 아래 예상치 useEffect보다 먼저 정의돼야 함)
  const customCollectParams = (): CollectForParams => {
    const weekly = useAppStore.getState();
    const monthly = useMonthlyStore.getState();
    const regionLabels: Record<string, string> = {};
    for (const r of pickedRegions) regionLabels[r.key] = r.label;
    return {
      tabs: Array.from(selTabs),
      regions: pickedRegions.map(r => r.key),
      regionLabels,
      weeklyPeriod: weeklyOverride ?? { from: weekly.fromDate, to: weekly.toDate },
      monthlyPeriod: monthlyOverride ?? { from: monthly.fromDate, to: monthly.toDate },
      weeklyBaseDate: weeklyOverride?.base ?? weekly.baseDate,
      monthlyBaseDate: monthlyOverride?.base ?? monthly.baseDate,
    };
  };

  // 현재 화면(스토어 기반) 분석의 재수집 파라미터. 저장분석 재오픈 시 collectFor로 재현.
  const currentCollectParams = (): CollectForParams => {
    const weekly = useAppStore.getState();
    const monthly = useMonthlyStore.getState();
    const sub = weeklyTab === 'price' ? 'price' : weeklyTab === 'trade' ? 'trade' : 'market';
    const tab = `${mode}-${sub}` as AnalysisTab;
    const regionLabels: Record<string, string> = {};
    for (const r of curRegions) regionLabels[r] = curLabels[r] ?? r;
    return {
      tabs: [tab],
      regions: curRegions,
      regionLabels,
      weeklyPeriod: { from: weekly.fromDate, to: weekly.toDate },
      monthlyPeriod: { from: monthly.fromDate, to: monthly.toDate },
      weeklyBaseDate: weekly.baseDate,
      monthlyBaseDate: monthly.baseDate,
    };
  };

  // 직접 선택 폼 → 전송/예상치 공용 요청 빌더.
  const buildCustomRequest = (): Promise<AnalysisRequest> => collectFor(customCollectParams());

  // 예상치 훅은 조기 반환(!open)보다 반드시 위에 있어야 한다(훅 순서 고정).
  // 현재 화면 예상치: 동기 수집(스토어 기반). 선택이 바뀔 때마다 재계산.
  const currentPayload = useMemo<AnalysisRequest | null>(() => {
    if (phase !== 'idle' || panel !== 'current' || curRegions.length === 0) return null;
    try {
      return collectCurrentView();
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, panel, curRegions, curFrom, curTo, isWeekly, weeklyTab]);

  // 직접 선택·슬롯 예상치: 정적 JSON 비동기 로드 → 디바운스로 갱신.
  useEffect(() => {
    if (phase !== 'idle' || (panel !== 'custom' && panel !== 'slot')) return;
    // 직접 선택은 지역 상한(3개)을 넘으면 예상치를 끄지만, 슬롯은 저장된 그대로 추정한다.
    const overCustomLimit = panel === 'custom' && pickedRegions.length > MAX_ANALYSIS_REGIONS;
    if (pickedRegions.length === 0 || selTabs.size === 0 || overCustomLimit) {
      setCustomPayload(null);
      setCustomEstLoading(false);
      return;
    }
    let active = true;
    setCustomEstLoading(true);
    const t = setTimeout(() => {
      buildCustomRequest()
        .then(p => active && setCustomPayload(p))
        .catch(() => active && setCustomPayload(null))
        .finally(() => active && setCustomEstLoading(false));
    }, 350);
    return () => {
      active = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, panel, pickedRegions, selTabs, weeklyOverride, monthlyOverride]);

  if (!open) return null;

  const runWith = async (build: () => Promise<AnalysisRequest> | AnalysisRequest) => {
    setPhase('loading');
    setError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const payload = await build();
      payload.provider = selectedProviderId;
      payload.model = selectedModelId;
      if (ctrl.signal.aborted) return;
      if (payload.datasets.length === 0) {
        setError('분석할 데이터가 없습니다. 지역·기간·지표를 확인해주세요.');
        setPhase('error');
        return;
      }
      const res = await runAnalysis(payload, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      setResult(res.result ?? '');
      setResultModel(res.model ?? '');
      setResultUsage(res.usage);
      setResultScope(payload.scope);
      setResultDatasets(payload.datasets);
      setActiveTab(null);
      setSavedId(null);
      setPhase('done');
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(e instanceof Error ? e.message : '분석에 실패했습니다.');
      setPhase('error');
    }
  };

  // 분석 대상 지역은 최대 5개. 초과 시 알림을 띄우고 진행하지 않는다.
  const withinRegionLimit = (count: number): boolean => {
    if (count > MAX_ANALYSIS_REGIONS) {
      setRegionNotice(
        `비교 분석이 가능한 지역은 최대 ${MAX_ANALYSIS_REGIONS}개까지입니다. ` +
          `현재 ${count}개가 선택되어 있어 ${count - MAX_ANALYSIS_REGIONS}개를 빼주세요.`,
      );
      return false;
    }
    setRegionNotice(null);
    return true;
  };

  const analyzeCurrent = () => {
    if (!withinRegionLimit(curRegions.length)) return;
    void logSearch({ app: 'kb', summary: `현재 화면 분석 · ${curRegions.length}개 지역` });
    lastCollectRef.current = currentCollectParams();
    runWith(() => collectCurrentView());
  };

  const analyzeCustom = () => {
    if (!withinRegionLimit(pickedRegions.length)) return;
    void logSearch({
      app: 'kb',
      summary: `직접 선택 분석 · ${pickedRegions.map((r) => r.label).join(', ') || '지역 미지정'}`,
    });
    lastCollectRef.current = customCollectParams();
    runWith(buildCustomRequest);
  };

  // 슬롯 선택 → 슬롯에 담긴 주간·월간 데이터를 분석 파라미터로 채운다(패널 이동 없음).
  const handleSlotSelect = (entry: SlotEntry, index: number) => {
    const tabs = new Set<AnalysisTab>();
    const regions: PickedRegion[] = [];
    const seen = new Set<string>();
    const addRegions = (snap: ChartSetSnapshot) => {
      for (const k of snap.selectedRegions) {
        if (seen.has(k)) continue;
        seen.add(k);
        regions.push({ key: k, label: snap.regionLabels[k] ?? k });
      }
    };

    if (entry.weekly) {
      const sub = entry.weekly.weeklyTab === 'market' ? 'price' : entry.weekly.weeklyTab;
      tabs.add(`weekly-${sub}` as AnalysisTab);
      addRegions(entry.weekly);
      setWeeklyOverride({ from: entry.weekly.fromDate, to: entry.weekly.toDate, base: entry.weekly.baseDate });
    } else {
      setWeeklyOverride(undefined);
    }

    if (entry.monthly) {
      tabs.add(`monthly-${entry.monthly.weeklyTab}` as AnalysisTab);
      addRegions(entry.monthly);
      setMonthlyOverride({ from: entry.monthly.fromDate, to: entry.monthly.toDate, base: entry.monthly.baseDate });
    } else {
      setMonthlyOverride(undefined);
    }

    setSelTabs(tabs);
    setPickedRegions(regions);
    setSlotIndex(index);
    setRegionNotice(null);
  };

  // 슬롯 분석 실행 — 저장된 지역 그대로(상한 검사 없이) 슬롯 데이터로 분석.
  const analyzeSlot = () => {
    void logSearch({
      app: 'kb',
      summary: `슬롯 분석 · ${pickedRegions.map((r) => r.label).join(', ') || '저장 슬롯'}`,
    });
    lastCollectRef.current = customCollectParams();
    runWith(buildCustomRequest);
  };

  const cancel = () => {
    abortRef.current?.abort();
    setPhase('idle');
  };

  // 현재 결과를 저장 슬롯에 보관.
  const saveCurrent = () => {
    if (!result || savedId) return;
    const scopeLabel = resultScope ? summarizeScope(resultScope) : '분석 결과';
    const id = saveAnalysis({
      name: scopeLabel,
      scopeLabel,
      provider: selectedProviderId,
      model: resultModel,
      usage: resultUsage,
      markdown: result,
      collect: lastCollectRef.current ?? undefined,
    });
    setSavedId(id);
  };

  // 결과·데이터를 파일로 내보낸다(다른 AI 핸드오프용). 전체 보고서 + 분석에 쓴 전체 데이터.
  // md/json/xlsx 모두 분석 결과를 담는다(엑셀은 '분석 결과' 시트, json은 구조화 분석 + 데이터).
  const doExport = (fmt: 'md' | 'json' | 'xlsx') => {
    setExportOpen(false);
    const ds = resultDatasets ?? [];
    const base = exportBaseName();
    if (fmt === 'md') downloadTextFile(`${base}.md`, toExportMarkdown(result, resultScope, ds), 'text/markdown');
    else if (fmt === 'json') downloadTextFile(`${base}.json`, toExportJson(result, resultScope, ds), 'application/json');
    else downloadBlob(`${base}.xlsx`, toXlsxBlob(result, resultScope, ds));
  };

  // 분석 결과(보고서)를 클립보드에 복사. 다른 AI에 바로 붙여넣기 좋게 챕터 실선 구분 포함.
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(toClipboardMarkdown(result));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 클립보드 미지원 환경은 조용히 무시 */
    }
  };

  // 저장된 항목을 결과 화면으로 열기. collect가 있으면 Q&A용 데이터를 재수집한다.
  const openSaved = (item: SavedAnalysis) => {
    setResult(item.markdown);
    setResultModel(item.model);
    setResultUsage(item.usage);
    setResultScope(null);
    setResultDatasets(null);
    setActiveTab(null);
    setSavedId(item.id);
    setShowSaved(false);
    setPhase('done');
    if (item.collect) {
      setResultDataLoading(true);
      collectFor(item.collect)
        .then(req => {
          setResultScope(req.scope);
          setResultDatasets(req.datasets);
        })
        .catch(() => {})
        .finally(() => setResultDataLoading(false));
    }
  };

  const customDisabled = selTabs.size === 0 || pickedRegions.length === 0;

  const wEff = weeklyOverride ?? { from: wFrom, to: wTo };
  const mEff = monthlyOverride ?? { from: mFrom, to: mTo };
  const overridden = !!weeklyOverride || !!monthlyOverride;

  // 로딩 안내는 프로바이더에 맞게. claude-bridge만 Claude 세션이 필요하다.
  const activeProvider = getProvider(selectedProviderId);
  const isBridgeProvider = !activeProvider || activeProvider.apiShape === 'claude-bridge';
  const loadingHint = isBridgeProvider
    ? '앱과 Claude 세션이 함께 켜져 있어야 결과가 도착합니다.'
    : `${activeProvider.label}에 직접 요청하고 있습니다. 잠시만 기다려주세요.`;

  // 결과 화면은 가로 50vw·세로 80vh 고정. 설정(선택) 화면은 요소가 충분히 보이도록 크게 고정.
  const sizeClass =
    phase === 'done'
      ? 'h-[80vh] w-[50vw] min-w-[560px]'
      : 'h-[88vh] w-[860px] max-w-[94vw]';

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className={`flex ${sizeClass} flex-col overflow-hidden rounded-2xl bg-white shadow-xl`}>
        {/* 헤더 */}
        <div className="flex flex-none items-center justify-between border-b border-gray-200 px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-blue-600 text-white text-sm font-bold">AI</span>
            데이터 분석
          </h2>
          <div className="flex items-center gap-3">
            {/* 결과 글자 크기 조절 (결과 화면에서만) */}
            {phase === 'done' && (
              <div className="flex items-center gap-2 rounded-lg bg-gray-100 px-2.5 py-1" title={`글자 크기 ${Math.round(fontScale * 100)}%`}>
                <span className="text-[11px] font-semibold leading-none text-gray-400">A</span>
                <input
                  type="range"
                  min={0.8}
                  max={1.8}
                  step={0.1}
                  value={fontScale}
                  onChange={e => setFontScale(Number(e.target.value))}
                  className="h-1 w-24 cursor-pointer accent-blue-600"
                  aria-label="결과 글자 크기 조절"
                />
                <span className="text-base font-semibold leading-none text-gray-500">A</span>
                <span className="w-9 text-right text-[11px] tabular-nums text-gray-400">{Math.round(fontScale * 100)}%</span>
              </div>
            )}
            <button onClick={onClose} className="eos-modal-x" aria-label="닫기">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        {/* 본문 */}
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {phase === 'idle' && (
            showManager ? (
              <ProviderManager onBack={() => setShowManager(false)} />
            ) : showSaved ? (
              <SavedAnalysisList onBack={() => setShowSaved(false)} onOpen={openSaved} />
            ) : (
              <>
                {/* 안내 + 저장된 분석 */}
                <div className="mb-5 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-xl font-bold text-gray-900">무엇을 분석할까요?</h3>
                    <p className="mt-1 text-base text-gray-500">
                      ① 분석할 데이터를 고르고 → ② 사용할 AI를 선택한 뒤 → ③ <b>분석하기</b>를 누르세요.
                    </p>
                  </div>
                  <button
                    onClick={() => setShowSaved(true)}
                    className="flex-none rounded-lg border border-gray-300 px-4 py-2 text-base text-gray-600 hover:bg-gray-50"
                  >
                    저장된 분석{savedCount ? ` (${savedCount})` : ''}
                  </button>
                </div>

                {/* STEP 1 — 분석 방법 카드 */}
                <p className="mb-2 text-sm font-bold uppercase tracking-wide text-gray-400">STEP 1 · 분석할 데이터 고르기</p>
                <div className="mb-5 grid grid-cols-3 gap-3">
                  {METHODS.map(m => {
                    const active = panel === m.id;
                    const Icon = m.Icon;
                    return (
                      <button
                        key={m.id}
                        onClick={() => { setPanel(m.id); setRegionNotice(null); setSlotIndex(null); }}
                        className={`flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-left transition-colors ${
                          active ? 'border-blue-500 bg-blue-50/60' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        <Icon className={`h-6 w-6 ${active ? 'text-blue-600' : 'text-gray-400'}`} />
                        <span className="text-base font-bold text-gray-900">{m.title}</span>
                        <span className="text-sm leading-snug text-gray-500">{m.desc}</span>
                      </button>
                    );
                  })}
                </div>

                {/* STEP 2 — AI 모델 */}
                <p className="mb-2 text-sm font-bold uppercase tracking-wide text-gray-400">STEP 2 · 분석에 사용할 AI</p>
                <div className="mb-5 rounded-xl border border-gray-200 bg-gray-50/60 p-3">
                  <ProviderSelector onManage={() => setShowManager(true)} />
                </div>

                {/* STEP 3 — 확인하고 분석 */}
                <p className="mb-2 text-sm font-bold uppercase tracking-wide text-gray-400">STEP 3 · 확인하고 분석하기</p>

                {regionNotice && (
                  <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-base text-amber-700">
                    <svg className="mt-0.5 h-5 w-5 flex-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                    <span>{regionNotice}</span>
                  </div>
                )}

                {panel === 'current' && (
                  <div className="space-y-3">
                    <p className="text-base text-gray-500">지금 보고 있는 화면을 그대로 분석합니다.</p>
                    <dl className="space-y-2 rounded-xl border border-gray-200 bg-gray-50 p-4 text-base">
                      <Row label="모드 · 지표">{isWeekly ? '주간' : '월간'} · {TAB_LABEL[weeklyTab]}</Row>
                      <Row label="기간">{curFrom} ~ {curTo}</Row>
                      <Row label="지역">
                        {curRegions.length ? curRegions.map(r => curLabels[r] ?? r).join(', ') : <span className="text-gray-400">선택된 지역 없음</span>}
                      </Row>
                    </dl>
                    <TokenEstimate payload={currentPayload} model={selectedModel} />
                    <button
                      onClick={analyzeCurrent}
                      disabled={curRegions.length === 0}
                      className="w-full rounded-lg bg-blue-600 py-3 text-lg font-bold text-white hover:bg-blue-700 disabled:bg-gray-300"
                    >
                      분석하기
                    </button>
                  </div>
                )}

                {panel === 'custom' && (
                  <div className="space-y-4">
                    <MetricTree selected={selTabs} onChange={setSelTabs} />
                    <AnalysisRegionPicker value={pickedRegions} onChange={setPickedRegions} />

                    <p className="text-sm text-gray-400">
                      기간: 주간 {wEff.from}~{wEff.to} · 월간 {mEff.from}~{mEff.to}{' '}
                      {overridden ? '(슬롯 기간 적용)' : '(현재 설정 사용)'}
                    </p>

                    <TokenEstimate payload={customPayload} model={selectedModel} loading={customEstLoading} />

                    <button
                      onClick={analyzeCustom}
                      disabled={customDisabled}
                      className="w-full rounded-lg bg-blue-600 py-3 text-lg font-bold text-white hover:bg-blue-700 disabled:bg-gray-300"
                    >
                      분석하기
                    </button>
                  </div>
                )}

                {panel === 'slot' && (
                  <div className="space-y-3">
                    <SlotPickerList selectedIndex={slotIndex} onSelect={handleSlotSelect} />

                    {slotIndex !== null && (
                      <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/40 p-4">
                        <dl className="space-y-2 text-base">
                          <Row label="지표">
                            {selTabs.size
                              ? Array.from(selTabs).map(t => TAB_FULL_LABEL[t]).join(', ')
                              : <span className="text-gray-400">없음</span>}
                          </Row>
                          <Row label="지역">
                            {pickedRegions.length
                              ? pickedRegions.map(r => r.label).join(', ')
                              : <span className="text-gray-400">없음</span>}
                          </Row>
                          <Row label="기간">
                            {weeklyOverride && `주간 ${weeklyOverride.from}~${weeklyOverride.to}`}
                            {weeklyOverride && monthlyOverride ? ' · ' : ''}
                            {monthlyOverride && `월간 ${monthlyOverride.from}~${monthlyOverride.to}`}
                          </Row>
                        </dl>

                        <TokenEstimate payload={customPayload} model={selectedModel} loading={customEstLoading} />

                        <button
                          onClick={analyzeSlot}
                          disabled={selTabs.size === 0 || pickedRegions.length === 0}
                          className="w-full rounded-lg bg-blue-600 py-3 text-lg font-bold text-white hover:bg-blue-700 disabled:bg-gray-300"
                        >
                          분석하기
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )
          )}

          {phase === 'loading' && (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-4 h-9 w-9 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
              <p className="text-base text-gray-600">AI가 데이터를 분석하고 있습니다…</p>
              <p className="mt-1 text-sm text-gray-400">{loadingHint}</p>
              <button onClick={cancel} className="mt-5 rounded-lg border border-gray-300 px-4 py-2 text-base text-gray-600 hover:bg-gray-50">
                취소
              </button>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="mb-4 max-w-md text-base text-red-600">{friendlyError(error)}</p>
              <button onClick={() => setPhase('idle')} className="rounded-lg bg-blue-600 px-4 py-2 text-base font-semibold text-white hover:bg-blue-700">
                다시 시도
              </button>
            </div>
          )}

          {phase === 'done' && (
            <ResultBoundary>
              <AnalysisReport text={result} scale={fontScale} onActiveChange={setActiveTab} />
              {resultDataLoading ? (
                <p className="mt-6 border-t border-gray-200 pt-4 text-xs text-gray-400">질문용 데이터를 불러오는 중…</p>
              ) : resultScope ? (
                (() => {
                  const ctx = scopeAskContext(activeTab, result, resultScope, resultDatasets ?? []);
                  return (
                    <AskPanel
                      scope={ctx.scope}
                      datasets={ctx.datasets}
                      resultMarkdown={ctx.markdown}
                      dataAvailable={ctx.datasets.length > 0}
                    />
                  );
                })()
              ) : null}
            </ResultBoundary>
          )}
        </div>

        {/* 푸터 (결과 화면) */}
        {phase === 'done' && (
          <div className="flex flex-none items-center gap-2 border-t border-gray-200 px-5 py-3">
            <span className="mr-auto min-w-0 truncate text-sm text-gray-400">
              {resultModel && `응답 모델: ${resultModel}`}
              {resultUsage && formatUsage(resultUsage) ? `  ·  ${formatUsage(resultUsage)}` : ''}
            </span>
            <button
              onClick={() => setPrintOpen(true)}
              className="flex-none rounded-lg border border-gray-300 px-4 py-2 text-base text-gray-700 hover:bg-gray-50"
              title="A4 정형 보고서로 인쇄하거나 PDF로 저장합니다"
            >
              인쇄/PDF
            </button>
            <button
              onClick={doCopy}
              className="flex-none rounded-lg border border-gray-300 px-4 py-2 text-base text-gray-700 hover:bg-gray-50 disabled:border-green-200 disabled:bg-green-50 disabled:text-green-600"
              disabled={copied}
            >
              {copied ? '복사됨 ✓' : '복사하기'}
            </button>
            <div className="relative flex-none">
              <button
                onClick={() => setExportOpen(o => !o)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-base text-gray-700 hover:bg-gray-50"
              >
                내보내기 ▾
              </button>
              {exportOpen && (
                <div className="absolute bottom-full right-0 mb-1 w-48 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
                  <button onClick={() => doExport('md')} className="block w-full px-3 py-2.5 text-left text-base hover:bg-gray-50">Markdown (.md) · 추천</button>
                  <button onClick={() => doExport('json')} className="block w-full px-3 py-2.5 text-left text-base hover:bg-gray-50">JSON (.json)</button>
                  <button onClick={() => doExport('xlsx')} className="block w-full px-3 py-2.5 text-left text-base hover:bg-gray-50">Excel (.xlsx)</button>
                </div>
              )}
            </div>
            <button
              onClick={saveCurrent}
              disabled={!!savedId}
              className="flex-none rounded-lg border border-gray-300 px-4 py-2 text-base text-gray-700 hover:bg-gray-50 disabled:border-green-200 disabled:bg-green-50 disabled:text-green-600"
            >
              {savedId ? '저장됨 ✓' : '결과 저장'}
            </button>
            <button onClick={() => setPhase('idle')} className="flex-none rounded-lg border border-gray-300 px-4 py-2 text-base text-gray-600 hover:bg-gray-50">
              다시 분석
            </button>
            <button onClick={onClose} className="flex-none rounded-lg bg-blue-600 px-4 py-2 text-base font-semibold text-white hover:bg-blue-700">
              닫기
            </button>
          </div>
        )}
      </div>
    </div>

    {/* A4 정형 보고서 인쇄/PDF 미리보기 — 현재 보고 있는 탭 기준 */}
    {printOpen && phase === 'done' && (() => {
      const tab = activeTab ?? parseReportTabs(result)[0]!;
      return (
        <PrintReportView
          onClose={() => setPrintOpen(false)}
          tabLabel={tab.label}
          markdown={tab.body}
          scope={resultScope}
          datasets={resultDatasets ?? []}
          model={resultModel}
        />
      );
    })()}
    </ModalPortal>
  );
};

// Q&A 컨텍스트를 현재 보고 있는 탭으로 좁힌다.
// 활성 탭 라벨이 특정 지역이면 그 지역의 데이터·결과만, '종합'·단일 탭이면 전체를 사용한다.
export function scopeAskContext(
  active: ReportTab | null,
  fullResult: string,
  scope: AnalysisScope,
  datasets: AnalysisDataset[],
): { markdown: string; scope: AnalysisScope; datasets: AnalysisDataset[] } {
  const markdown = active?.body ?? fullResult;
  const regionKey = active
    ? Object.keys(scope.regionLabels).find(k => scope.regionLabels[k] === active.label)
    : undefined;
  if (!regionKey) return { markdown, scope, datasets };

  const narrowed = datasets
    .map(d => {
      const rs = d.byRegion[regionKey];
      return rs ? { ...d, byRegion: { [regionKey]: rs } } : null;
    })
    .filter((d): d is AnalysisDataset => d !== null);
  const narrowedScope: AnalysisScope = { ...scope, regions: [regionKey], regionLabels: { [regionKey]: active!.label } };
  return { markdown, scope: narrowedScope, datasets: narrowed };
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex gap-3">
    <dt className="w-24 flex-none font-medium text-gray-500">{label}</dt>
    <dd className="flex-1 text-gray-800">{children}</dd>
  </div>
);
