import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  listProfiles,
  setProfileStatus,
  updateProfileInfo,
  type Profile,
  type ProfileStatus,
} from '../../services/profilesRepo';
import { MemberDetailModal } from './MemberDetailModal';

const STATUS_LABEL: Record<ProfileStatus, string> = {
  pending: '대기',
  approved: '승인됨',
  rejected: '거절됨',
};

// 마지막 로그인 시각 표시. 한 번도 접속 안 했으면 null.
function formatLastSeen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString('ko-KR', { year: '2-digit', month: 'numeric', day: 'numeric' });
  const time = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} ${time}`;
}

interface MemberApprovalProps {
  unreadUserIds: Set<string>;
  onThreadRead: () => void;
}

// 관리자 전용 회원 승인 페이지. 대기/승인/거절 회원을 한 화면에서 관리.
export function MemberApproval({ unreadUserIds, onThreadRead }: MemberApprovalProps) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailMember, setDetailMember] = useState<Profile | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProfiles(await listProfiles());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const changeStatus = useCallback(
    async (id: string, status: ProfileStatus) => {
      setBusyId(id);
      setProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, status } : p)));
      try {
        await setProfileStatus(id, status);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        await reload();
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const changeInfo = useCallback(
    async (id: string, fields: { name?: string; company?: string; position?: string; phone?: string }) => {
      setProfiles((prev) =>
        prev.map((p) => (p.id === id ? { ...p, ...fields } : p)),
      );
      try {
        await updateProfileInfo(id, fields);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        await reload();
      }
    },
    [reload],
  );

  const pending = profiles.filter((p) => p.status === 'pending');
  const others  = profiles.filter((p) => p.status !== 'pending');

  return (
    <main className="member-admin">
      <div className="member-admin-hd">
        <div>
          <h2 className="member-admin-title">회원 승인 관리</h2>
          <p className="member-admin-sub">
            대기 중인 가입 요청을 승인하거나 거절합니다. 승인된 회원만 앱을 사용할 수 있습니다.
            <br />이름·회사·전화번호 항목을 더블클릭하면 수정할 수 있습니다.
          </p>
        </div>
        <button className="member-reload" onClick={reload} disabled={loading}>
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
      </div>

      {error && <div className="auth-msg err" style={{ marginBottom: 14 }}>{error}</div>}

      <section className="member-section">
        <div className="member-section-hd">
          승인 대기 <span className="member-count">{pending.length}</span>
        </div>
        {pending.length === 0 ? (
          <div className="member-empty">대기 중인 가입 요청이 없습니다.</div>
        ) : (
          <MemberTable rows={pending} busyId={busyId} onStatusChange={changeStatus} onInfoChange={changeInfo} onOpenDetail={setDetailMember} unreadUserIds={unreadUserIds} />
        )}
      </section>

      <section className="member-section">
        <div className="member-section-hd">
          전체 회원 <span className="member-count">{others.length}</span>
        </div>
        {others.length === 0 ? (
          <div className="member-empty">아직 처리된 회원이 없습니다.</div>
        ) : (
          <MemberTable rows={others} busyId={busyId} onStatusChange={changeStatus} onInfoChange={changeInfo} onOpenDetail={setDetailMember} unreadUserIds={unreadUserIds} />
        )}
      </section>

      {detailMember && (
        <MemberDetailModal member={detailMember} onClose={() => setDetailMember(null)} onThreadRead={onThreadRead} />
      )}
    </main>
  );
}

// ── 인라인 편집 셀 ────────────────────────────────────────────────────────────
interface EditableCellProps {
  value: string | null;
  placeholder?: string;
  onSave: (next: string) => void;
}

function EditableCell({ value, placeholder = '—', onSave }: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(value ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setDraft(value ?? '');
    setEditing(true);
  };

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== (value ?? '')) onSave(trimmed);
  };

  const cancel = () => {
    setEditing(false);
    setDraft(value ?? '');
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="member-inline-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') cancel();
        }}
      />
    );
  }

  return (
    <span
      className="member-editable"
      title="더블클릭하여 수정"
      onDoubleClick={(e) => { e.stopPropagation(); startEdit(); }}
    >
      {value || <span className="member-empty-val">{placeholder}</span>}
    </span>
  );
}

// ── 테이블 ────────────────────────────────────────────────────────────────────
interface MemberTableProps {
  rows: Profile[];
  busyId: string | null;
  onStatusChange: (id: string, status: ProfileStatus) => void;
  onInfoChange: (id: string, fields: { name?: string; company?: string; position?: string; phone?: string }) => void;
  onOpenDetail: (member: Profile) => void;
  unreadUserIds: Set<string>;
}

function MemberTable({ rows, busyId, onStatusChange, onInfoChange, onOpenDetail, unreadUserIds }: MemberTableProps) {
  return (
    <div className="member-table member-table-wide">
      <div className="member-row member-row-head">
        <span>이메일</span>
        <span>이름</span>
        <span>회사/소속</span>
        <span>직급</span>
        <span>전화번호</span>
        <span>권한</span>
        <span>상태</span>
        <span>가입일</span>
        <span>마지막 접속</span>
        <span>작업</span>
      </div>
      {rows.map((p) => {
        const busy    = busyId === p.id;
        const isAdmin = p.role === 'admin';
        return (
          <div className="member-row" key={p.id} onDoubleClick={() => onOpenDetail(p)}>
            <span className="member-email">
              {unreadUserIds.has(p.id) && <span className="member-unread-dot" title="새 문의" />}
              {p.email ?? '(이메일 없음)'}
            </span>

            <span>
              <EditableCell
                value={p.name}
                placeholder="이름 없음"
                onSave={(v) => onInfoChange(p.id, { name: v })}
              />
            </span>

            <span>
              <EditableCell
                value={p.company}
                placeholder="소속 없음"
                onSave={(v) => onInfoChange(p.id, { company: v })}
              />
            </span>

            <span>
              <EditableCell
                value={p.position}
                placeholder="직급 없음"
                onSave={(v) => onInfoChange(p.id, { position: v })}
              />
            </span>

            <span>
              <EditableCell
                value={p.phone}
                placeholder="번호 없음"
                onSave={(v) => onInfoChange(p.id, { phone: v })}
              />
            </span>

            <span>
              <span className={`member-role${isAdmin ? ' admin' : ''}`}>{isAdmin ? '관리자' : '사용자'}</span>
            </span>

            <span className="member-status-cell">
              <span className={`member-badge ${p.status}`}>{STATUS_LABEL[p.status]}</span>
              {!isAdmin && p.emailConfirmedAt === null && (
                <span className="member-unconfirmed" title="가입확인 메일 링크를 아직 클릭하지 않아 로그인할 수 없습니다.">
                  메일 미인증
                </span>
              )}
            </span>

            <span className="member-date">{new Date(p.createdAt).toLocaleDateString('ko-KR')}</span>

            <span className={`member-lastseen${p.lastSignInAt ? '' : ' never'}`}>
              {p.lastSignInAt ? formatLastSeen(p.lastSignInAt) : '미접속'}
            </span>

            <span className="member-actions">
              <button className="member-btn detail" onClick={() => onOpenDetail(p)} title="상세 보기">상세</button>
              {isAdmin ? (
                <span className="member-self">—</span>
              ) : (
                <>
                  {p.status !== 'approved' && (
                    <button className="member-btn approve" disabled={busy} onClick={() => onStatusChange(p.id, 'approved')}>
                      승인
                    </button>
                  )}
                  {p.status !== 'rejected' && (
                    <button className="member-btn reject" disabled={busy} onClick={() => onStatusChange(p.id, 'rejected')}>
                      거절
                    </button>
                  )}
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
