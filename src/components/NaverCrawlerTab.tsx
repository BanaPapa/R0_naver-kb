import React, { useState, useEffect, useMemo, useRef } from 'react';
import type { Session } from '@supabase/supabase-js';
import { SearchPanel } from './SearchPanel';
import { Monitor } from './Monitor';
import { ResultTable } from './ResultTable';
import { CrawlModal } from './CrawlModal';
import { SlotModal } from './SlotModal';
import { InfoModal } from './InfoModal';
import { useCrawler } from '../hooks/useCrawler';
import { useSlots } from '../hooks/useSlots';
import type { AgentStatusHook } from '../hooks/useAgentStatus';
import { CrawlerConfig, SavedSlot } from '../types';
import { AreaUnit, PriceUnit } from '../services/api';
import { setNaverBases, setNaverCrawlToken } from '../services/naverApi';
import { fetchCrawlToken } from '../services/agentApi';

interface NaverCrawlerTabProps {
  crawler: ReturnType<typeof useCrawler>;
  slots: ReturnType<typeof useSlots>;
  session: Session | null;
  agentStatus: AgentStatusHook;
}

const AGENT_DOWNLOAD_URL =
  'https://github.com/BanaPapa/Estate-OS/releases/latest/download/Estate-OS-Agent-Setup.exe';

