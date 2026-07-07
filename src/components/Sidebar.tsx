import React from 'react';

export type AppTab = 'naver' | 'kb' | 'kbprice' | 'settings' | 'admin';

type ModStatus = 'live' | 'soon';

// 비활성(개발 중) 모듈에 호버 시 노출되는 안내 문구
const SOON_TIP = '현재 개발중이므로 추가예정입니다';

interface NavModule {
  key: string;
  tab?: AppTab; // 클릭 가능한 모듈만 지정 (없으면 개발 중)
  label: string;
  status: ModStatus;
  icon: React.JSX.Element;
}

// 사이드바 모듈(탭) 정의. 활성: KB 시계열 분석(kb)·KB시세(kbprice)·매물시세(naver), 나머지는 비활성(개발 예정).
const NAV_MODULES: NavModule[] = [
  {
    key: 'kb-timeseries',
    tab: 'kb',
    label: 'KB 시계열 분석',
    status: 'live',
    icon: (
      <svg className="ic" viewBox="0 0 24 24">
        <path d="M3 3v18h18" />
        <path d="M7 15l3-4 3 2 4-7" />
      </svg>
    ),
  },
  {
    key: 'kb-price',
    tab: 'kbprice',
    label: 'KB시세',
    status: 'live',
    icon: (
      <svg className="ic" viewBox="0 0 24 24">
        <path d="M3 21h18" />
        <rect x="5" y="11" width="3" height="7" />
        <rect x="10.5" y="6" width="3" height="12" />
        <rect x="16" y="9" width="3" height="9" />
      </svg>
    ),
  },
  {
    key: 'naver',
    tab: 'naver',
    label: '매물시세',
    status: 'live',
    icon: (
      <svg className="ic" viewBox="0 0 24 24">
        <path d="M3 7h7v14H3z" />
        <path d="M14 3h7v18h-7z" />
        <path d="M6 11h1M6 15h1M17 7h1M17 11h1" />
      </svg>
    ),
  },
  {
    key: 'real-deal',
    label: '실거래가',
    status: 'soon',
    icon: (
      <svg className="ic" viewBox="0 0 24 24">
        <path d="M3 17l5-6 4 3 6-8" />
        <path d="M16 6h3v3" />
      </svg>
    ),
  },
  {
    key: 'subscription',
    label: '지역별 청약현황',
    status: 'soon',
    icon: (
      <svg className="ic" viewBox="0 0 24 24">
        <path d="M14 3v5h5" />
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M9 14l2 2 4-4" />
      </svg>
    ),
  },
  {
    key: 'reviews',
    label: '입주민 리뷰',
    status: 'soon',
    icon: (
      <svg className="ic" viewBox="0 0 24 24">
        <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z" />
      </svg>
    ),
  },
  {
    key: 'brokers',
    label: '중개업소 추출',
    status: 'soon',
    icon: (
      <svg className="ic" viewBox="0 0 24 24">
        <path d="M3 9l1-5h16l1 5" />
        <path d="M5 9v11h14V9" />
        <path d="M9 20v-6h6v6" />
      </svg>
    ),
  },
  {
    key: 'commercial',
    label: '상업시설 특화',
    status: 'soon',
    icon: (
      <svg className="ic" viewBox="0 0 24 24">
        <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
        <path d="M3 6h18" />
        <path d="M16 10a4 4 0 0 1-8 0" />
      </svg>
    ),
  },
  {
    key: 'location',
    label: '입지분석',
    status: 'soon',
    icon: (
      <svg className="ic" viewBox="0 0 24 24">
        <path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z" />
        <circle cx="12" cy="10" r="3" />
      </svg>
    ),
  },
  {
    key: 'school',
    label: '학군상세',
    status: 'soon',
    icon: (
      <svg className="ic" viewBox="0 0 24 24">
        <path d="M22 10L12 5 2 10l10 5 10-5z" />
        <path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5" />
      </svg>
    ),
  },
  {
    key: 'development',
    label: '개발계획',
    status: 'soon',
    icon: (
      <svg className="ic" viewBox="0 0 24 24">
        <path d="M3 21h18" />
        <path d="M6 21V4h12v17" />
        <path d="M9 9h6M9 13h6" />
      </svg>
    ),
  },
];

