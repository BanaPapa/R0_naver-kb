import { useState } from 'react';
import { X } from 'lucide-react';

export type ExportFormat = 'excel' | 'json' | 'md';
export type ExportScope = 'all' | 'current';

export interface ExportOptions {
  format: ExportFormat;
  scope: ExportScope;
}

interface ExportConfirmModalProps {
  format: ExportFormat;
  currentCount: number;   // 현재 페이지 건수
  totalCount: number;     // 전체 건수
  onConfirm: (opts: ExportOptions) => void;
  onClose: () => void;
}

const FORMAT_LABELS: Record<ExportFormat, string> = {
  excel: 'Excel (.xlsx)',
  json: 'JSON (.json)',
  md: 'Markdown (.md)',
};

export function ExportConfirmModal({ format, currentCount, totalCount, onConfirm, onClose }: ExportConfirmModalProps) {
  const [scope, setScope] = useState<ExportScope>(totalCount > currentCount ? 'all' : 'current');

  const exportCount = scope === 'all' ? totalCount : currentCount;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card export-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <button className="cm-close" onClick={onClose} title="닫기"><X /></button>

        <h2 className="export-title">내보내기 설정</h2>
        <p className="export-format-label">{FORMAT_LABELS[format]}</p>

        <div className="export-opt-section">
          <span className="export-opt-label">수집 범위</span>
          <div className="export-opt-row">
            <label className={`export-opt-btn${scope === 'all' ? ' active' : ''}`}>
              <input type="radio" name="scope" value="all" checked={scope === 'all'} onChange={() => setScope('all')} />
              전체 결과 수집 <span className="export-opt-count">({totalCount.toLocaleString()}건)</span>
            </label>
            <label className={`export-opt-btn${scope === 'current' ? ' active' : ''}`}>
              <input type="radio" name="scope" value="current" checked={scope === 'current'} onChange={() => setScope('current')} />
              현재 페이지만 <span className="export-opt-count">({currentCount.toLocaleString()}건)</span>
            </label>
          </div>
          {scope === 'all' && totalCount > 50 && (
            <p className="export-opt-note">건수가 많으면 수집에 시간이 걸릴 수 있습니다.</p>
          )}
        </div>

        <div className="export-footer">
          <span className="export-summary">총 <b>{exportCount.toLocaleString()}</b>건 내보내기</span>
          <button className="btn-outline btn-sm" onClick={onClose}>취소</button>
          <button className="btn-primary btn-sm" onClick={() => onConfirm({ format, scope })}>
            내보내기
          </button>
        </div>
      </div>
    </div>
  );
}
