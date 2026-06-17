import React from 'react';
import type { ProfileStatus } from '../../services/profilesRepo';

interface PendingApprovalScreenProps {
  email: string | null;
  status: ProfileStatus; // 'pending' | 'rejected'
  onRefresh: () => void;
  onSignOut: () => void;
}

// 가입은 됐으나 아직 승인 전(또는 거절됨)인 사용자에게 보여주는 게이트 화면.
export function PendingApprovalScreen({ email, status, onRefresh, onSignOut }: PendingApprovalScreenProps) {
  const rejected = status === 'rejected';

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="eos-brand-mark" />
          <div className="auth-brand-tx">
            <b>Estate&nbsp;OS</b>
            <span>매물시세</span>
          </div>
        </div>

        <div className={`pending-icon${rejected ? ' rejected' : ''}`}>
          {rejected ? (
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" />
              <path d="M15 9l-6 6M9 9l6 6" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          )}
        </div>

        <h1 className="auth-title">{rejected ? '가입이 거절되었습니다' : '승인 대기 중'}</h1>
        <p className="auth-sub">
          {rejected
            ? '관리자가 가입 요청을 거절했습니다. 문의가 필요하면 관리자에게 연락하세요.'
            : '관리자 승인 후 이용할 수 있습니다. 승인되면 아래 새로고침을 눌러주세요.'}
        </p>

        {email && <div className="pending-email">{email}</div>}

        {!rejected && (
          <button type="button" className="eos-run-btn auth-submit" onClick={onRefresh}>
            승인 상태 새로고침
          </button>
        )}

        <div className="auth-switch">
          다른 계정으로 진행하시겠어요?
          <button type="button" onClick={onSignOut}>
            로그아웃
          </button>
        </div>
      </div>
    </div>
  );
}
