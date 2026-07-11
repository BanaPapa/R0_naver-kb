import React, { useState, useEffect } from 'react';
import AnalysisView from './AnalysisView';
import type { AnalysisResult, AnalysisMeta, SavedAnalysis } from '../types';

interface AnalysisModalProps {
  open: boolean;
  onClose: () => void;
  current: { result: AnalysisResult; meta: AnalysisMeta | null } | null;
  currentSaved: boolean;
  history: SavedAnalysis[];
  onSaveCurrent: () => void;
  onDeleteItem: (id: string) => void;
  onClearHistory: () => void;
}

// 분석 결과 모달. 현재 분석 결과 + 저장된 분석 관리(히스토리).
export default function AnalysisModal({
  open,
  onClose,
  current,
  currentSaved,
  history,
  onSaveCurrent,
  onDeleteItem,
  onClearHistory,
}: AnalysisModalProps) {
  const [tab, setTab] = useState<'current' | 'history'>('current');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 모달이 열릴 때, 현재 결과가 있으면 현재 탭, 없으면 히스토리
  useEffect(() => {
    if (open) {
      setTab(current ? 'current' : 'history');
      setSelectedId(null);
    }
  }, [open, current]);

  // ESC 닫기
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  const selected = history.find((h) => h.id === selectedId);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        {/* 헤더 */}
        <div className="modal-head">
          <div className="modal-tabs">
            <button
              className={`modal-tab${tab === 'current' ? ' active' : ''}`}
              onClick={() => {
                setTab('current');
                setSelectedId(null);
              }}
              disabled={!current}
            >
              현재 분석
            </button>
            <button className={`modal-tab${tab === 'history' ? ' active' : ''}`} onClick={() => setTab('history')}>
              저장된 분석 {history.length > 0 && <span className="tab-badge">{history.length}</span>}
            </button>
          </div>
          <button className="modal-close" onClick={onClose} title="닫기 (Esc)">
            ✕
          </button>
        </div>

        {/* 본문 */}
        <div className="modal-body">
          {tab === 'current' && current && (
            <>
              <div className="modal-actions">
                {currentSaved ? (
                  <span className="status-ok" style={{ fontSize: 14 }}>
                    ✓ 저장됨
                  </span>
                ) : (
                  <button
                    className="btn-primary"
                    style={{ height: 34, padding: '0 16px', fontSize: 13 }}
                    onClick={onSaveCurrent}
                  >
                    이 분석 저장
                  </button>
                )}
              </div>
              <AnalysisView result={current.result} meta={current.meta} />
            </>
          )}

          {tab === 'history' &&
            !selected &&
            (history.length === 0 ? (
              <div className="modal-empty">저장된 분석이 없습니다.</div>
            ) : (
              <div className="hist-list">
                <div className="hist-list-top">
                  <span className="av-hint">항목을 클릭하면 상세가 열립니다.</span>
                  <button
                    className="btn-ghost"
                    style={{ height: 28, fontSize: 12, color: 'var(--red)' }}
                    onClick={onClearHistory}
                  >
                    전체 삭제
                  </button>
                </div>
                {history.map((item) => (
                  <button key={item.id} className="hist-item" onClick={() => setSelectedId(item.id)}>
                    <span
                      className={`tag ${
                        item.result?.overallSentiment === '긍정'
                          ? 'tag-plus'
                          : item.result?.overallSentiment === '부정'
                            ? 'tag-minus'
                            : 'tag-neutral'
                      }`}
                    >
                      {item.result?.overallSentiment ?? '—'}
                    </span>
                    <span className="hist-item-apt">{item.aptName}</span>
                    <span className="hist-item-sub">
                      {item.result?.totalCount ?? 0}건 · {item.model}
                    </span>
                    <span className="hist-item-date">{formatDate(item.savedAt)}</span>
                    <span
                      className="hist-item-del"
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteItem(item.id);
                      }}
                      title="삭제"
                    >
                      ✕
                    </span>
                  </button>
                ))}
              </div>
            ))}

          {tab === 'history' && selected && (
            <>
              <div className="modal-actions">
                <button className="btn-ghost" style={{ height: 32, fontSize: 13 }} onClick={() => setSelectedId(null)}>
                  ← 목록
                </button>
                <button
                  className="btn-ghost"
                  style={{ height: 32, fontSize: 13, color: 'var(--red)', marginLeft: 'auto' }}
                  onClick={() => {
                    onDeleteItem(selected.id);
                    setSelectedId(null);
                  }}
                >
                  삭제
                </button>
              </div>
              <AnalysisView
                result={selected.result}
                meta={{ aptName: selected.aptName, provider: selected.provider, model: selected.model, savedAt: selected.savedAt }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}
