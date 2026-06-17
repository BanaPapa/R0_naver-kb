import React, { useState, useEffect, useCallback } from 'react';
import { listProfiles, setProfileStatus, type Profile, type ProfileStatus } from '../../services/profilesRepo';

const STATUS_LABEL: Record<ProfileStatus, string> = {
  pending: '대기',
  approved: '승인됨',
  rejected: '거절됨',
};

// 관리자 전용 회원 승인 페이지. 대기/승인/거절 회원을 한 화면에서 관리.
export function MemberApproval() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  useEffect(() => {
    reload();
  }, [reload]);

  const changeStatus = useCallback(
    async (id: string, status: ProfileStatus) => {
      setBusyId(id);
      // 낙관적 반영
      setProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, status } : p)));
      try {
        await setProfileStatus(id, status);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        await reload(); // 실패 시 서버 상태로 복구
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const pending = profiles.filter((p) => p.status === 'pending');
  const others = profiles.filter((p) => p.status !== 'pending');

  return (
    <main className="member-admin">
      <div className="member-admin-hd">
        <div>
          <h2 className="member-admin-title">회원 승인 관리</h2>
          <p className="member-admin-sub">
            대기 중인 가입 요청을 승인하거나 거절합니다. 승인된 회원만 앱을 사용할 수 있습니다.
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
          <MemberTable rows={pending} busyId={busyId} onChange={changeStatus} showApprove showReject />
        )}
      </section>

      <section className="member-section">
        <div className="member-section-hd">
          전체 회원 <span className="member-count">{others.length}</span>
        </div>
        {others.length === 0 ? (
          <div className="member-empty">아직 처리된 회원이 없습니다.</div>
        ) : (
          <MemberTable rows={others} busyId={busyId} onChange={changeStatus} showApprove showReject />
        )}
      </section>
    </main>
  );
}

interface MemberTableProps {
  rows: Profile[];
  busyId: string | null;
  onChange: (id: string, status: ProfileStatus) => void;
  showApprove: boolean;
  showReject: boolean;
}

function MemberTable({ rows, busyId, onChange, showApprove, showReject }: MemberTableProps) {
  return (
    <div className="member-table">
      <div className="member-row member-row-head">
        <span>이메일</span>
        <span>권한</span>
        <span>상태</span>
        <span>가입일</span>
        <span>작업</span>
      </div>
      {rows.map((p) => {
        const busy = busyId === p.id;
        const isAdmin = p.role === 'admin';
        return (
          <div className="member-row" key={p.id}>
            <span className="member-email">{p.email ?? '(이메일 없음)'}</span>
            <span>
              <span className={`member-role${isAdmin ? ' admin' : ''}`}>{isAdmin ? '관리자' : '사용자'}</span>
            </span>
            <span>
              <span className={`member-badge ${p.status}`}>{STATUS_LABEL[p.status]}</span>
            </span>
            <span className="member-date">{new Date(p.createdAt).toLocaleDateString('ko-KR')}</span>
            <span className="member-actions">
              {isAdmin ? (
                <span className="member-self">—</span>
              ) : (
                <>
                  {showApprove && p.status !== 'approved' && (
                    <button className="member-btn approve" disabled={busy} onClick={() => onChange(p.id, 'approved')}>
                      승인
                    </button>
                  )}
                  {showReject && p.status !== 'rejected' && (
                    <button className="member-btn reject" disabled={busy} onClick={() => onChange(p.id, 'rejected')}>
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
