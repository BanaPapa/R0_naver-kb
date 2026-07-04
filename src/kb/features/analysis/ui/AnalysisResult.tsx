import React, { useEffect, useMemo, useState } from 'react';
import { parseTabStructure } from '../lib/report-structure';

// 경량 마크다운 렌더러 (외부 의존성 없음).
// 지원: #/##/### 제목, 굵게(**), 순서없는 목록(- / *), 번호 목록(1. 2.), 문단.
// 분석 결과는 docs/analysis-prompt.md 형식을 따른다.

type Block =
  | { kind: 'h'; level: 1 | 2 | 3; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'p'; text: string };

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let ul: string[] = [];
  let ol: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'p', text: para.join(' ') });
      para = [];
    }
  };
  const flushUl = () => {
    if (ul.length) {
      blocks.push({ kind: 'ul', items: ul });
      ul = [];
    }
  };
  const flushOl = () => {
    if (ol.length) {
      blocks.push({ kind: 'ol', items: ol });
      ol = [];
    }
  };
  const flushLists = () => {
    flushUl();
    flushOl();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const oli = /^\d+\.\s+(.*)$/.exec(line);
    const uli = /^[-*]\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushLists();
      blocks.push({ kind: 'h', level: h[1]!.length as 1 | 2 | 3, text: h[2]! });
    } else if (oli) {
      flushPara();
      flushUl();
      ol.push(oli[1]!);
    } else if (uli) {
      flushPara();
      flushOl();
      ul.push(uli[1]!);
    } else if (line.trim() === '') {
      flushPara();
      flushLists();
    } else {
      flushLists();
      para.push(line.trim());
    }
  }
  flushPara();
  flushLists();
  return blocks;
}

// 인라인 굵게(**...**) 처리
function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    const m = /^\*\*([^*]+)\*\*$/.exec(p);
    if (m) return <strong key={i} className="font-semibold text-gray-900">{m[1]}</strong>;
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}

// "~다." 로 끝나는 문장마다 줄바꿈해 가독성을 높인다(문단·목록 항목 내부).
function renderRich(text: string): React.ReactNode {
  const sentences = text.split(/(?<=다\.)\s+/).filter(s => s.trim().length > 0);
  if (sentences.length <= 1) return renderInline(text);
  return sentences.map((s, i) => (
    <React.Fragment key={i}>
      {i > 0 && <br />}
      {renderInline(s)}
    </React.Fragment>
  ));
}

// scale: 결과 글자 배율(1 = 기본 0.875rem). 제목은 em 기준이라 함께 확대/축소된다.
export const Markdown: React.FC<{ text: string; scale?: number }> = ({ text, scale = 1 }) => {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="leading-relaxed text-gray-700" style={{ fontSize: `${0.875 * scale}rem` }}>
      {blocks.map((b, i) => {
        if (b.kind === 'h') {
          const cls =
            b.level === 1
              ? 'mt-4 mb-2 text-[1.29em] font-bold text-gray-900'
              : b.level === 2
                ? 'mt-4 mb-1.5 text-[1.14em] font-bold text-gray-800'
                : 'mt-3 mb-1 text-[1em] font-semibold text-gray-800';
          return <p key={i} className={i === 0 ? cls.replace('mt-4', 'mt-0').replace('mt-3', 'mt-0') : cls}>{renderInline(b.text)}</p>;
        }
        if (b.kind === 'ul') {
          return (
            <ul key={i} className="my-1.5 ml-4 list-disc space-y-1">
              {b.items.map((it, j) => (
                <li key={j}>{renderRich(it)}</li>
              ))}
            </ul>
          );
        }
        if (b.kind === 'ol') {
          return (
            <ol key={i} className="my-1.5 ml-5 list-decimal space-y-1.5">
              {b.items.map((it, j) => (
                <li key={j} className="pl-1">{renderRich(it)}</li>
              ))}
            </ol>
          );
        }
        return <p key={i} className="my-1.5">{renderRich(b.text)}</p>;
      })}
    </div>
  );
};

// ── 구조화 보고서 렌더러 ────────────────────────────────────
// 결론·인사이트·핵심 내용·판단 근거·의문점을 docs/analysis-prompt.md 형식대로 파싱해
// (1) 결론+인사이트 한 묶음 → 실선, (2) 핵심 내용+판단 근거 인터리브 → 실선,
// (3) 의문점+후속 프롬프트 순서로 그린다. 알려진 섹션이 없으면 자유 마크다운으로 폴백한다.

// AI에게 그대로 붙여넣을 후속 질문 프롬프트 + 클립보드 복사.
const PromptBox: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 클립보드 미지원 환경은 조용히 무시 */
    }
  };
  return (
    <div className="mt-1.5 rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[0.8em] font-semibold text-blue-600">AI에게 물어볼 프롬프트</span>
        <button
          onClick={copy}
          className="flex-none rounded border border-blue-200 bg-white px-2 py-0.5 text-[0.8em] font-medium text-blue-600 hover:bg-blue-100"
        >
          {copied ? '복사됨 ✓' : '복사'}
        </button>
      </div>
      <p className="whitespace-pre-wrap text-[0.93em] leading-relaxed text-gray-600">{text}</p>
    </div>
  );
};

