import React, { useState, useEffect, useMemo, useRef } from 'react';
import type { Session } from '@supabase/supabase-js';
import { SearchPanel } from './SearchPanel';
import { Monitor } from './Monitor';
import { ResultTable, TableStats } from './ResultTable';
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
import { AgentInstallGate } from './AgentInstallGate';
import { startSearchLog, finishSearchLog } from '../services/searchLogsRepo';

interface NaverCrawlerTabProps {
  crawler: ReturnType<typeof useCrawler>;
  slots: ReturnType<typeof useSlots>;
  session: Session | null;
  agentStatus: AgentStatusHook;
  isAdmin: boolean;
  onRequestInquiry: (prefill?: Record<string, unknown> | null) => void;
}

export function NaverCrawlerTab({ crawler, slots, session, agentStatus, isAdmin, onRequestInquiry }: NaverCrawlerTabProps) {
  const { state, start, stop, skipDong, reset, clearLogs, load } = crawler;
  const [searchKey, setSearchKey] = useState(0);
  const [areaUnit, setAreaUnit] = useState<AreaUnit>('sqm');
  const [priceUnit, setPriceUnit] = useState<PriceUnit>('thousand');
  const [ctrlCollapsed, setCtrlCollapsed] = useState(false);
  const [crawlModalOpen, setCrawlModalOpen] = useState(false);
  const [tableStats, setTableStats] = useState<TableStats | null>(null);
  const [slotModalOpen, setSlotModalOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; context: Record<string, unknown> } | null>(null);
  const {
    status: agentRunStatus,
    cookieReady,
    connectionValid,
    connectionReason,
    loginLoading,
    loginError,
    triggerLogin,
  } = agentStatus;

  // 네이버 로그인은 선택 사항 — 검색이 자주 막힐 때만 완화용으로 권한다.
  // 사용자가 이 안내를 닫으면 다시 띄우지 않는다.
  const [loginHintDismissed, setLoginHintDismissed] = useState(false);

  // agentRunStatus가 일시적으로 offline/unknown으로 바뀌어도 30초 간 이전 상태 유지
  // (탭 전환 후 복귀 시 polling 간격에 의한 순간 상태 변화로 SearchPanel 언마운트 방지)
  const lastRunningAtRef = useRef<number>(0);
  if (agentRunStatus === 'running') lastRunningAtRef.current = Date.now();
  const GRACE_MS = 30_000;
  const stableRunning =
    agentRunStatus === 'running' ||
    Date.now() - lastRunningAtRef.current < GRACE_MS;

  // 에이전트 상태 변경 시 베이스 URL + 크롤 토큰 관리
  // grace period 중에는 agent base URL을 유지 (일시적 offline에도 API 호출 정상화)
  useEffect(() => {
    const isStable = agentRunStatus === 'running' ||
      Date.now() - lastRunningAtRef.current < GRACE_MS;
    setNaverBases(isStable);

    if (isStable && session?.access_token) {
      fetchCrawlToken(session.access_token)
        .then((token: string) => setNaverCrawlToken(token))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (isAdmin) {
            setNotice(`크롤 토큰 발급 실패: ${msg}`);
          } else {
            setFailure({ message: '데이터 수집 준비 중 문제가 발생했습니다.', context: { kind: 'crawl-token', error: msg } });
          }
        });
    } else if (!isStable) {
      setNaverCrawlToken(null);
    }
  }, [agentRunStatus, session, isAdmin]);

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

  // 검색 활동 로깅 — 시작 시 요약 행 생성, 종료 시 상태 갱신 (실패는 검색을 막지 않음)
  // 시작 insert Promise 를 보관했다가, 종료 시 그 id 가 확정된 뒤 갱신한다
  // (검색이 insert 왕복보다 빨리 실패해도 'running' 행이 영구히 남지 않도록).
  const searchLogPromiseRef = useRef<Promise<string | null> | null>(null);
  const prevStatusRef = useRef<typeof state.status>('idle');
  useEffect(() => {
    const prev = prevStatusRef.current;
    const cur = state.status;
    prevStatusRef.current = cur;
    if (prev === cur) return;

    if (cur === 'running' && prev !== 'running') {
      searchLogPromiseRef.current = startSearchLog(state.meta);
    } else if ((cur === 'done' || cur === 'error' || cur === 'stopped') && prev === 'running') {
      const patch = {
        status: cur,
        resultCount: state.properties.length,
        errorMessage: cur === 'error' ? state.errorMessage ?? undefined : undefined,
      };
      Promise.resolve(searchLogPromiseRef.current).then((id) => finishSearchLog(id, patch));
    }
  }, [state.status, state.meta, state.properties.length, state.errorMessage]);

  // 비관리자: 백그라운드 검색 실패 시 문의 유도 모달
  useEffect(() => {
    if (isAdmin) return;
    if (state.status === 'error') {
      const err = state.errorMessage ?? '알 수 없는 오류';
      setFailure({
        message: '검색 중 문제가 발생했습니다. 관리자에게 문의해 주세요.',
        context: {
          kind: 'search-error',
          error: err,
          region: [state.meta.largeName, state.meta.midName, state.meta.smallName].filter(Boolean).join(' '),
          product: state.meta.realEstateType,
        },
      });
    }
  }, [state.status, state.errorMessage, state.meta, isAdmin]);

  const handleStart = (config: CrawlerConfig) => {
    // 429(rate-limited)는 쿠키 만료가 아니다 — 재로그인으로 안 풀린다. 검색을 막지 않고
    // 안내만 한다(내부 withRetry가 백오프로 재시도). 실제 인증 만료(expired)에만 재로그인 요구.
    if (connectionValid === false) {
      if (connectionReason === 'expired' || connectionReason === 'no-login') {
        setNotice('로그인이 만료되었습니다. 다시 로그인한 뒤 검색해 주세요.');
        return;
      }
      if (connectionReason === 'rate-limited') {
        setNotice('요청이 잠시 제한되었습니다(429). 재로그인은 필요 없습니다 — 잠시 후 다시 시도하면 자동 재시도됩니다.');
        // 차단하지 않고 진행: withRetry가 429를 백오프 재시도한다.
      }
    }
    setSearchKey((k) => k + 1);
    setCrawlModalOpen(true); // 검색 시작과 동시에 진행률 모달 표시
    start(config);
  };

  const canReset = state.status === 'done' || state.status === 'stopped';
  // 첫 수집 전(idle)에는 결과 영역(헤더 포함)을 대형 안내로 가린다.
  const showEmptyState = state.status === 'idle';

  // 에이전트 미실행 또는 초기 상태(unknown)일 때 안내 화면 표시 (grace period 이후에만).
  // 단, 이미 수집된 데이터가 있으면 안내 화면으로 교체하지 않는다 — 브라우저 탭 전환 후
  // 복귀 시 polling 순간 변동으로 결과 화면(SearchPanel/ResultTable)이 언마운트되어
  // 검색조건·정렬·필터·상세가격 캐시가 초기화되던 문제 방지.
  if (!stableRunning && state.properties.length === 0) {
    return <AgentInstallGate />;
  }

  // 네이버 로그인은 필수가 아니다. 확장이 브라우저의 익명 세션 쿠키로 검색을 수행하며,
  // 로그인은 429(과다요청)·봇차단을 완화하는 "선택" 요소일 뿐이다. 따라서 로그인 안 됨
  // 상태에서도 검색 화면으로 바로 들어간다(강제 로그인 화면 제거).

  return (
    <div className={`eos-work${ctrlCollapsed ? ' ctrl-collapsed' : ''}`}>
      <SearchPanel
        status={state.status}
        onStart={handleStart}
        onStop={stop}
        onToggleCollapse={() => setCtrlCollapsed((v) => !v)}
      />

      <main className="eos-view">
        {!cookieReady && !loginHintDismissed && (
          <div className="nv-bearer-warn nv-bearer-warn--action">
            <div className="nv-bearer-warn-text">
              <b>로그인 없이도 검색됩니다.</b> 검색이 자주 막히거나(429) 빌라·단독 결과가 비면 매물 사이트에 로그인해 보세요(선택).
            </div>
            <button
              className="nv-bearer-relogin-btn"
              onClick={triggerLogin}
              disabled={loginLoading}
            >
              {loginLoading ? '로그인 중…' : '매물 사이트 로그인'}
            </button>
            <button
              className="nv-bearer-relogin-btn"
              onClick={() => setLoginHintDismissed(true)}
              aria-label="안내 닫기"
            >
              닫기
            </button>
          </div>
        )}
        {loginError && !cookieReady && (
          <div className="nv-bearer-warn">
            <div className="nv-bearer-warn-text">{loginError}</div>
          </div>
        )}
        {connectionValid === false && (connectionReason === 'expired' || connectionReason === 'no-login') && (
          <div className="nv-bearer-warn nv-bearer-warn--action">
            <div className="nv-bearer-warn-text">
              로그인이 만료되었습니다. 다시 로그인하면 연결이 갱신됩니다.
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
        {connectionValid === false && connectionReason === 'rate-limited' && (
          <div className="nv-bearer-warn">
            <div className="nv-bearer-warn-text">
              요청이 잠시 제한되었습니다(429). 재로그인은 필요 없습니다 — 잠시 후 다시 검색하면 자동으로 재시도됩니다.
            </div>
          </div>
        )}
        <Monitor
          status={state.status}
          progress={state.progress}
          summary={state.summary}
          propertyCount={state.properties.length}
          tableStats={tableStats}
          priceUnit={priceUnit}
          isPresale={state.searchType === 'ABYG' || state.searchType === 'OBYG'}
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
            searchKey={searchKey}
            status={state.status}
            properties={state.properties}
            realEstateType={state.searchType}
            areaUnit={areaUnit}
            priceUnit={priceUnit}
            meta={state.meta}
            userId={session?.user?.id ?? null}
            onStatsChange={setTableStats}
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
          isAdmin={isAdmin}
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

      {failure && (
        <div className="modal-overlay" onClick={() => setFailure(null)}>
          <div className="modal-card fail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="fail-ic">!</div>
            <p className="fail-msg">{failure.message}</p>
            <div className="fail-actions">
              <button className="btn-ghost" onClick={() => setFailure(null)}>닫기</button>
              <button
                className="eos-run-btn"
                onClick={() => { const ctx = failure.context; setFailure(null); onRequestInquiry(ctx); }}
              >
                관리자에게 문의
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
