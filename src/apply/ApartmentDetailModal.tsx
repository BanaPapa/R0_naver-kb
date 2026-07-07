import { useEffect, useState } from 'react';
import { X, Globe, Download, ExternalLink } from 'lucide-react';
import { ApartmentDetail, DetailCell } from './types';

interface ApartmentDetailModalProps {
  houseName: string;
  region?: string;
  loading: boolean;
  error: boolean;
  detail: ApartmentDetail | null;
  onClose: () => void;
}

type Tab = 'general' | 'special';

/** 병합된 셀(rowSpan/show)을 그대로 <td>로 렌더 — show=false는 위 셀에 흡수되어 생략. */
function MergedBody({ rows, typeColIndex }: { rows: DetailCell[][]; typeColIndex?: number }) {
  return (
    <tbody>
      {rows.map((cells, r) => (
        <tr key={r}>
          {cells.map((c, j) =>
            c.show ? (
              <td
                key={j}
                rowSpan={c.rowSpan > 1 ? c.rowSpan : undefined}
                className={j === typeColIndex ? 'dm-cell-type' : undefined}
              >
                {c.v || '-'}
              </td>
            ) : null
          )}
        </tr>
      ))}
    </tbody>
  );
}

/**
 * 단지 상세 모달 — 결과표의 단지를 더블클릭하면 열린다.
 * 상단: 분양 홈페이지 링크 · 모집공고문 다운로드 · 청약홈 공고 상세.
 * 하단: 일반공급(1·2순위) / 특별공급 탭으로 청약홈 원본 청약결과 표를
 *       셀 병합(rowspan)까지 동일하게 재현해 표시.
 */
export function ApartmentDetailModal({
  houseName, region, loading, error, detail, onClose,
}: ApartmentDetailModalProps) {
  const [tab, setTab] = useState<Tab>('general');

  // 다른 단지를 열면 항상 일반공급 탭부터.
  useEffect(() => { setTab('general'); }, [detail?.houseManageNo]);

  const generalRows = detail?.competition.rows ?? [];
  const special = detail?.specialSupply ?? null;
  const hasSpecial = !!special && special.rows.length > 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card detail-modal" onClick={(e) => e.stopPropagation()}>
        <button className="cm-close" onClick={onClose} title="닫기">
          <X />
        </button>

        {/* ── 상단: 제목 + 공식 링크 ── */}
        <div className="dm-head">
          <div className="dm-title-wrap">
            {region && <span className="dm-region">{region}</span>}
            <h3 className="dm-title">{detail?.houseName || houseName}</h3>
          </div>

          <div className="dm-links">
            {detail?.homepageUrl && (
              <a className="dm-link" href={detail.homepageUrl} target="_blank" rel="noreferrer">
                <Globe />
                홈페이지
              </a>
            )}
            {detail?.noticeUrl && (
              <a className="dm-link primary" href={detail.noticeUrl} target="_blank" rel="noreferrer">
                <Download />
                모집공고 다운로드
              </a>
            )}
            {detail?.detailUrl && (
              <a className="dm-link" href={detail.detailUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
                청약홈에서 보기
              </a>
            )}
          </div>
        </div>

        {/* ── 하단: 원본 청약결과 표 ── */}
        <div className="dm-body">
          {loading ? (
            <div className="dm-state">
              <span className="cm-live-spin dm-spin" />
              원본 데이터를 불러오는 중…
            </div>
          ) : error ? (
            <div className="dm-state">상세 정보를 불러오지 못했습니다.</div>
          ) : generalRows.length === 0 && !hasSpecial ? (
            <div className="dm-state">표시할 청약결과 데이터가 없습니다.</div>
          ) : (
            <>
              {/* 탭: 일반공급(1·2순위) / 특별공급 */}
              <div className="dm-tabs">
                <button
                  className={`dm-tab${tab === 'general' ? ' active' : ''}`}
                  onClick={() => setTab('general')}
                >
                  일반공급
                </button>
                <button
                  className={`dm-tab${tab === 'special' ? ' active' : ''}`}
                  onClick={() => setTab('special')}
                  disabled={!hasSpecial}
                  title={hasSpecial ? undefined : '특별공급 내역이 없습니다'}
                >
                  특별공급
                </button>
              </div>

              {tab === 'general' ? (
                <>
                  <div className="dm-section-label">청약결과 (경쟁률)</div>
                  {generalRows.length === 0 ? (
                    <div className="dm-state">일반공급 청약결과 데이터가 없습니다.</div>
                  ) : (
                    <div className="dm-table-wrap">
                      <table className="dm-table">
                        <thead>
                          <tr>
                            <th rowSpan={2}>주택형</th>
                            <th rowSpan={2}>공급<br />세대수</th>
                            <th rowSpan={2} colSpan={2}>순위</th>
                            <th rowSpan={2}>접수<br />건수</th>
                            <th rowSpan={2}>순위내 경쟁률<br />(미달세대수)</th>
                            <th rowSpan={2}>청약결과</th>
                            <th colSpan={4}>당첨가점</th>
                          </tr>
                          <tr>
                            <th>지역</th>
                            <th>최저</th>
                            <th>최고</th>
                            <th>평균</th>
                          </tr>
                        </thead>
                        <MergedBody rows={generalRows} typeColIndex={0} />
                      </table>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="dm-section-label">특별공급 청약접수 현황</div>
                  {!hasSpecial ? (
                    <div className="dm-state">특별공급 내역이 없습니다.</div>
                  ) : (
                    <div className="dm-table-wrap">
                      <table className="dm-table">
                        <thead>
                          <tr>
                            <th rowSpan={2}>주택형</th>
                            <th rowSpan={2}>공급<br />세대수</th>
                            <th rowSpan={2}>지역</th>
                            <th colSpan={special!.typeLabels.length}>접수건수</th>
                            <th rowSpan={2}>청약결과</th>
                          </tr>
                          <tr>
                            {special!.typeLabels.map((label, i) => (
                              <th key={i}>{label}</th>
                            ))}
                          </tr>
                        </thead>
                        <MergedBody rows={special!.rows} typeColIndex={0} />
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