export function NaverCrawlerTab({ crawler, slots, session, agentStatus }: NaverCrawlerTabProps) {
  const { state, start, stop, skipDong, reset, clearLogs, load } = crawler;
  const [searchKey, setSearchKey] = useState(0);
  const [areaUnit, setAreaUnit] = useState<AreaUnit>('sqm');
  const [priceUnit, setPriceUnit] = useState<PriceUnit>('thousand');
  const [ctrlCollapsed, setCtrlCollapsed] = useState(false);
  const [crawlModalOpen, setCrawlModalOpen] = useState(false);
  const [slotModalOpen, setSlotModalOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [installDone, setInstallDone] = useState(false);
  const {
    status: agentRunStatus,
    cookieReady,
    connectionValid,
    launching,
    launchFailed,
    loginLoading,
    loginError,
    loginJustSucceeded,
    recheck: recheckAgent,
    launchAndWait,
    triggerLogin,
  } = agentStatus;

  // 로그인 직후 성공 화면 표시 (3.5초)
  const [showLoginSuccess, setShowLoginSuccess] = useState(false);
  const prevLoginSucceeded = useRef(false);
  useEffect(() => {
    if (loginJustSucceeded && !prevLoginSucceeded.current) {
      prevLoginSucceeded.current = true;
      setShowLoginSuccess(true);
      const t = setTimeout(() => setShowLoginSuccess(false), 3500);
      return () => clearTimeout(t);
    }
    if (!loginJustSucceeded) {
      prevLoginSucceeded.current = false;
    }
  }, [loginJustSucceeded]);

  // 에이전트 상태 변경 시 베이스 URL + 크롤 토큰 관리
  useEffect(() => {
    const agentRunning = agentRunStatus === 'running';
    setNaverBases(agentRunning);

    if (agentRunning && session?.access_token) {
      fetchCrawlToken(session.access_token)
        .then((token: string) => setNaverCrawlToken(token))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          setNotice(`크롤 토큰 발급 실패: ${msg}`);
        });
    } else {
      setNaverCrawlToken(null);
    }
  }, [agentRunStatus, session]);

  const handleInstallConsent = () => {
    setInstallDone(true);
    // state 업데이트가 렌더링된 후 다운로드 트리거 (완료 화면이 먼저 표시되도록)
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = AGENT_DOWNLOAD_URL;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { if (a.parentNode) a.parentNode.removeChild(a); }, 200);
    }, 80);
  };

  const handleCloseInstallModal = () => {
    setShowInstallModal(false);
    setInstallDone(false);
  };

  const canSave = state.properties.length > 0 && state.lastConfig !== null;
  const savedCount = slots.slots.filter(Boolean).length;

  // 수집된 매물 기준 고유 단지 수 (수집 진행/완료 모달 표기용)
  const complexCount = useMemo(() => {
    const set = new Set<string>();
    for (const p of state.properties) {
      if (p.complexName) set.add(p.complexName);
    }
    return set.size;
  }, [state.properties]);

  // 첫 빈 슬롯에 저장
  const handleSaveSlot = () => {
    if (!state.lastConfig) return;
    const idx = slots.saveFirstEmpty(state.meta, state.lastConfig, state.properties);
    if (idx === -1) {
      alert('저장 슬롯이 가득 찼습니다 (최대 20개). 기존 슬롯을 삭제한 뒤 다시 시도해 주세요.');
      return;
    }
    setSlotModalOpen(true);
  };

  // 지정 슬롯에 저장/덮어쓰기
  const handleSaveAt = (index: number) => {
    if (!state.lastConfig) return;
    slots.saveAt(index, state.meta, state.lastConfig, state.properties);
  };

  // 슬롯 데이터를 현재 결과로 불러오기
  const handleLoad = (slot: SavedSlot) => {
    load(slot);
    setSlotModalOpen(false);
    setNotice('데이터를 성공적으로 불러왔습니다.');
  };

  // 같은 조건으로 재검색
  const handleReSearch = (slot: SavedSlot) => {
    setSlotModalOpen(false);
    handleStart(slot.config);
  };

  // 오류 발생 시 모달은 닫고 메인 화면에서 오류를 노출
  useEffect(() => {
    if (state.status === 'error') setCrawlModalOpen(false);
  }, [state.status]);

  const handleStart = (config: CrawlerConfig) => {
    setSearchKey((k) => k + 1);
    setCrawlModalOpen(true); // 검색 시작과 동시에 진행률 모달 표시
    start(config);
  };

  const canReset = state.status === 'done' || state.status === 'stopped';
  // 첫 수집 전(idle)에는 결과 영역(헤더 포함)을 대형 안내로 가린다.
  const showEmptyState = state.status === 'idle';

  // 에이전트 미실행 또는 초기 상태(unknown)일 때 안내 화면 표시
  if (agentRunStatus === 'offline' || agentRunStatus === 'unknown') {
    return (
      <div className="eos-state-screen">
        <div className="nv-agent-offline">
          <div className="nv-agent-offline-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <circle cx="12" cy="12" r="9" />
              <path d="M8 12h8M12 8v8" strokeLinecap="round" />
            </svg>
          </div>
          <h2>에이전트가 실행되지 않고 있습니다</h2>
          <p>
            네이버 부동산 매물 검색은 이 PC에서 실행 중인
            <br />
            <b>Estate-OS Agent</b>를 통해서만 동작합니다.
          </p>

          <div className="nv-agent-paths">
            {/* 이미 설치된 경우 */}
            <div className="nv-agent-path-section">
              <div className="nv-agent-path-info">
                <div className="nv-agent-path-label">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={16} height={16}><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                  이미 설치되어 있다면
                </div>
                <p className="nv-agent-path-desc">
                  {launching
                    ? '에이전트를 시작하는 중입니다… (최대 15초)'
                    : launchFailed
                      ? '기존 버전은 자동 실행이 지원되지 않습니다. 직접 실행 후 연결하거나, 최신 버전을 재설치하세요.'
                      : '버튼을 누르면 설치된 에이전트를 자동으로 찾아 실행합니다.'}
                </p>
              </div>
              <div className="nv-agent-path-action">
                {launching ? (
                  <span className="nv-login-spinner nv-spinner-lg" />
                ) : launchFailed ? (
                  <button className="btn-primary" onClick={recheckAgent}>직접 실행 후 연결</button>
                ) : (
                  <button className="btn-primary" onClick={launchAndWait}>에이전트 자동 실행</button>
                )}
              </div>
            </div>

            {/* 처음 설치 / 재설치 */}
            <div className="nv-agent-path-section nv-agent-path-install">
              <div className="nv-agent-path-info">
                <div className="nv-agent-path-label">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={16} height={16}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                  {launchFailed ? '최신 버전 재설치' : '처음 설치하는 경우'}
                </div>
                <p className="nv-agent-path-desc">
                  {launchFailed
                    ? '최신 버전은 자동 실행을 지원합니다. 재설치 후 버튼 한 번으로 연결됩니다.'
                    : <>아래 버튼을 눌러 에이전트를 다운로드하고 설치하세요.<br />설치가 완료되면 트레이 아이콘이 자동으로 나타납니다.</>}
                </p>
              </div>
              <div className="nv-agent-path-action">
                <button className="btn-outline" onClick={() => setShowInstallModal(true)}>
                  {launchFailed ? '최신 버전 다운로드' : '에이전트 다운로드'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {showInstallModal && (
          <div className="nv-install-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleCloseInstallModal(); }}>
            <div className="nv-install-modal nv-install-modal--wide">
              <div className="nv-install-modal-header">
                <h3>Estate-OS Agent 설치 안내</h3>
                <button className="nv-install-close" onClick={handleCloseInstallModal} aria-label="닫기">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              {installDone ? (
                <div className="nv-install-done">
                  <div className="nv-install-done-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  </div>
                  <p className="nv-install-done-title">다운로드가 시작되었습니다!</p>
                  <p className="nv-install-done-desc">
                    다운로드한 파일(<b>Estate-OS-Agent-Setup.exe</b>)을 실행하면
                    <br />클릭 한 번으로 설치가 완료됩니다.
                    <br /><br />
                    설치 후 트레이 아이콘이 뜨면 이 화면으로 돌아와
                    <br /><b>연결 재시도</b>를 눌러 주세요.
                  </p>
                  <button className="btn-primary nv-install-action-btn" onClick={handleCloseInstallModal}>
                    확인
                  </button>
                </div>
              ) : (
                <div className="nv-install-modal-body">
                  <p className="nv-install-intro">
                    설치 전에 아래 내용을 꼭 읽어 주세요.
                  </p>

                  <div className="nv-install-cards">
                    <div className="nv-install-card">
                      <div className="nv-install-card-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12l2 2 4-4"/></svg>
                      </div>
                      <div>
                        <div className="nv-install-card-title">이 프로그램은 무엇인가요?</div>
                        <div className="nv-install-card-desc">
                          PC 배경에서 조용히 실행되는 소형 도우미 프로그램입니다.<br />
                          웹사이트에서 네이버 부동산 데이터를 조회할 때,<br />
                          이 PC를 통해 대신 요청을 보내줍니다.
                        </div>
                      </div>
                    </div>

                    <div className="nv-install-card">
                      <div className="nv-install-card-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                      </div>
                      <div>
                        <div className="nv-install-card-title">내 정보는 안전한가요?</div>
                        <div className="nv-install-card-desc">
                          네이버 로그인 쿠키는 <b>이 PC에만 저장</b>되며, 외부 서버로 전송되지 않습니다.<br />
                          이 프로그램은 네이버 부동산 외 다른 사이트에 접근하지 않습니다.
                        </div>
                      </div>
                    </div>

                    <div className="nv-install-card">
                      <div className="nv-install-card-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      </div>
                      <div>
                        <div className="nv-install-card-title">어디에 설치되나요?</div>
                        <div className="nv-install-card-desc">
                          <b>관리자 권한 불필요</b> — 현재 사용자 폴더에 설치됩니다.<br/>
                          Windows 시작 시 자동 실행되며 트레이에 아이콘으로 상주합니다.<br/>
                          삭제: 설정 → 앱 → Estate-OS Agent → 제거
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="nv-install-modal-actions">
                    <button className="btn-outline" onClick={handleCloseInstallModal}>취소</button>
                    <button className="btn-primary nv-install-action-btn" onClick={handleInstallConsent}>
                      이해했습니다
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // 에이전트 실행 중이지만 네이버 로그인 안 됨
  if (agentRunStatus === 'running' && !cookieReady) {
    return (
      <div className="eos-state-screen">
        <div className="nv-agent-offline">
          <div className="nv-agent-offline-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4l3 3" strokeLinecap="round" />
            </svg>
          </div>
          <h2>네이버 로그인이 필요합니다</h2>
          <p>
            아래 버튼을 누르면 네이버 로그인 창이 열립니다.
            <br />
            <b>평소처럼 네이버에 로그인</b>하면 자동으로 연결됩니다.
          </p>
          {loginError && (
            <div className="nv-login-error">{loginError}</div>
          )}
          <div className="nv-agent-actions">
            <button
              className="nv-login-btn"
              onClick={triggerLogin}
              disabled={loginLoading}
            >
              {loginLoading ? (
                <>
                  <span className="nv-login-spinner" />
                  로그인 창이 열렸습니다 — 네이버에 로그인해 주세요
                </>
              ) : (
                '네이버 로그인'
              )}
            </button>
          </div>
          {loginLoading && (
            <div className="nv-login-notice">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>
                창이 보이지 않으면 <b>작업 표시줄</b>에서 찾아 클릭해 주세요.<br />
                로그인 후 화면이 바뀌어도 <b>창을 직접 닫지 마세요.</b><br />
                연결 정보 수집이 끝나면 자동으로 닫힙니다.
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // 로그인 직후 성공 안내 (3.5초)
  if (agentRunStatus === 'running' && cookieReady && showLoginSuccess) {
    return (
      <div className="eos-state-screen">
        <div className="nv-agent-offline">
          <div className="nv-login-success-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
          <h2 style={{ color: 'var(--blue)' }}>네이버 로그인 완료!</h2>
          <p>
            이제 매물 검색을 시작할 수 있습니다.
            <br />
            <span style={{ fontSize: 13 }}>잠시 후 검색 화면으로 전환됩니다…</span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`eos-work${ctrlCollapsed ? ' ctrl-collapsed' : ''}`}>
      <SearchPanel
        status={state.status}
        onStart={handleStart}
        onStop={stop}
        onToggleCollapse={() => setCtrlCollapsed((v) => !v)}
      />

      <main className="eos-view">
        {connectionValid === false && (
          <div className="nv-bearer-warn nv-bearer-warn--action">
            <div className="nv-bearer-warn-text">
              인증 토큰이 만료되어 재로그인으로 토큰을 갱신해야 할 수 있습니다.
            </div>
            <button
              className="nv-bearer-relogin-btn"
              onClick={triggerLogin}
              disabled={loginLoading}
            >
              {loginLoading ? '로그인 중…' : '다시 로그인'}
            </button>
          </div>
        )}
        <Monitor
          status={state.status}
          progress={state.progress}
          summary={state.summary}
          propertyCount={state.properties.length}
        />

        <div className="eos-card grow nv-result-card">
          {showEmptyState ? (
            <div className="nv-result-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
                <path d="M3 3v18h18" />
                <path d="M7 14l3-4 3 2 4-6" />
              </svg>
              <h2>아직 데이터 조회 전입니다</h2>
              <p>좌측에서 조건을 설정한 뒤 <b>데이터 수집 실행</b>을 눌러주세요.</p>
            </div>
          ) : (
          <>
          <div className="result-header">
            <span className="result-title">데이터 조회 결과</span>
            <div className="result-unit-controls">
              <div className="result-unit-group">
                <span className="result-unit-label">면적</span>
                <div className="space-unit-toggle">
                  <button
                    type="button"
                    className={`space-unit-btn ${areaUnit === 'sqm' ? 'active' : ''}`}
                    onClick={() => setAreaUnit('sqm')}
                  >
                    ㎡
                  </button>
                  <button
                    type="button"
                    className={`space-unit-btn ${areaUnit === 'pyeong' ? 'active' : ''}`}
                    onClick={() => setAreaUnit('pyeong')}
                  >
                    평
                  </button>
                </div>
              </div>
              <div className="result-unit-group">
                <span className="result-unit-label">가격</span>
                <div className="space-unit-toggle">
                  <button
                    type="button"
                    className={`space-unit-btn ${priceUnit === 'thousand' ? 'active' : ''}`}
                    onClick={() => setPriceUnit('thousand')}
                  >
                    천원
                  </button>
                  <button
                    type="button"
                    className={`space-unit-btn ${priceUnit === 'manwon' ? 'active' : ''}`}
                    onClick={() => setPriceUnit('manwon')}
                  >
                    만원
                  </button>
                </div>
              </div>
              <button
                className="btn-outline btn-sm"
                onClick={handleSaveSlot}
                disabled={!canSave}
                title="현재 수집 결과를 슬롯에 저장"
              >
                슬롯 저장
              </button>
              <button
                className="btn-outline btn-sm"
                onClick={() => setSlotModalOpen(true)}
              >
                저장 슬롯 {savedCount > 0 ? `(${savedCount})` : ''}
              </button>
              {canReset && (
                <button className="btn-ghost btn-sm" onClick={reset}>
                  초기화
                </button>
              )}
            </div>
          </div>

          <ResultTable
            key={searchKey}
            properties={state.properties}
            realEstateType={state.searchType}
            areaUnit={areaUnit}
            priceUnit={priceUnit}
            meta={state.meta}
          />
          </>
          )}
        </div>
      </main>

      {crawlModalOpen && (
        <CrawlModal
          dongs={state.dongs}
          logs={state.logs}
          status={state.status}
          regionName={state.regionName}
          summary={state.summary}
          propertyCount={state.properties.length}
          complexCount={complexCount}
          enumerateDongs={state.lastConfig?.enumerateDongs ?? false}
          onClose={() => setCrawlModalOpen(false)}
          onStop={stop}
          onClearLogs={clearLogs}
          onSkipDong={skipDong}
        />
      )}

      {slotModalOpen && (
        <SlotModal
          slots={slots.slots}
          priceUnit={priceUnit}
          areaUnit={areaUnit}
          canSave={canSave}
          onSaveAt={handleSaveAt}
          onLoad={handleLoad}
          onReSearch={handleReSearch}
          onDelete={slots.deleteSlot}
          onClose={() => setSlotModalOpen(false)}
        />
      )}

      {notice && <InfoModal message={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}
