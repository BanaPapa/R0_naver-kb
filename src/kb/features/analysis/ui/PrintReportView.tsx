import React, { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import type { AnalysisScope, AnalysisDataset } from '../../../entities/analysis';
import { parseTabStructure } from '../lib/report-structure';
import { Markdown } from './AnalysisResult';

// A4 한 장 규격의 정형화 보고서 뷰 + 브라우저 인쇄(PDF 저장) 진입점.
//
// 모델 출력에 의존하지 않는 부분(작성일·비교 지역·비교 지표·차트·지표 표·용어 설명)은
// scope/datasets 에서 직접 그리고, 모델 출력(결론·근거·향후 전망)은 report-structure 파서로
// 뽑아 고정 위치에 배치한다 → 어떤 모델이 답해도 보고서 골격이 동일하다.
//
// 인쇄는 window.print() + @media print 로 이 뷰(#kb-print-root)만 종이에 나가게 한다.
// 인쇄 대화상자에서 "PDF로 저장"을 고르면 그대로 PDF가 된다.

interface PrintReportViewProps {
  onClose: () => void;
  tabLabel: string; // 보고서 대상 탭(종합/지역명)
  markdown: string; // 해당 탭의 분석 본문
  scope: AnalysisScope | null;
  datasets: AnalysisDataset[];
  model: string;
}

// 지역 시리즈 색 (차트·범례·표 공용, scope.regions 순서 고정)
const REGION_COLORS = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed'];

// 지표별 용어 설명(정적). 보고서 하단 용어 설명 섹션은 모델 출력과 무관하게 여기서 그린다.
const GLOSSARY: Record<string, string> = {
  saleIndex: '기준시점을 100으로 둔 아파트 매매가격의 상대 수준. 100보다 크면 기준시점 대비 상승.',
  jeonseIndex: '기준시점을 100으로 둔 아파트 전세가격의 상대 수준.',
  saleChange: '직전 조사(주간/월간) 대비 매매가격지수의 변화율(%).',
  jeonseChange: '직전 조사 대비 전세가격지수의 변화율(%).',
  buyerAdvantage: '0~200 범위. 100을 넘으면 시장에 매수자가 상대적으로 많아 매수세가 강함을 뜻함.',
  jeonseSupply: '0~200 범위. 100을 넘으면 전세 공급이 부족(수요 우위)하다는 응답이 많음.',
  saleActivity: '0~200 범위. 100을 넘으면 매매 거래가 활발하다는 응답이 많음.',
  jeonseActivity: '0~200 범위. 100을 넘으면 전세 거래가 활발하다는 응답이 많음.',
  avgSale: '아파트 3.3㎡(1평)당 평균 매매가격(만원).',
  avgJeonse: '아파트 3.3㎡(1평)당 평균 전세가격(만원).',
  gap: '평당 평균 매매가와 전세가의 차이(만원/3.3㎡). 격차가 작을수록 전세가가 매매가에 근접.',
  jeonseRatio: '매매가 대비 전세가 비율(%). 높을수록 매매가 대비 전세 부담이 큼.',
  saleForecast: '중개업소 설문 기반 전망지수. 100을 넘으면 매매가격 상승 전망 우세.',
  jeonseForecast: '중개업소 설문 기반 전망지수. 100을 넘으면 전세가격 상승 전망 우세.',
  medianSale: '아파트 중위 매매가(만원/호). 가격순 정중앙 값으로 평균보다 이상치 왜곡이 적음.',
  medianJeonse: '아파트 중위 전세가(만원/호).',
  leading50: 'KB 선도아파트 50지수. 시가총액 상위 50개 대단지의 가격지수 — 시장 전체에 선행하는 경향.',
};

const MAX_CHARTS = 4; // A4 한 장 유지를 위한 상한
const MAX_TABLE_ROWS = 12;

const fmtVal = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('ko-KR', { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 1 });
};

