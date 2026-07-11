import React, { useState, useEffect } from 'react';
import {
  PROVIDERS,
  getProvider,
  useProviderStore,
  sortModels,
  modelOptionLabel,
  DEFAULT_MODEL_SORT,
} from '../../kb/entities/provider';
import type { ReviewsByApt } from '../types';

interface ReviewPanelProps {
  reviewsByApt: ReviewsByApt;
  activeAptTab: string | null;
  onTabChange: (id: string) => void;
  isAnalyzing: boolean;
  hasResult: boolean;
  analysesCount: number;
  onOpenAnalyses: () => void;
  onAnalyze: () => void;
  onOpenSettings: () => void;
  onDeleteReviews: (aptId: string, indices: number[]) => void;
}

export default function ReviewPanel({
  reviewsByApt,
  activeAptTab,
  onTabChange,
  isAnalyzing,
  hasResult,
  analysesCount,
  onOpenAnalyses,
  onAnalyze,
  onOpenSettings,
  onDeleteReviews,
}: ReviewPanelProps) {
  const [checkedSet, setCheckedSet] = useState<Set<number>>(new Set());

  // ── R0 provider store (R7 apiKeys/oauthTokens 대체) ──
  const providerId = useProviderStore((s) => s.selectedProviderId);
  const modelId = useProviderStore((s) => s.selectedModelId);
  const statuses = useProviderStore((s) => s.statuses);
  const models = useProviderStore((s) => s.models[providerId]) ?? [];
  const modelsLoading = useProviderStore((s) => s.loadingModels[providerId] ?? false);
  const select = useProviderStore((s) => s.select);
  const refreshModels = useProviderStore((s) => s.refreshModels);

  // 연결된 제공사(=설정에서 API 키/구독 연결 완료). claude-bridge는 모델 선택이 없어
  // JSON 스키마 분석에 부적합하므로 제외한다(R7 대비 의도적 차이).
  const connectedProviders = PROVIDERS.filter(
    (p) => p.apiShape !== 'claude-bridge' && statuses[p.id]?.connected,
  );
  const currentProvider = getProvider(providerId);
  const isConnected =
    currentProvider?.apiShape !== 'claude-bridge' && !!statuses[providerId]?.connected;

  const sortedModels = sortModels(models, DEFAULT_MODEL_SORT);

  // 현재 선택된 제공사가 미연결이면 연결된 첫 제공사로 자동 전환
  useEffect(() => {
    if (!isConnected && connectedProviders.length > 0) {
      select(connectedProviders[0].id, null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses]);

  // 연결된 제공사면 모델 목록 로드
  useEffect(() => {
    if (isConnected) void refreshModels(providerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, isConnected]);

  /* ── 리뷰 체크박스 ── */
  const aptEntries = Object.values(reviewsByApt);
  const activeData = activeAptTab ? reviewsByApt[activeAptTab] : undefined;
  const activeReviews = activeData?.reviews ?? [];

  useEffect(() => {
    setCheckedSet(new Set());
  }, [activeAptTab]);

  const allChecked = activeReviews.length > 0 && checkedSet.size === activeReviews.length;
  const someChecked = checkedSet.size > 0;

  const toggleCheck = (i: number) => {
    const next = new Set(checkedSet);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setCheckedSet(next);
  };

  const toggleAll = () => {
    if (allChecked) setCheckedSet(new Set());
    else setCheckedSet(new Set(activeReviews.map((_, i) => i)));
  };

  const deleteSelected = () => {
    if (activeAptTab) onDeleteReviews(activeAptTab, [...checkedSet]);
    setCheckedSet(new Set());
  };

  const canAnalyze = isConnected && !!modelId && activeReviews.length > 0 && !isAnalyzing;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      {/* 탭 바 */}
      <div className="review-header-row">
        <div className="review-tabs">
          {aptEntries.map(({ aptId, aptName, reviews }) => (
            <button
              key={aptId}
              className={`review-tab${activeAptTab === aptId ? ' active' : ''}`}
              onClick={() => onTabChange(aptId)}
            >
              {aptName}
              <span className="tab-badge">{reviews.length}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 리뷰 패널 */}
      <div className="review-panel">
        {/* 패널 헤더 */}
        <div className="review-panel-header">
          <label className="review-select-all-ctrl">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} disabled={activeReviews.length === 0} />
            전체 {someChecked ? `(${checkedSet.size}/${activeReviews.length})` : '선택'}
          </label>
          {someChecked && (
            <button className="btn-delete-reviews" onClick={deleteSelected}>
              선택 삭제 ({checkedSet.size})
            </button>
          )}
          <span className="count-badge" style={{ marginLeft: 'auto' }}>
            {activeReviews.length}개
          </span>
        </div>

        {/* 리뷰 목록 */}
        <div className="review-list">
          {activeReviews.map((r, i) => (
            <div
              key={r.reviewId ?? i}
              className={`review-card${checkedSet.has(i) ? ' checked' : ''}`}
              onClick={() => toggleCheck(i)}
            >
              <input
                type="checkbox"
                className="review-checkbox"
                checked={checkedSet.has(i)}
                onChange={() => toggleCheck(i)}
                onClick={(e) => e.stopPropagation()}
              />
              <div className="review-card-body">
                <div className="review-tags" />
                <p className="review-text">{r.content}</p>
                {r.date && <span className="review-date">{r.date}</span>}
              </div>
            </div>
          ))}
        </div>

        {/* AI 분석 바 */}
        <div className="analyze-bar">
          {/* 분석 버튼 */}
          <button className="btn-teal" onClick={onAnalyze} disabled={!canAnalyze} style={{ flexShrink: 0 }}>
            {isAnalyzing ? (
              <>
                <span className="spinner" /> 분석 중…
              </>
            ) : (
              'AI 분석'
            )}
          </button>

          {/* 제공사 — 연결된 것이 여러 개면 드롭다운, 하나면 텍스트 배지 */}
          {connectedProviders.length > 1 ? (
            <select
              value={isConnected ? providerId : ''}
              onChange={(e) => select(e.target.value, null)}
              className="field-select"
              style={{ flexShrink: 0, width: 'auto', minWidth: 140 }}
            >
              {connectedProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  ● {p.label}
                </option>
              ))}
            </select>
          ) : connectedProviders.length === 1 ? (
            <span
              style={{
                flexShrink: 0,
                padding: '0 10px',
                height: 32,
                display: 'inline-flex',
                alignItems: 'center',
                borderRadius: 'var(--r-sm)',
                background: 'var(--blue-dim)',
                color: 'var(--blue)',
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              {currentProvider?.label ?? providerId}
            </span>
          ) : (
            <span style={{ color: 'var(--muted)', fontSize: 13, flexShrink: 0 }}>
              설정에서 API 키 또는 구독 인증을 연결하세요
            </span>
          )}

          {/* 모델 드롭다운 */}
          {isConnected && (
            <select
              value={modelId ?? ''}
              onChange={(e) => select(providerId, e.target.value || null)}
              className="field-select"
              style={{ flex: 1, minWidth: 0 }}
            >
              <option value="">{modelsLoading ? '로드 중…' : sortedModels.length ? '모델 선택' : '모델 없음'}</option>
              {sortedModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {modelOptionLabel(m)}
                </option>
              ))}
            </select>
          )}

          {/* 모델 새로고침 */}
          {isConnected && (
            <button
              className="btn-icon"
              onClick={() => void refreshModels(providerId, true)}
              disabled={modelsLoading}
              title="모델 목록 새로고침"
              style={{ flexShrink: 0, opacity: modelsLoading ? 0.5 : 1 }}
            >
              <RefreshIcon spin={modelsLoading} />
            </button>
          )}

          {/* 설정 */}
          <button className="btn-icon" onClick={onOpenSettings} title="AI 설정" style={{ flexShrink: 0 }}>
            <SettingsIcon />
          </button>

          {/* 최근 분석 결과 다시 보기 */}
          {hasResult && (
            <button
              className="btn-ghost"
              style={{ flexShrink: 0, height: 32, fontSize: 12, padding: '0 10px' }}
              onClick={onOpenAnalyses}
              title="분석 결과 보기"
            >
              결과 보기
            </button>
          )}

          {/* 저장된 분석 기록 */}
          {analysesCount > 0 && (
            <button
              className="btn-ghost"
              style={{ flexShrink: 0, height: 32, fontSize: 12, padding: '0 10px' }}
              onClick={onOpenAnalyses}
              title="저장된 분석 기록"
            >
              기록 {analysesCount}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RefreshIcon({ spin }: { spin: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={spin ? { animation: 'spin 0.7s linear infinite' } : {}}
    >
      <path d="M23 4v6h-6" />
      <path d="M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
      <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
