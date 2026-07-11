import React, { useState, useRef, useEffect } from 'react';
import { exportToExcel, exportToJSON, exportToMarkdown } from '../lib/exportUtils';
import type { Apartment, ReviewsByApt } from '../types';

const COUNT_OPTIONS = [50, 100, 150, 200, 300, 500, 0];

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="loading-row">
          <div className="skel" style={{ width: 16, height: 16, borderRadius: 4 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div className="skel" style={{ height: 13, width: `${55 + (i % 3) * 15}%` }} />
            <div className="skel" style={{ height: 10, width: `${30 + (i % 4) * 10}%` }} />
          </div>
        </div>
      ))}
    </>
  );
}

interface AptListViewProps {
  apts: Apartment[];
  isLoading: boolean;
  error: string | null;
  selected: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  reviewCount: number;
  onReviewCountChange: (v: number) => void;
  onFetchReviews: () => void;
  isFetching: boolean;
  fetchedAptIds: Set<string>;
  onAptBadgeClick: (id: string) => void;
  reviewsByApt: ReviewsByApt;
}

export default function AptListView({
  apts,
  isLoading,
  error,
  selected,
  onSelectionChange,
  reviewCount,
  onReviewCountChange,
  onFetchReviews,
  isFetching,
  fetchedAptIds,
  onAptBadgeClick,
  reviewsByApt,
}: AptListViewProps) {
  const [open, setOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  const allSelected = apts.length > 0 && apts.every((a) => selected.has(a.id));
  const someSelected = selected.size > 0;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!exportOpen) return;
    const handler = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [exportOpen]);

  const hasReviews = reviewsByApt && Object.keys(reviewsByApt).length > 0;

  const handleExport = (type: 'excel' | 'json' | 'md') => {
    setExportOpen(false);
    if (!reviewsByApt) return;
    if (type === 'excel') exportToExcel(reviewsByApt);
    else if (type === 'json') exportToJSON(reviewsByApt);
    else if (type === 'md') exportToMarkdown(reviewsByApt);
  };

  const toggleAll = () => {
    if (allSelected) onSelectionChange(new Set());
    else onSelectionChange(new Set(apts.map((a) => a.id)));
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  };

  const triggerLabel = isLoading
    ? '단지 조회 중…'
    : someSelected
      ? `${selected.size}개 선택됨`
      : apts.length > 0
        ? '단지 선택'
        : '단지를 조회하세요';

  return (
    <div className="apt-controls-bar">
      {/* 드롭다운 */}
      <div className="apt-dropdown-wrap" ref={dropRef}>
        <button
          className={`apt-dropdown-trigger${open ? ' open' : ''}`}
          onClick={() => (apts.length > 0 || isLoading) && setOpen((v) => !v)}
          disabled={apts.length === 0 && !isLoading}
        >
          <span className="apt-trigger-label">{triggerLabel}</span>
          {apts.length > 0 && (
            <span className="count-badge" style={{ marginLeft: 6 }}>
              {apts.length}
            </span>
          )}
          <span className="apt-trigger-caret">▾</span>
        </button>

        {open && (
          <div className="apt-dropdown-panel">
            {error && <div className="error-bar">{error}</div>}
            {isLoading ? (
              <div className="apt-grid">
                <SkeletonRows />
              </div>
            ) : (
              <>
                <label className="apt-select-all">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                  전체 선택 {someSelected && `(${selected.size}/${apts.length})`}
                </label>
                <div className="apt-grid">
                  {apts.map((apt) => {
                    const isDone = fetchedAptIds?.has(apt.id);
                    return (
                      <div
                        key={apt.id}
                        className={`apt-row${selected.has(apt.id) ? ' selected' : ''}`}
                        onClick={() => toggle(apt.id)}
                        style={{ cursor: 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          className="apt-checkbox"
                          checked={selected.has(apt.id)}
                          onChange={() => toggle(apt.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="apt-info">
                          <div className="apt-name">{apt.name}</div>
                          {apt.dong && <div className="apt-name-sub">{apt.dong}</div>}
                        </div>
                        {isDone && (
                          <button
                            className="apt-done-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              onAptBadgeClick(apt.id);
                              setOpen(false);
                            }}
                          >
                            리뷰 ✓
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 리뷰 수 버튼 */}
      <div className="review-count-group">
        {COUNT_OPTIONS.map((v) => (
          <button
            key={v}
            className={`review-count-btn${reviewCount === v ? ' active' : ''}`}
            onClick={() => onReviewCountChange(v)}
          >
            {v === 0 ? '전체' : String(v)}
          </button>
        ))}
      </div>

      {/* 수집 버튼 + 내보내기 */}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexShrink: 0 }}>
        <button className="btn-teal" onClick={onFetchReviews} disabled={!someSelected || isFetching}>
          {isFetching ? (
            <>
              <span className="spinner" /> 수집 중…
            </>
          ) : (
            `리뷰 수집 (${selected.size})`
          )}
        </button>

        {hasReviews && (
          <div className="export-wrap" ref={exportRef}>
            <button className="btn-ghost export-btn" onClick={() => setExportOpen((v) => !v)}>
              내보내기 <span className="export-caret">▾</span>
            </button>
            {exportOpen && (
              <div className="export-dropdown" style={{ right: 0, left: 'auto' }}>
                <button className="export-option" onClick={() => handleExport('excel')}>
                  <span className="export-icon">📊</span> Excel (.xlsx)
                </button>
                <button className="export-option" onClick={() => handleExport('json')}>
                  <span className="export-icon">📋</span> JSON (.json)
                </button>
                <button className="export-option" onClick={() => handleExport('md')}>
                  <span className="export-icon">📄</span> Markdown (.md)
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