const fmtPct = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
};

const DIRECTION: Record<'up' | 'down' | 'flat', { mark: string; color: string }> = {
  up: { mark: '▲', color: '#dc2626' },
  down: { mark: '▼', color: '#2563eb' },
  flat: { mark: '─', color: '#6b7280' },
};

// '2024-01-08' → '24.01'
const fmtDateTick = (d: string): string => (d.length >= 7 ? `${d.slice(2, 4)}.${d.slice(5, 7)}` : d);

const today = (): string => {
  const n = new Date();
  return `${n.getFullYear()}년 ${n.getMonth() + 1}월 ${n.getDate()}일`;
};

// 한 데이터셋의 지역별 시계열 → recharts 행(날짜 합집합 기준)
function chartRows(d: AnalysisDataset, regions: string[]): Record<string, string | number | null>[] {
  const maps: [string, Map<string, number | null>][] = [];
  const dates = new Set<string>();
  for (const r of regions) {
    const rs = d.byRegion[r];
    if (!rs) continue;
    const m = new Map<string, number | null>();
    for (const p of rs.series) {
      m.set(p.date, p.value);
      dates.add(p.date);
    }
    maps.push([r, m]);
  }
  return Array.from(dates)
    .sort()
    .map(date => {
      const row: Record<string, string | number | null> = { date };
      for (const [r, m] of maps) row[r] = m.get(date) ?? null;
      return row;
    });
}

