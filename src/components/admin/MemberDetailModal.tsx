import React, { useEffect, useState } from 'react';
import { listSearchLogs, type SearchLog } from '../../services/searchLogsRepo';
import { listThread, sendAdminReply, markThreadReadByAdmin, type InquiryMessage } from '../../services/inquiriesRepo';
import type { Profile } from '../../services/profilesRepo';
import { REAL_ESTATE_TYPES, TRADE_TYPE_LABELS } from '../../types';

interface MemberDetailModalProps {
  member: Profile;
  onClose: () => void;
  onThreadRead?: () => void;
}

type DetailTab = 'search' | 'inquiry';

function productLabel(code: string | null): string {
  if (!code) return '';
  return REAL_ESTATE_TYPES.find((t) => t.value === code)?.label ?? code;
}

const APP_LABELS: Record<SearchLog['app'], string> = {
  naver: '매물시세',
  kbprice: 'KB시세',
  apply: '청약현황',
  kb: 'KB분석',
};

// 검색내용 한 줄. summary(타 탭)가 있으면 그대로, 없으면(네이버) 지역·상품·거래·면적으로 조립.
function searchContent(l: SearchLog): string {
  if (l.summary) return l.summary;
  const region = [l.largeName, l.midName, l.smallName].filter(Boolean).join(' ');
  const parts = [
    region,
    productLabel(l.realEstateType),
    l.tradeType ? (TRADE_TYPE_LABELS[l.tradeType] ?? l.tradeType) : '',
    l.areaLabel ?? '',
  ].filter(Boolean);
  return parts.join(' · ') || '—';
}

function statusLabel(s: SearchLog['status']): string {
  switch (s) {
    case 'done': return '완료';
    case 'error': return '실패';
    case 'stopped': return '중지';
    case 'running': return '진행중';
  }
}

export function MemberDetailModal({ member, onClose, onThreadRead }: MemberDetailModalProps) {
  const [tab, setTab] = useState<DetailTab>('search');
  const [logs, setLogs] = useState<SearchLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [thread, setThread] = useState<InquiryMessage[]>([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    listSearchLogs(member.id)
      .then((rows) => { if (alive) setLogs(rows); })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [member.id]);

  useEffect(() => {
    if (tab !== 'inquiry') return;
    let alive = true;
    listThread(member.id)
      .then((rows) => { if (alive) setThread(rows); })
      .catch((err) => console.warn('문의 스레드 로드 실패:', err));
    markThreadReadByAdmin(member.id).then(() => onThreadRead?.());
    return () => { alive = false; };
  }, [tab, member.id, onThreadRead]);

  const sendReply = async () => {
    const body = reply.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await sendAdminReply(member.id, body);
      setReply('');
      setThread(await listThread(member.id));
    } catch (err) {
      console.warn('답변 전송 실패:', err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card member-detail" onClick={(e) => e.stopPropagation()}>
        <button className="cm-close" onClick={onClose} title="닫기">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>

        <h3 className="md-title">{member.name || member.email || '회원'} 상세</h3>
        <p className="md-sub">{member.email}</p>

        <div className="md-tabs">
          <button className={`md-tab${tab === 'search' ? ' active' : ''}`} onClick={() => setTab('search')}>
            검색내역
          </button>
          <button className={`md-tab${tab === 'inquiry' ? ' active' : ''}`} onClick={() => setTab('inquiry')}>
            문의
          </button>
        </div>

        {tab === 'search' && (
          <div className="md-search">
            {loading ? (
              <div className="md-empty">불러오는 중…</div>
            ) : error ? (
              <div className="auth-msg err">{error}</div>
            ) : logs.length === 0 ? (
              <div className="md-empty">최근 6개월 검색내역이 없습니다.</div>
            ) : (
              <div className="md-log-table">
                <div className="md-log-row md-log-head">
                  <span>시각</span><span>탭</span><span>검색내용</span><span>결과</span><span>상태</span>
                </div>
                {logs.map((l) => (
                  <div className="md-log-row" key={l.id}>
                    <span className="md-log-time">{new Date(l.createdAt).toLocaleString('ko-KR', { hour12: false })}</span>
                    <span className={`md-log-app ${l.app}`}>{APP_LABELS[l.app] ?? l.app}</span>
                    <span className="md-log-content" title={searchContent(l)}>{searchContent(l)}</span>
                    <span>{l.resultCount != null ? `${l.resultCount.toLocaleString()}건` : '—'}</span>
                    <span className={`md-log-status ${l.status}`}>{statusLabel(l.status)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'inquiry' && (
          <div className="md-inquiry">
            <div className="iq-thread">
              {thread.length === 0 ? (
                <div className="iq-empty">문의 내역이 없습니다.</div>
              ) : (
                thread.map((m) => (
                  <div key={m.id} className={`iq-msg ${m.senderRole}`}>
                    <div className="iq-bubble">{m.body}</div>
                    {m.context && (
                      <div className="iq-meta">오류정보: {JSON.stringify(m.context)}</div>
                    )}
                    <div className="iq-meta">
                      {m.senderRole === 'admin' ? '관리자' : member.name || '사용자'} · {new Date(m.createdAt).toLocaleString('ko-KR', { hour12: false })}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="iq-input">
              <textarea
                value={reply}
                maxLength={2000}
                placeholder="답변을 입력하세요…"
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendReply(); }}
              />
              <button className="eos-run-btn iq-send" disabled={sending || !reply.trim()} onClick={sendReply}>
                {sending ? '전송 중…' : '답변'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
