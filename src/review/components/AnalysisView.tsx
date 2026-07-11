import React from 'react';
import type { AnalysisResult, AnalysisMeta, AnalysisCategory, TrendPoint } from '../types';

// 분석 결과 전체 렌더 (모달·히스토리 상세 공용). 모든 시각화는 외부 라이브러리 없이 SVG/CSS.

const sentimentTag = (s: string) => (s === '긍정' ? 'tag-plus' : s === '부정' ? 'tag-minus' : 'tag-neutral');

interface AnalysisViewProps {
  result: AnalysisResult | null;
  meta?: AnalysisMeta | null;
}

export default function AnalysisView({ result, meta }: AnalysisViewProps) {
  if (!result) return null;
  const total = result.totalCount ?? result.reviewCount ?? 0;
  const s = result.sentiment ?? { positive: 0, negative: 0, neutral: 0 };
  const pos = s.positive ?? 0;
  const neg = s.negative ?? 0;
  const neu = s.neutral ?? 0;
  const denom = total || pos + neg + neu || 1;
  const pct = (n: number) => Math.round((n / denom) * 100);
  const categories = (result.categories ?? []).filter((c) => c.positive?.length || c.negative?.length);
  const trend = result.trend ?? [];
  const rel = result.dataReliability;
  const conf = result.confidence;

  return (
    <div className="av">
      {meta && (
        <div className="av-meta">
          <span className="av-meta-apt">{meta.aptName}</span>
          {result.overallSentiment && (
            <span className={`tag ${sentimentTag(result.overallSentiment)}`}>{result.overallSentiment}</span>
          )}
          <span className="av-meta-sub">
            총 {total}건 · {meta.model}
          </span>
          {meta.savedAt && <span className="av-meta-sub">{formatDate(meta.savedAt)}</span>}
        </div>
      )}

      {/* 신뢰도 */}
      {(rel || conf) && (
        <section>
          <div className="av-title">신뢰도</div>
          <div className="av-rel-grid">
            {rel && (
              <div className="av-rel-card">
                <div className="av-rel-head">
                  <span>데이터 신뢰도</span>
                  <span className={`av-rel-level lv-${rel.level}`}>{rel.level}</span>
                </div>
                <Gauge value={rel.score} />
                <div className="av-rel-factors">
                  <span>표본 {rel.factors?.volume ?? 0}%</span>
                  <span>커버리지 {rel.factors?.coverage ?? 0}%</span>
                  <span>감성 명확성 {rel.factors?.decisiveness ?? 0}%</span>
                </div>
                <p className="av-hint">표본 수·분류 커버리지·감성 편향으로 계산 (모델 무관)</p>
              </div>
            )}
            {conf && (
              <div className="av-rel-card">
                <div className="av-rel-head">
                  <span>모델 자기평가</span>
                  <span className="av-rel-score">{conf.score}</span>
                </div>
                <Gauge value={conf.score} accent="var(--blue)" />
                {conf.reason && <p className="av-hint">“{conf.reason}”</p>}
                <p className="av-hint">{meta?.model ?? '모델'}이(가) 보고한 확신도</p>
              </div>
            )}
          </div>
        </section>
      )}

      {/* 감성 분포 */}
      <section>
        <div className="av-title">감성 분포</div>
        <div className="senti-bar">
          {pos > 0 && <div className="senti-seg pos" style={{ width: `${pct(pos)}%` }} />}
          {neu > 0 && <div className="senti-seg neu" style={{ width: `${pct(neu)}%` }} />}
          {neg > 0 && <div className="senti-seg neg" style={{ width: `${pct(neg)}%` }} />}
        </div>
        <div className="senti-legend">
          <span>
            <i className="dot pos" /> 긍정 {pct(pos)}% <b>({pos})</b>
          </span>
          <span>
            <i className="dot neu" /> 중립 {pct(neu)}% <b>({neu})</b>
          </span>
          <span>
            <i className="dot neg" /> 부정 {pct(neg)}% <b>({neg})</b>
          </span>
        </div>
      </section>

      {/* 시간별 감성 추세 */}
      {trend.length >= 2 && (
        <section>
          <div className="av-title">작성일별 감성 추세</div>
          <TrendChart trend={trend} />
        </section>
      )}

      {/* 분류별 긍·부정 강도 */}
      {categories.length > 0 && (
        <section>
          <div className="av-title">분류별 긍·부정 강도</div>
          <DivergingBars categories={categories} />
        </section>
      )}

      {result.summary && (
        <section>
          <div className="av-title">종합 요약</div>
          <p className="analysis-text">{result.summary}</p>
        </section>
      )}

      {/* 분류별 상세 */}
      {categories.length > 0 && (
        <section>
          <div className="av-title">분류별 상세</div>
          <div className="cat-head">
            <span className="cat-name" />
            <span className="cat-head-plus">긍정</span>
            <span className="cat-head-minus">부정</span>
          </div>
          <div className="cat-grid">
            {categories.map((c, i) => (
              <div key={i} className="cat-row">
                <div className="cat-name">{c.name}</div>
                <div className="cat-cols">
                  <div className="cat-col">
                    {(c.positive ?? []).map((p, j) => (
                      <span key={j} className="tag tag-plus">
                        {p}
                      </span>
                    ))}
                    {!c.positive?.length && <span className="cat-empty">—</span>}
                  </div>
                  <div className="cat-col">
                    {(c.negative ?? []).map((n, j) => (
                      <span key={j} className="tag tag-minus">
                        {n}
                      </span>
                    ))}
                    {!c.negative?.length && <span className="cat-empty">—</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {result.conclusion && (
        <section className="analysis-conclusion">
          <div className="av-title">최종 결론</div>
          <p className="analysis-text">{result.conclusion}</p>
        </section>
      )}
    </div>
  );
}

/* ── 게이지 (0~100 가로 바 + 마커) ── */
function Gauge({ value, accent = 'var(--teal, #2dd4bf)' }: { value: number; accent?: string }) {
  const v = Math.max(0, Math.min(100, value || 0));
  return (
    <div className="av-gauge">
      <div className="av-gauge-track">
        <div className="av-gauge-fill" style={{ width: `${v}%`, background: accent }} />
      </div>
      <span className="av-gauge-val">{v}</span>
    </div>
  );
}

/* ── 추세 라인 차트 (SVG, 긍정·부정 카운트) ── */
function TrendChart({ trend }: { trend: TrendPoint[] }) {
  const W = 640;
  const H = 180;
  const padL = 34;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const n = trend.length;
  const maxY = Math.max(1, ...trend.map((t) => Math.max(t.positive, t.negative)));
  const x = (i: number) => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => padT + ih - (v / maxY) * ih;
  const line = (key: 'positive' | 'negative') =>
    trend.map((t, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(t[key]).toFixed(1)}`).join(' ');
  const area = (key: 'positive' | 'negative') =>
    `${line(key)} L ${x(n - 1).toFixed(1)} ${(padT + ih).toFixed(1)} L ${x(0).toFixed(1)} ${(padT + ih).toFixed(1)} Z`;
  const labelEvery = Math.ceil(n / 6);

  return (
    <div className="av-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 180 }}>
        {/* y 그리드 */}
        {[0, 0.5, 1].map((f, i) => {
          const yy = padT + ih - f * ih;
          return (
            <g key={i}>
              <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="var(--border)" strokeWidth="1" />
              <text x={padL - 6} y={yy + 4} textAnchor="end" fontSize="11" fill="var(--muted-2)">
                {Math.round(f * maxY)}
              </text>
            </g>
          );
        })}
        {/* 부정 area+line */}
        <path d={area('negative')} fill="var(--red)" opacity="0.10" />
        <path d={line('negative')} fill="none" stroke="var(--red)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {/* 긍정 area+line */}
        <path d={area('positive')} fill="var(--teal, #2dd4bf)" opacity="0.12" />
        <path d={line('positive')} fill="none" stroke="var(--teal, #2dd4bf)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {/* 점 */}
        {trend.map((t, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(t.positive)} r="2.5" fill="var(--teal, #2dd4bf)" />
            <circle cx={x(i)} cy={y(t.negative)} r="2.5" fill="var(--red)" />
            {i % labelEvery === 0 && (
              <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--muted-2)">
                {t.period.slice(2)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="senti-legend" style={{ marginTop: 4 }}>
        <span>
          <i className="dot pos" /> 긍정
        </span>
        <span>
          <i className="dot neg" /> 부정
        </span>
      </div>
    </div>
  );
}

/* ── 분류별 다이버징 바 (부정 ← | → 긍정) ── */
function DivergingBars({ categories }: { categories: AnalysisCategory[] }) {
  const rows = categories.map((c) => ({
    name: c.name,
    pos: c.positive?.length ?? 0,
    neg: c.negative?.length ?? 0,
  }));
  const max = Math.max(1, ...rows.map((r) => Math.max(r.pos, r.neg)));
  return (
    <div className="av-div">
      {rows.map((r, i) => (
        <div key={i} className="av-div-row">
          <span className="av-div-name">{r.name}</span>
          <div className="av-div-track">
            <div className="av-div-neg">
              {r.neg > 0 && (
                <span className="av-div-fill neg" style={{ width: `${(r.neg / max) * 100}%` }}>
                  {r.neg}
                </span>
              )}
            </div>
            <div className="av-div-mid" />
            <div className="av-div-pos">
              {r.pos > 0 && (
                <span className="av-div-fill pos" style={{ width: `${(r.pos / max) * 100}%` }}>
                  {r.pos}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}