const CSS = `
#kb-print-root { position: fixed; inset: 0; z-index: 90; overflow: auto; background: rgba(15, 23, 42, .78); padding: 0 16px 48px; font-family: 'Segoe UI', 'Malgun Gothic', system-ui, sans-serif; }
#kb-print-root .kbpr-toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; margin: 0 -16px 18px; padding: 12px 24px; background: rgba(15, 23, 42, .92); }
#kb-print-root .kbpr-toolbar-title { color: #e5e7eb; font-size: 14px; font-weight: 700; }
#kb-print-root .kbpr-toolbar-hint { color: #94a3b8; font-size: 12px; margin-right: auto; }
#kb-print-root .kbpr-btn { border: 1px solid #475569; border-radius: 8px; background: transparent; color: #e5e7eb; font-size: 13px; padding: 7px 14px; cursor: pointer; }
#kb-print-root .kbpr-btn:hover { background: rgba(148, 163, 184, .15); }
#kb-print-root .kbpr-btn--primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 700; }
#kb-print-root .kbpr-btn--primary:hover { background: #1d4ed8; }
#kb-print-root .kbpr-page { width: 210mm; min-height: 297mm; margin: 0 auto; background: #fff; color: #111827; padding: 10mm 12mm 12mm; box-shadow: 0 12px 40px rgba(0, 0, 0, .45); font-size: 11px; line-height: 1.55; box-sizing: border-box; }
#kb-print-root .kbpr-doc-title { font-size: 19px; font-weight: 800; letter-spacing: -.02em; margin: 0; }
#kb-print-root .kbpr-doc-sub { font-size: 10px; color: #6b7280; margin: 2px 0 0; }
#kb-print-root .kbpr-rule { border: 0; border-top: 2px solid #111827; margin: 8px 0 0; }
#kb-print-root .kbpr-meta { width: 100%; border-collapse: collapse; margin-top: 6px; table-layout: fixed; }
#kb-print-root .kbpr-meta th { width: 21mm; background: #f8fafc; border: 1px solid #e5e7eb; padding: 3px 7px; font-size: 10px; color: #475569; font-weight: 600; text-align: left; vertical-align: top; }
#kb-print-root .kbpr-meta td { border: 1px solid #e5e7eb; padding: 3px 7px; font-size: 10px; color: #111827; word-break: keep-all; }
#kb-print-root .kbpr-h { display: flex; align-items: baseline; gap: 6px; margin: 12px 0 5px; font-size: 12.5px; font-weight: 800; color: #111827; }
#kb-print-root .kbpr-h .kbpr-no { color: #2563eb; font-size: 10px; font-weight: 800; letter-spacing: .06em; }
#kb-print-root .kbpr-conclusion { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; padding: 8px 11px; font-size: 11px; }
#kb-print-root .kbpr-insights { margin: 5px 0 0; padding-left: 16px; color: #374151; }
#kb-print-root .kbpr-insights li { margin: 1px 0; }
#kb-print-root .kbpr-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 0 4px; font-size: 10px; color: #374151; }
#kb-print-root .kbpr-legend i { display: inline-block; width: 14px; height: 3px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
#kb-print-root .kbpr-charts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; break-inside: avoid; }
#kb-print-root .kbpr-chart { border: 1px solid #e5e7eb; border-radius: 6px; padding: 5px 6px 0; }
#kb-print-root .kbpr-chart-title { font-size: 10px; font-weight: 700; color: #374151; margin: 0 0 1px 2px; }
#kb-print-root .kbpr-points { margin: 0; padding-left: 17px; }
#kb-print-root .kbpr-points li { margin: 0 0 5px; }
#kb-print-root .kbpr-points .kbpr-point { font-weight: 700; }
#kb-print-root .kbpr-points .kbpr-basis { color: #4b5563; font-size: 10.5px; margin-top: 1px; }
#kb-print-root .kbpr-table { width: 100%; border-collapse: collapse; font-size: 10px; break-inside: avoid; }
#kb-print-root .kbpr-table th { background: #f3f4f6; border: 1px solid #e5e7eb; padding: 3px 6px; font-weight: 700; color: #374151; text-align: left; }
#kb-print-root .kbpr-table td { border: 1px solid #e5e7eb; padding: 3px 6px; color: #111827; }
#kb-print-root .kbpr-note { font-size: 9.5px; color: #9ca3af; margin: 3px 0 0; }
#kb-print-root .kbpr-glossary { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 16px; font-size: 9.5px; color: #4b5563; }
#kb-print-root .kbpr-glossary dt { font-weight: 700; color: #374151; float: left; margin-right: 5px; }
#kb-print-root .kbpr-glossary dd { margin: 0; }
#kb-print-root .kbpr-footer { display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid #e5e7eb; margin-top: 14px; padding-top: 6px; font-size: 9px; color: #9ca3af; }
@media print {
  @page { size: A4 portrait; margin: 0; }
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  body > *:not(#kb-print-root) { display: none !important; }
  #kb-print-root { position: static !important; overflow: visible !important; background: #fff !important; padding: 0 !important; }
  #kb-print-root .kbpr-toolbar { display: none !important; }
  #kb-print-root .kbpr-page { box-shadow: none !important; margin: 0 auto; }
  #kb-print-root * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
`;