interface SidebarProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  userEmail?: string | null;
  onSignOut?: () => void; // 지정 시(=Supabase 로그인 상태) 로그아웃 버튼 노출
  isAdmin?: boolean;      // 관리자면 '회원 승인' 메뉴 노출
  onOpenInquiry?: () => void;
  inquiryUnread?: number;
  adminInboxUnread?: number;
}

export function Sidebar({ activeTab, onTabChange, collapsed, onToggleCollapse, userEmail, onSignOut, isAdmin, onOpenInquiry, inquiryUnread = 0, adminInboxUnread = 0 }: SidebarProps) {
  return (
    <aside className="eos-side">
      <button className="eos-side-toggle" title="사이드바 접기" onClick={onToggleCollapse}>
        <svg viewBox="0 0 24 24">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>

      <div className="eos-brand">
        <div className="eos-brand-mark" />
        <div className="eos-brand-tx">
          <b>Estate&nbsp;OS</b>
          <span>Analytics</span>
        </div>
      </div>

      <nav className="eos-nav">
        <div className="eos-nav-sec">Workspace</div>
        {NAV_MODULES.map((m) => {
          const clickable = !!m.tab;
          const active = clickable && activeTab === m.tab;
          // 비활성 모듈은 disabled 속성을 쓰지 않는다(브라우저가 disabled 요소엔 hover/tooltip을
          // 막아버림). 대신 'disabled' 클래스 + aria-disabled 로 비활성 표현하고 커스텀 툴팁을 노출.
          return (
            <button
              key={m.key}
              className={`eos-nav-item${active ? ' active' : ''}${clickable ? '' : ' disabled'}`}
              aria-disabled={!clickable}
              title={clickable ? m.label : SOON_TIP}
              onClick={clickable ? () => onTabChange(m.tab!) : undefined}
            >
              {m.icon}
              <span className="eos-nav-label">{m.label}</span>
              <span className={`eos-dot${m.status === 'live' ? ' live' : ''}`} />
            </button>
          );
        })}

        <div className="eos-nav-sec">시스템</div>
        {isAdmin && (
          <button
            className={`eos-nav-item${activeTab === 'admin' ? ' active' : ''}`}
            title="회원 승인"
            onClick={() => onTabChange('admin')}
          >
            <svg className="ic" viewBox="0 0 24 24">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M19 8v6M22 11h-6" />
            </svg>
            <span className="eos-nav-label">회원 승인</span>
            {adminInboxUnread > 0 && <span className="eos-nav-badge">{adminInboxUnread}</span>}
            <span className="eos-dot live" />
          </button>
        )}
        <button
          className={`eos-nav-item${activeTab === 'settings' ? ' active' : ''}`}
          title="인증 설정"
          onClick={() => onTabChange('settings')}
        >
          <svg className="ic" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span className="eos-nav-label">설정</span>
        </button>
      </nav>

      {onOpenInquiry && (
        <button className="eos-nav-item eos-inquiry-btn" title="관리자에게 문의하기" onClick={onOpenInquiry}>
          <svg className="ic" viewBox="0 0 24 24">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span className="eos-nav-label">관리자에게 문의하기</span>
          {inquiryUnread > 0 && <span className="eos-nav-badge">{inquiryUnread}</span>}
        </button>
      )}

      <div className="eos-acct">
        <div className="eos-acct-av">{userEmail ? userEmail[0].toUpperCase() : 'NV'}</div>
        <div className="eos-acct-tx">
          <b>{userEmail ? userEmail.split('@')[0] : '부동산 애널리스트'}</b>
          <span>{userEmail ?? '데이터 데스크 · Pro'}</span>
        </div>
        {onSignOut && (
          <button className="eos-acct-logout" title="로그아웃" onClick={onSignOut}>
            <svg viewBox="0 0 24 24">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>
        )}
      </div>
    </aside>
  );
}