export const StructuredReport: React.FC<{ body: string; scale?: number }> = ({ body, scale = 1 }) => {
  const s = useMemo(() => parseTabStructure(body), [body]);
  const hasContent = s.conclusion || s.insights.length || s.keyPoints.length || s.forecast || s.questions.length;
  if (!s.recognized || !hasContent) return <Markdown text={body} scale={scale} />;

  const h2 = 'mb-1.5 text-[1.14em] font-bold text-gray-800';
  const hasFirst = !!(s.conclusion || s.insights.length);
  const hasMid = s.keyPoints.length > 0 || !!s.forecast;
  const hasQ = s.questions.length > 0;

  return (
    <div className="leading-relaxed text-gray-700" style={{ fontSize: `${0.875 * scale}rem` }}>
      {/* 결론 + 인사이트 */}
      {s.conclusion && (
        <>
          <p className={`mt-0 ${h2}`}>결론</p>
          <p className="my-1.5">{renderRich(s.conclusion)}</p>
        </>
      )}
      {s.insights.length > 0 && (
        <>
          <p className={`mt-4 ${h2}`}>인사이트</p>
          <ul className="my-1.5 ml-4 list-disc space-y-1">
            {s.insights.map((it, i) => (
              <li key={i}>{renderRich(it)}</li>
            ))}
          </ul>
        </>
      )}

      {hasFirst && (hasMid || hasQ) && <hr className="my-8 border-t border-gray-200" />}

      {/* 핵심 내용 + 판단 근거(인터리브) + 향후 전망 */}
      {hasMid && (
        <>
          {s.keyPoints.length > 0 && (
            <>
              <p className={`mt-0 ${h2}`}>핵심 내용</p>
              <ol className="my-1.5 ml-5 list-decimal space-y-3">
                {s.keyPoints.map((kp, i) => (
                  <li key={i} className="pl-1">
                    <div>{renderRich(kp.point)}</div>
                    {kp.basis && (
                      <div className="mt-1 rounded-md border-l-2 border-gray-200 bg-gray-50 px-3 py-1.5 text-[0.93em] text-gray-500">
                        <span className="font-semibold text-gray-400">근거 </span>
                        {renderRich(kp.basis)}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </>
          )}
          {s.forecast && (
            <>
              <p className={`${s.keyPoints.length ? 'mt-4' : 'mt-0'} ${h2}`}>향후 전망</p>
              <p className="my-1.5">{renderRich(s.forecast)}</p>
            </>
          )}
        </>
      )}

      {hasMid && hasQ && <hr className="my-8 border-t border-gray-200" />}

      {/* 의문점 + 후속 프롬프트 */}
      {hasQ && (
        <>
          <p className={`${hasMid ? 'mt-0' : ''} ${h2}`}>의문점</p>
          <ol className="my-1.5 ml-5 list-decimal space-y-3">
            {s.questions.map((q, i) => (
              <li key={i} className="pl-1">
                <div>{renderRich(q.question)}</div>
                {q.prompt && <PromptBox text={q.prompt} />}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
};

// ── 지역별 탭 보고서 ────────────────────────────────────────
// 모델 출력의 `===TAB: 라벨===` 구분선으로 본문을 탭 단위로 나눈다.
// 구분선이 없으면 전체를 단일 보고서로 본다(구버전·자유 모델 호환).

export interface ReportTab {
  label: string;
  body: string;
}

const TAB_RE = /^={2,}\s*TAB\s*:\s*(.+?)\s*={2,}\s*$/gim;

export function parseReportTabs(md: string): ReportTab[] {
  const text = md.replace(/\r\n/g, '\n');
  const matches = [...text.matchAll(TAB_RE)];
  if (matches.length === 0) return [{ label: '분석', body: text.trim() }];

  const tabs: ReportTab[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const start = cur.index! + cur[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
    const body = text.slice(start, end).trim();
    if (body) tabs.push({ label: cur[1]!.trim(), body });
  }
  return tabs.length ? tabs : [{ label: '분석', body: text.trim() }];
}

export const AnalysisReport: React.FC<{
  text: string;
  scale?: number;
  onActiveChange?: (tab: ReportTab) => void;
}> = ({ text, scale = 1, onActiveChange }) => {
  const tabs = useMemo(() => parseReportTabs(text), [text]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    setActive(0);
  }, [text]);

  const idx = Math.min(active, tabs.length - 1);
  const cur = tabs[idx]!;

  // 활성 탭이 바뀌면 부모에 알린다(Q&A 컨텍스트를 현재 탭으로 좁히기 위함).
  useEffect(() => {
    onActiveChange?.(cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur.label, cur.body]);

  return (
    <div>
      {tabs.length > 1 && (
        <div className="sticky top-0 z-10 -mx-5 mb-3 flex gap-1 overflow-x-auto border-b border-gray-200 bg-white/95 px-5 pb-0 backdrop-blur">
          {tabs.map((t, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
                i === idx
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <StructuredReport body={cur.body} scale={scale} />
    </div>
  );
};
