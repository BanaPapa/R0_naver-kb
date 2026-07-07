import { X, Square, Check } from 'lucide-react';
import { CollectItem, CollectStatus } from './types';

interface ApplyCrawlModalProps {
  status: CollectStatus;
  regionName: string;       // 선택 지역명 (예: '전체', '서울')
  items: CollectItem[];     // 현재 페이지에서 수집 중인 단지들
  totalCount: number;       // 필터 조건 전체 청약 건수
  totalPages: number;
  page: number;
  durationSec: number;
  onClose: () => void;
  onStop: () => void;
}

/**
 * 청약홈 검색 진행 모달.
 * R3_Naver(네이버 매물앱)의 '단지정보 수집' 모달(CrawlModal)과 동일한 디자인 —
 * 좌측: 단지별 수집 진행 막대 / 우측: 라이브 카운트 또는 완료 요약.
 */
export function ApplyCrawlModal({
  status, regionName, items, totalCount, totalPages, page, durationSec, onClose, onStop,
}: ApplyCrawlModalProps) {
  const isCounting = status === 'counting';
  const isDone = status === 'done';
  const isStopped = status === 'stopped';
  const isRunning = status === 'running' || status === 'counting';
  const doneCount = items.filter((d) => d.status === 'done').length;

  // 진행 중에는 오버레이/닫기로 닫히지 않음 — '결과 보기'·'닫기'로만 닫힘
  return (
    <div className="modal-overlay">
      <div className="modal-card crawl-modal apply">
        {!isRunning && (
          <button className="cm-close" onClick={onClose} title="닫기">
            <X />
          </button>
        )}

        <div className="cm-body">
          {/* 좌: 단지별 수집 진행 */}
          <div className="cm-left">
            <div className="crawl-prog">
              <div className="cp-head">
                <b>단지 정보 수집{regionName ? ` · ${regionName}` : ''}</b>
                <span className="cp-frac">{doneCount} / {items.length}</span>
              </div>

              <div className="cp-list">
                {isCounting && items.length === 0 ? (
                  <div className="cp-dong active">
                    <div className="cp-dong-main">
                      <div className="cp-dong-row">
                        <span className="cp-nm">▸ 청약 건수 확인 중…</span>
                        <span className="cp-ct">…</span>
                      </div>
                      <div className="cp-bar"><i style={{ width: '40%' }} /></div>
                    </div>
                  </div>
                ) : (
                  items.map((d) => (
                    <div key={d.index} className={`cp-dong ${d.status}`}>
                      <div className="cp-dong-main">
                        <div className="cp-dong-row">
                          <span className="cp-nm">
                            {d.status === 'active' ? '▸ ' : d.status === 'done' ? '✓ ' : ''}{d.houseName}
                          </span>
                          <span className="cp-ct">
                            {d.status === 'done' ? '완료' : d.status === 'active' ? '수집 중' : '대기'}
                          </span>
                        </div>
                        <div className="cp-bar">
                          <i style={{ width: d.status === 'done' ? '100%' : d.status === 'active' ? '66%' : '0%' }} />
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* 우: 진행 중 라이브 카운트 / 완료 요약 */}
          <div className={`cm-right${isDone || isStopped ? ' done' : ''}`}>
            {isDone || isStopped ? (
              <>
                <h3 className="cm-done-title">
                  {isStopped ? (
                    <Square className="cm-done-ic stop" strokeWidth={2.5} />
                  ) : (
                    <Check className="cm-done-ic" strokeWidth={3} />
                  )}
                  {isStopped ? '조회 중지됨' : '조회 완료'}
                </h3>
                <p className="cm-done-sub">{regionName}</p>

                <div className="cm-stats">
                  <div className="cm-stat">
                    <span className="cm-v accent">{totalCount.toLocaleString()}</span>
                    <span className="cm-l">총 청약 건수</span>
                  </div>
                  <div className="cm-stat">
                    <span className="cm-v">{doneCount.toLocaleString()}</span>
                    <span className="cm-l">수집 단지</span>
                  </div>
                  <div className="cm-stat">
                    <span className="cm-v">{page}/{Math.max(totalPages, 1)}</span>
                    <span className="cm-l">페이지</span>
                  </div>
                  <div className="cm-stat">
                    <span className="cm-v">{durationSec.toLocaleString()}</span>
                    <span className="cm-l">소요(초)</span>
                  </div>
                </div>

                <button className="eos-run-btn cm-result-btn" onClick={onClose}>
                  결과 보기
                </button>
              </>
            ) : (
              <div className="cm-live">
                <div className="cm-live-spin" />
                <div className="cm-live-v">{(isCounting ? totalCount : doneCount).toLocaleString()}</div>
                <div className="cm-live-l">{isCounting ? '청약 건수 확인 중…' : '단지 수집 중…'}</div>
                <div className="cm-live-frac">
                  {items.length > 0 ? `${items.length}개 단지 · 총 ${totalCount.toLocaleString()}건` : ''}
                </div>
                <button className="eos-run-btn stop cm-stop-btn" onClick={onStop}>
                  <Square />
                  수집 중지
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
