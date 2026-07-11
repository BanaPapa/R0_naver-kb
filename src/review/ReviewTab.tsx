import React, { useCallback, useEffect, useState } from 'react';
import { detectExtension } from '../services/extensionBridge';
import { useProviderStore } from '../kb/entities/provider';
import { collectResidentReviews } from './reviewBridge';
import { analyzeReviews } from './lib/analyze';
import { loadAnalyses, saveAnalysis, deleteAnalysis, clearAnalyses } from './lib/analysisStore';
import SearchPanel, { type AptType } from './components/SearchPanel';
import AptListView from './components/AptListView';
import ReviewPanel from './components/ReviewPanel';
import AnalysisModal from './components/AnalysisModal';
import { useToast } from './components/Toast';
import type {
  Apartment,
  AnalysisResult,
  AnalysisMeta,
  FetchProgress,
  ReviewsByApt,
  SavedAnalysis,
} from './types';
import type { RegionSelection } from '../types';
import './review.css';

const EMPTY_REGION: RegionSelection = { large: null, mid: null, small: null };

interface ReviewTabProps {
  onOpenSettings?: () => void;
}

function EmptyState({ region }: { region: RegionSelection }) {
  const hasLarge = !!region?.large;
  const hasMid = !!region?.mid;
  const hasSmall = !!region?.small;

  return (
    <div className="empty-state">
      <div className="empty-state-icon">🏘</div>
      <div className="empty-state-title">단지를 조회하세요</div>
      <div className="empty-state-desc">
        왼쪽에서 지역을 선택하고 단지 유형을 고른 뒤<br />
        [단지 조회] 버튼을 누르면 단지 목록이 표시됩니다.
      </div>
      <div className="empty-steps">
        <div className={`empty-step${hasLarge ? ' done' : ''}`}>
          <div className="empty-step-num">{hasLarge ? '✓' : '1'}</div>
          시 / 도 선택 {hasLarge && `— ${region.large?.name}`}
        </div>
        <div className={`empty-step${hasMid ? ' done' : ''}`}>
          <div className="empty-step-num">{hasMid ? '✓' : '2'}</div>
          시 / 군 / 구 선택 {hasMid && `— ${region.mid?.name}`}
        </div>
        <div className={`empty-step${hasSmall ? ' done' : ''}`}>
          <div className="empty-step-num">{hasSmall ? '✓' : '3'}</div>
          읍 / 면 / 동 선택 {hasSmall && `— ${region.small?.name}`}
        </div>
        <div className="empty-step">
          <div className="empty-step-num">4</div>
          [단지 조회] 클릭
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ progress }: { progress: FetchProgress }) {
  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  return (
    <div className="progress-wrap">
      <div className="progress-label">
        <span className="progress-apt">{progress.aptName}</span>
        <span className="progress-count">
          {progress.current} / {progress.total}
        </span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ReviewTab({ onOpenSettings }: ReviewTabProps) {
  const { showToast, ToastContainer } = useToast();

  /* ── 제공자 정보 (분석용) ── */
  const provider = useProviderStore((s) => s.selectedProviderId);
  const model = useProviderStore((s) => s.selectedModelId);
  const statuses = useProviderStore((s) => s.statuses);
  const refreshProviders = useProviderStore((s) => s.refreshProviders);

  /* ── 크롬 확장 릴레이 ── */
  const [extConnected, setExtConnected] = useState(false);
  useEffect(() => {
    void detectExtension().then(setExtConnected);
    void refreshProviders().catch(() => undefined);
  }, [refreshProviders]);

  /* ── 검색 상태 ── */
  const [region, setRegion] = useState<RegionSelection>(EMPTY_REGION);
  const [aptType, setAptType] = useState<AptType>('apt-all');

  /* ── 결과 상태 ── */
  const [apts, setApts] = useState<Apartment[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewCount, setReviewCount] = useState(50);

  const [reviewsByApt, setReviewsByApt] = useState<ReviewsByApt>({});
  const [activeAptTab, setActiveAptTab] = useState<string | null>(null);
  const [fetchProgress, setFetchProgress] = useState<FetchProgress | null>(null);
  const [isFetching, setIsFetching] = useState(false);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);

  /* ── 분석 결과 모달·저장 ── */
  const [analyses, setAnalyses] = useState<SavedAnalysis[]>([]);
  const [currentMeta, setCurrentMeta] = useState<AnalysisMeta | null>(null);
  const [currentSaved, setCurrentSaved] = useState(false);
  const [analysisModalOpen, setAnalysisModalOpen] = useState(false);
  useEffect(() => {
    setAnalyses(loadAnalyses());
  }, []);

  useEffect(() => {
    setAnalysisResult(null);
  }, [activeAptTab]);

  /* ── 지역·유형 변경 시 결과 초기화 ── */
  const resetResults = () => {
    setApts([]);
    setSelected(new Set());
    setReviewsByApt({});
    setActiveAptTab(null);
    setFetchProgress(null);
    setAnalysisResult(null);
    setSearchError(null);
  };

  const handleRegionChange = useCallback((r: RegionSelection) => {
    setRegion(r);
    resetResults();
  }, []);

  const handleAptTypeChange = useCallback((t: AptType) => {
    setAptType(t);
    resetResults();
  }, []);

  /* ── 단지 검색 ── */
  const handleSearch = useCallback(async () => {
    const legalCode = region?.small?.code;
    if (!legalCode) {
      showToast('읍/면/동을 선택해주세요.', 'warning');
      return;
    }

    setIsSearching(true);
    setSearchError(null);
    setApts([]);
    setSelected(new Set());
    setReviewsByApt({});
    setActiveAptTab(null);
    setFetchProgress(null);
    setAnalysisResult(null);

    try {
      const res = await fetch('/api/reviews/apartments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ legalCode, listType: aptType }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data?.error ?? data?.message ?? '단지 조회 실패';
        setSearchError(msg);
        showToast(msg, 'error');
        return;
      }
      setApts(data);
      if (data.length === 0) setSearchError('해당 지역에 단지가 없습니다.');
    } catch {
      const msg = '단지 조회 중 오류가 발생했습니다.';
      setSearchError(msg);
      showToast(msg, 'error');
    } finally {
      setIsSearching(false);
    }
  }, [region, aptType, showToast]);

  /* ── 리뷰 수집 (확장 릴레이) ── */
  const handleFetchReviews = useCallback(async () => {
    if (selected.size === 0) {
      showToast('단지를 선택해주세요.', 'warning');
      return;
    }

    // 확장이 나중에 설치됐을 수 있으므로 수집 시점에 재감지
    const useExt = extConnected || (await detectExtension());
    if (useExt !== extConnected) setExtConnected(useExt);

    if (!useExt) {
      showToast('Estate-OS 연결기 확장을 설치·활성화한 뒤 페이지를 새로고침해주세요.', 'warning');
      return;
    }

    setIsFetching(true);
    setReviewsByApt({});
    setActiveAptTab(null);
    setAnalysisResult(null);

    const targets = apts.filter((a) => selected.has(a.id));
    setFetchProgress({ current: 0, total: targets.length, aptName: '준비 중…' });

    let firstTab: string | null = null;
    for (let i = 0; i < targets.length; i += 1) {
      const apt = targets[i];
      setFetchProgress({ current: i + 1, total: targets.length, aptName: apt.name });
      const maxR = reviewCount === 0 ? 9999 : reviewCount;
      try {
        const r = await collectResidentReviews(apt.id, maxR);
        if (!r.ok && r.error === 'NOT_LOGGED_IN') {
          showToast('크롬에서 리뷰 사이트에 로그인한 뒤 다시 시도해주세요. (연결기 확장 팝업에서 로그인 상태를 확인할 수 있습니다)', 'error');
          break;
        }
        if (!r.ok && r.reviews.length === 0) {
          showToast(`${apt.name}: 수집 실패 (${r.error})`, 'error');
          continue;
        }
        // 부분 수집(!r.ok 이지만 일부 데이터 확보)은 결과를 저장하되 경고로 알린다.
        if (!r.ok && r.reviews.length > 0) {
          showToast(`${apt.name}: 일부만 수집되었습니다 (${r.reviews.length}건, ${r.error})`, 'warning');
        }
        if (r.reviews.length) {
          setReviewsByApt((prev) => ({
            ...prev,
            [apt.id]: { aptId: apt.id, aptName: apt.name, reviews: r.reviews },
          }));
          if (!firstTab) {
            firstTab = apt.id;
            setActiveAptTab(apt.id);
          }
        }
      } catch {
        showToast(`${apt.name}: 수집 실패`, 'error');
      }
    }
    setFetchProgress(null);
    setIsFetching(false);
  }, [selected, apts, reviewCount, extConnected, showToast]);

  /* ── AI 분석 (R0 provider store + kb-analysis) ── */
  const handleAnalyze = useCallback(async () => {
    const activeReviews = activeAptTab ? reviewsByApt[activeAptTab]?.reviews : undefined;
    if (!activeReviews?.length) return;
    // 프로바이더 준비 가드: 제공자 연결 + 모델 선택이 모두 갖춰졌는지 확인.
    if (!model || !provider || !statuses[provider]?.connected) {
      showToast('설정에서 AI 제공자와 모델을 연결·선택해 주세요.', 'warning');
      return;
    }

    const aptName = (activeAptTab ? reviewsByApt[activeAptTab]?.aptName : undefined) ?? '이름 없음';

    setIsAnalyzing(true);
    setAnalysisResult(null);
    try {
      const result = await analyzeReviews(activeReviews, provider, model);
      setAnalysisResult(result);
      setCurrentMeta({ aptName, provider, model });
      setCurrentSaved(false);
      setAnalysisModalOpen(true);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'AI 분석에 실패했습니다.', 'error');
    } finally {
      setIsAnalyzing(false);
    }
  }, [reviewsByApt, activeAptTab, provider, model, statuses, showToast]);

  /* ── 분석 저장·관리 ── */
  const handleSaveCurrent = useCallback(() => {
    if (!analysisResult || !currentMeta) return;
    saveAnalysis({ aptName: currentMeta.aptName, provider: currentMeta.provider, model: currentMeta.model, result: analysisResult });
    setAnalyses(loadAnalyses());
    setCurrentSaved(true);
    showToast('분석을 저장했습니다.', 'success');
  }, [analysisResult, currentMeta, showToast]);

  const handleDeleteAnalysis = useCallback((id: string) => {
    setAnalyses(deleteAnalysis(id));
  }, []);

  const handleClearAnalyses = useCallback(() => {
    setAnalyses(clearAnalyses());
  }, []);

  /* ── 리뷰 삭제 ── */
  const handleDeleteReviews = useCallback(
    (aptId: string, indices: number[]) => {
      const group = reviewsByApt[aptId];
      if (!group) return;
      const toDelete = new Set(indices);
      const remaining = group.reviews.filter((_, i) => !toDelete.has(i));

      const next = { ...reviewsByApt };
      if (remaining.length === 0) {
        // 리뷰를 전부 삭제하면 빈 엔트리를 남기지 않고 단지 키 자체를 제거한다.
        delete next[aptId];
      } else {
        next[aptId] = { ...group, reviews: remaining };
      }
      setReviewsByApt(next);

      // 활성 탭이 비워진 단지였다면 남은 단지 중 첫 번째로 이동(없으면 null).
      if (remaining.length === 0 && activeAptTab === aptId) {
        const keys = Object.keys(next);
        setActiveAptTab(keys.length ? keys[0] : null);
      }
      setAnalysisResult(null);
    },
    [reviewsByApt, activeAptTab],
  );

  const showContent = apts.length > 0 || isSearching || !!searchError;
  const hasReviews = Object.keys(reviewsByApt).length > 0;
  const fetchedAptIds = new Set(Object.keys(reviewsByApt));

  return (
    <div className="review-scope">
      <div className="review-layout">
        {/* 검색 서브패널 */}
        <SearchPanel
          region={region}
          onRegionChange={handleRegionChange}
          aptType={aptType}
          onAptTypeChange={handleAptTypeChange}
          onSearch={handleSearch}
          isSearching={isSearching}
          disabled={isSearching || isFetching}
          analysesCount={analyses.length}
          onOpenAnalyses={() => setAnalysisModalOpen(true)}
        />

        {/* 단지목록 + 리뷰 */}
        <div className="main-content">
          <div className="main-body">
            <div className="review-workspace">
              {showContent ? (
                <>
                  <AptListView
                    apts={apts}
                    isLoading={isSearching}
                    error={searchError}
                    selected={selected}
                    onSelectionChange={setSelected}
                    reviewCount={reviewCount}
                    onReviewCountChange={setReviewCount}
                    onFetchReviews={handleFetchReviews}
                    isFetching={isFetching}
                    fetchedAptIds={fetchedAptIds}
                    onAptBadgeClick={setActiveAptTab}
                    reviewsByApt={reviewsByApt}
                  />
                  {isFetching && fetchProgress && <ProgressBar progress={fetchProgress} />}
                  {hasReviews ? (
                    <ReviewPanel
                      reviewsByApt={reviewsByApt}
                      activeAptTab={activeAptTab}
                      onTabChange={setActiveAptTab}
                      isAnalyzing={isAnalyzing}
                      hasResult={!!analysisResult}
                      analysesCount={analyses.length}
                      onOpenAnalyses={() => setAnalysisModalOpen(true)}
                      onAnalyze={handleAnalyze}
                      onOpenSettings={() => onOpenSettings?.()}
                      onDeleteReviews={handleDeleteReviews}
                    />
                  ) : (
                    <div className="review-placeholder">
                      {isFetching ? (
                        ''
                      ) : (
                        <>
                          단지를 선택하고
                          <br />
                          리뷰 수집을 눌러주세요
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <EmptyState region={region} />
              )}
            </div>
          </div>
        </div>
      </div>

      <AnalysisModal
        open={analysisModalOpen}
        onClose={() => setAnalysisModalOpen(false)}
        current={analysisResult ? { result: analysisResult, meta: currentMeta } : null}
        currentSaved={currentSaved}
        history={analyses}
        onSaveCurrent={handleSaveCurrent}
        onDeleteItem={handleDeleteAnalysis}
        onClearHistory={handleClearAnalyses}
      />

      <ToastContainer />
    </div>
  );
}