export const PrintReportView: React.FC<PrintReportViewProps> = ({ onClose, tabLabel, markdown, scope, datasets, model }) => {
  const s = useMemo(() => parseTabStructure(markdown), [markdown]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const regions = scope?.regions ?? [];
  const label = (key: string) => scope?.regionLabels[key] ?? key;
  const color = (key: string) => REGION_COLORS[Math.max(0, regions.indexOf(key)) % REGION_COLORS.length]!;

  const metricLabels = Array.from(new Set(datasets.map(d => d.label)));
  // 선택 지역과 겹치는 데이터가 있는 데이터셋만 차트·표에 (전국 단일 지표 등은 겹칠 때만)
  const visible = datasets.filter(d => regions.some(r => d.byRegion[r]));
  const charts = visible.slice(0, MAX_CHARTS);
  const tableRows = visible.slice(0, MAX_TABLE_ROWS);
  const glossary = datasets
    .filter((d, i, arr) => GLOSSARY[d.metric] && arr.findIndex(x => x.metric === d.metric) === i)
    .map(d => ({ term: d.label, desc: GLOSSARY[d.metric]! }));

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div id="kb-print-root" role="dialog" aria-label="보고서 인쇄 미리보기">
      <style>{CSS}</style>

      <div className="kbpr-toolbar">
        <span className="kbpr-toolbar-title">보고서 인쇄 미리보기</span>
        <span className="kbpr-toolbar-hint">인쇄 대화상자에서 대상을 "PDF로 저장"으로 바꾸면 PDF 파일로 저장됩니다.</span>
        <button className="kbpr-btn kbpr-btn--primary" onClick={() => window.print()}>인쇄 / PDF 저장</button>
        <button className="kbpr-btn" onClick={onClose}>닫기</button>
      </div>

      <div className="kbpr-page">
        {/* ── 표제부: 제목 + 작성일·비교지역·비교데이터 ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <p className="kbpr-doc-title">부동산 시계열 데이터 분석 보고서</p>
            <p className="kbpr-doc-sub">KB 시계열 통계 기반 · 분석 대상: {tabLabel}</p>
          </div>
          <p className="kbpr-doc-sub" style={{ fontSize: 11, fontWeight: 700, color: '#111827' }}>작성일 {today()}</p>
        </div>
        <hr className="kbpr-rule" />
        <table className="kbpr-meta">
          <tbody>
            <tr>
              <th>비교 지역</th>
              <td>{regions.length ? regions.map(label).join(' · ') : '—'}</td>
              <th>분석 기간</th>
              <td>{scope ? `${scope.period.from} ~ ${scope.period.to}` : '—'}</td>
            </tr>
            <tr>
              <th>비교 데이터</th>
              <td colSpan={3}>{metricLabels.length ? metricLabels.join(', ') : '—'}</td>
            </tr>
            <tr>
              <th>분석 도구</th>
              <td>{model || 'AI 데이터 분석'}</td>
              <th>보고서 규격</th>
              <td>A4 정형 보고서 (자동 생성)</td>
            </tr>
          </tbody>
        </table>

        {/* ── 01 결론 (최상단) ── */}
        <p className="kbpr-h"><span className="kbpr-no">01</span>결론</p>
        {s.recognized && s.conclusion ? (
          <div className="kbpr-conclusion">
            {s.conclusion}
            {s.insights.length > 0 && (
              <ul className="kbpr-insights">
                {s.insights.map((it, i) => <li key={i}>{it}</li>)}
              </ul>
            )}
          </div>
        ) : (
          <div className="kbpr-conclusion">
            <Markdown text={markdown} scale={0.78} />
          </div>
        )}

        {/* ── 02 통합 분석 차트 (datasets 기반 — 모델 무관) ── */}
        <p className="kbpr-h"><span className="kbpr-no">02</span>통합 분석 차트</p>
        {charts.length > 0 ? (
          <>
            <div className="kbpr-legend">
              {regions.map(r => (
                <span key={r}><i style={{ background: color(r) }} />{label(r)}</span>
              ))}
            </div>
            <div className="kbpr-charts">
              {charts.map(d => (
                <div key={`${d.tab}-${d.metric}`} className="kbpr-chart">
                  <p className="kbpr-chart-title">{d.label}{d.unit ? ` (${d.unit})` : ''}</p>
                  <LineChart width={330} height={128} data={chartRows(d, regions)} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#f1f5f9" strokeDasharray="2 4" />
                    <XAxis dataKey="date" tickFormatter={fmtDateTick} tick={{ fontSize: 8, fill: '#6b7280' }} minTickGap={26} tickLine={false} axisLine={{ stroke: '#d1d5db' }} />
                    <YAxis width={38} domain={['auto', 'auto']} tick={{ fontSize: 8, fill: '#6b7280' }} tickFormatter={(v: number) => v.toLocaleString('ko-KR', { maximumFractionDigits: 1 })} tickLine={false} axisLine={false} />
                    {regions.map(r => (
                      <Line key={r} dataKey={r} stroke={color(r)} strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} />
                    ))}
                  </LineChart>
                </div>
              ))}
            </div>
            {visible.length > MAX_CHARTS && (
              <p className="kbpr-note">지면 관계상 상위 {MAX_CHARTS}개 지표만 차트로 표시했습니다. 나머지는 아래 지표 표를 참고하세요.</p>
            )}
          </>
        ) : (
          <p className="kbpr-note">차트로 그릴 데이터가 없습니다. (저장된 분석은 데이터 재수집이 끝난 뒤 인쇄하면 차트가 포함됩니다.)</p>
        )}

        {/* ── 03 결론의 근거 (모델 출력) ── */}
        {s.keyPoints.length > 0 && (
          <>
            <p className="kbpr-h"><span className="kbpr-no">03</span>결론의 근거</p>
            <ol className="kbpr-points">
              {s.keyPoints.map((kp, i) => (
                <li key={i}>
                  <div className="kbpr-point">{kp.point}</div>
                  {kp.basis && <div className="kbpr-basis">{kp.basis}</div>}
                </li>
              ))}
            </ol>
          </>
        )}

        {/* ── 04 확인된 데이터 지표 (datasets 요약 — 모델 무관) ── */}
        {tableRows.length > 0 && (
          <>
            <p className="kbpr-h"><span className="kbpr-no">04</span>확인된 데이터 지표</p>
            <table className="kbpr-table">
              <thead>
                <tr>
                  <th>지표</th>
                  {regions.map(r => <th key={r} style={{ color: color(r) }}>{label(r)}</th>)}
                </tr>
              </thead>
              <tbody>
                {tableRows.map(d => (
                  <tr key={`${d.tab}-${d.metric}`}>
                    <td>{d.label}{d.unit ? ` (${d.unit})` : ''}</td>
                    {regions.map(r => {
                      const sum = d.byRegion[r]?.summary;
                      if (!sum) return <td key={r}>—</td>;
                      const dir = DIRECTION[sum.direction];
                      return (
                        <td key={r}>
                          <b>{fmtVal(sum.latest)}</b>
                          {sum.changePct != null && (
                            <span style={{ color: dir.color, marginLeft: 4 }}>
                              {dir.mark} {fmtPct(sum.changePct)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="kbpr-note">
              값은 구간 내 최신값, 괄호 변동은 구간 시작 대비 증감률.
              {visible.length > MAX_TABLE_ROWS ? ` (외 ${visible.length - MAX_TABLE_ROWS}개 지표 생략)` : ''}
            </p>
          </>
        )}

        {/* ── 05 향후 시장 전망 (모델 출력) ── */}
        <p className="kbpr-h"><span className="kbpr-no">05</span>향후 시장 전망</p>
        <p style={{ margin: 0 }}>
          {s.forecast || '이번 분석 응답에는 향후 전망 섹션이 포함되지 않았습니다. "다시 분석"을 실행하면 최신 보고서 형식(향후 전망 포함)으로 생성됩니다.'}
        </p>

        {/* ── 06 용어 설명 (정적 — 모델 무관) ── */}
        {glossary.length > 0 && (
          <>
            <p className="kbpr-h"><span className="kbpr-no">06</span>용어 설명</p>
            <dl className="kbpr-glossary">
              {glossary.map(g => (
                <div key={g.term}>
                  <dt>{g.term}</dt>
                  <dd>{g.desc}</dd>
                </div>
              ))}
            </dl>
          </>
        )}

        <div className="kbpr-footer">
          <span>본 보고서는 시계열 데이터 기반 자동 분석 결과이며, 투자 권유나 특정 결과의 보증이 아닙니다.</span>
          <span>Estate-OS · 데이터 분석 보고서</span>
        </div>
      </div>
    </div>,
    document.body,
  );
};
