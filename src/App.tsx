import React, { useEffect, useState } from 'react';
import { Sidebar, AppTab } from './components/Sidebar';
import { startUserDataSync } from './kb/features/user-data-sync';
import { NaverCrawlerTab } from './components/NaverCrawlerTab';
import { SettingsPage } from './components/SettingsPage';
import { LoginScreen } from './components/auth/LoginScreen';
import { ResetPasswordScreen } from './components/auth/ResetPasswordScreen';
import { PendingApprovalScreen } from './components/auth/PendingApprovalScreen';
import { MemberApproval } from './components/admin/MemberApproval';
import { useCrawler } from './hooks/useCrawler';
import { useSlots } from './hooks/useSlots';
import { useSettings } from './hooks/useSettings';
import { useAuth } from './hooks/useAuth';
import { useAgentStatus } from './hooks/useAgentStatus';
import { useInquiries } from './hooks/useInquiries';
import { InquiryModal } from './components/inquiry/InquiryModal';
import { useAdminInbox } from './hooks/useAdminInbox';
import KbModule from './kb/KbModule';
import { KbPriceTab } from './kbprice/KbPriceTab';
import { AdminUiProvider } from './components/admin-ui';

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('naver');
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const auth = useAuth();

  // KB 저장 데이터(분석·슬롯) ↔ 로그인 계정 동기화 시작 (1회)
  useEffect(() => {
    startUserDataSync();
  }, []);
  const agentStatus = useAgentStatus();
  const crawler = useCrawler();
  const slots = useSlots(auth.user?.id ?? null);
  const { settings, update, setAccent } = useSettings();
  const { status, properties } = crawler.state;
  const inquiries = useInquiries(auth.session);
  const [inquiryOpen, setInquiryOpen] = useState(false);
  const [inquiryPrefill, setInquiryPrefill] = useState<Record<string, unknown> | null>(null);

  const isSettings = activeTab === 'settings';
  const isAdminTab = activeTab === 'admin';
  const isKb = activeTab === 'kb';
  const isKbPrice = activeTab === 'kbprice';
  const isAdmin = auth.profile?.role === 'admin' && auth.profile?.status === 'approved';
  const adminInbox = useAdminInbox(isAdmin);

  // KB 시계열 분석 모듈은 첫 진입 후부터 마운트 유지(상태 보존). 진입 전에는
  // KB 데이터/차트를 미리 로드하지 않도록 지연 마운트한다.
  const [kbSeen, setKbSeen] = useState(false);
  if (isKb && !kbSeen) setKbSeen(true);

  // KB시세 탭도 동일하게 지연 마운트 + 마운트 유지(검색 결과·필터 상태 보존)
  const [kbPriceSeen, setKbPriceSeen] = useState(false);
  if (isKbPrice && !kbPriceSeen) setKbPriceSeen(true);

  // Supabase가 설정된 경우에만 로그인/승인 게이트 적용. 미설정이면 기존처럼 바로 사용.
  // 비밀번호 재설정 링크로 진입 → 다른 모든 게이트보다 우선해 새 비밀번호 화면 표시.
  if (auth.configured && auth.recovery) {
    return <ResetPasswordScreen onSubmit={auth.updatePassword} onCancel={auth.cancelRecovery} />;
  }
  if (auth.configured && auth.loading) {
    return <div className="auth-screen"><div className="auth-loading">불러오는 중…</div></div>;
  }
  if (auth.configured && !auth.user) {
    return <LoginScreen onSignIn={auth.signIn} onSignUp={auth.signUp} onForgotPassword={auth.requestPasswordReset} />;
  }
  // 로그인됐지만 프로필(승인 상태) 조회 중
  if (auth.configured && auth.user && auth.profileLoading) {
    return <div className="auth-screen"><div className="auth-loading">불러오는 중…</div></div>;
  }
  // 로그인됐지만 아직 승인 전(또는 거절) → 게이트 화면. 프로필 미생성(null)도 대기로 취급.
  if (auth.configured && auth.user && auth.profile?.status !== 'approved') {
    return (
      <PendingApprovalScreen
        email={auth.user.email ?? null}
        status={auth.profile?.status === 'rejected' ? 'rejected' : 'pending'}
        onRefresh={auth.reloadProfile}
        onSignOut={auth.signOut}
      />
    );
  }

  const wsState =
    status === 'running' ? 'run' : status === 'idle' ? 'off' : '';
  const statusText =
    status === 'running'
      ? '데이터 수집 중'
      : status === 'done'
        ? `${properties.length.toLocaleString()}건 수집됨`
        : status === 'stopped'
          ? '수집 중지됨'
          : status === 'error'
            ? '오류 발생'
            : '매물 검색 · 대기 중';

  const openInquiry = (prefill?: Record<string, unknown> | null) => {
    setInquiryPrefill(prefill ?? null);
    setInquiryOpen(true);
    inquiries.markRead();
  };

  return (
    <AdminUiProvider isAdmin={isAdmin}>
    <div className={`eos-app${sideCollapsed ? ' side-collapsed' : ''}`}>
      <Sidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        collapsed={sideCollapsed}
        onToggleCollapse={() => setSideCollapsed((v) => !v)}
        userEmail={auth.user?.email ?? null}
        onSignOut={auth.configured ? auth.signOut : undefined}
        isAdmin={isAdmin}
        onOpenInquiry={auth.configured && !isAdmin ? () => openInquiry() : undefined}
        inquiryUnread={inquiries.unread}
        adminInboxUnread={adminInbox.unreadCount}
      />

      <div className="eos-main">
        {/* KB 탭은 자체 헤더(KbModule 내부)를 렌더하므로 호스트 헤더는 숨긴다. */}
        {!isKb && (
        <header className="eos-hdr">
          <div className="eos-crumb">
            <svg className="home" viewBox="0 0 24 24">
              <path d="M3 11l9-7 9 7" />
              <path d="M5 10v10h14V10" />
            </svg>
            <svg className="sep" viewBox="0 0 24 24">
              <path d="M9 6l6 6-6 6" />
            </svg>
            <span>{isSettings || isAdminTab ? '시스템' : '분석 모듈'}</span>
            <svg className="sep" viewBox="0 0 24 24">
              <path d="M9 6l6 6-6 6" />
            </svg>
            <b>{isAdminTab ? '회원 승인' : isSettings ? '인증 설정' : isKbPrice ? 'KB시세' : '매물시세'}</b>
            {!isSettings && !isAdminTab && !isKbPrice && agentStatus.status === 'running' && (
              agentStatus.connectionValid === false
                ? <span className="tag tag--warn">재연결 필요</span>
                : <span className="tag">LIVE</span>
            )}
          </div>

          {!isSettings && !isAdminTab && !isKbPrice && (
            <div className="eos-hdr-right">
              <div className={`eos-ws ${wsState}`}>
                <span className="wd" />
                <span>{statusText}</span>
              </div>
            </div>
          )}
        </header>
        )}

        {/* 매물시세 탭은 항상 마운트 상태로 두고 다른 탭일 때만 숨긴다.
            (언마운트하면 단위/지역/필터 등 로컬 선택 상태가 초기화되는 문제 방지) */}
        <div style={{ display: isSettings || isAdminTab || isKb || isKbPrice ? 'none' : 'contents' }}>
          <NaverCrawlerTab crawler={crawler} slots={slots} session={auth.session} agentStatus={agentStatus} isAdmin={isAdmin} onRequestInquiry={openInquiry} />
        </div>

        {/* KB 시계열 분석 — 첫 진입 후 마운트 유지, KB 탭일 때만 표시.
            KbModule은 .kb-scope(display:contents) 래퍼로 자체 헤더+작업영역을
            호스트 eos-main 레이아웃에 그대로 흘려보낸다. */}
        {kbSeen && (
          <div style={{ display: isKb ? 'contents' : 'none' }}>
            <KbModule />
          </div>
        )}
        {/* KB시세 조회 — 첫 진입 후 마운트 유지, KB시세 탭일 때만 표시 */}
        {kbPriceSeen && (
          <div style={{ display: isKbPrice ? 'contents' : 'none' }}>
            <KbPriceTab userId={auth.user?.id ?? null} />
          </div>
        )}
        {isAdminTab && isAdmin && (
          <MemberApproval unreadUserIds={adminInbox.unreadUserIds} onThreadRead={adminInbox.reload} />
        )}
        {isSettings && (
          <SettingsPage settings={settings} onUpdate={update} onAccent={setAccent} />
        )}
      </div>

      {inquiryOpen && (
        <InquiryModal
          thread={inquiries.thread}
          prefillContext={inquiryPrefill}
          onSend={inquiries.send}
          onClose={() => setInquiryOpen(false)}
        />
      )}
    </div>
    </AdminUiProvider>
  );
}
