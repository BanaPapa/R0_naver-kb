// 분석 보고서(한 탭 본문)를 구조화된 섹션으로 파싱한다.
// 모델 출력 형식(docs/analysis-prompt.md)을 따르되, 구버전/자유 출력도 견고하게 처리한다.
// 렌더러(StructuredReport)와 내보내기(export.ts)가 함께 사용한다.

// 핵심 내용 1건 + 그에 대한 판단 근거(1:1 대응).
export interface KeyPoint {
  point: string;
  basis?: string;
}

// 의문점 1건 + AI에게 그대로 붙여넣을 후속 질문 프롬프트.
export interface OpenQuestion {
  question: string;
  prompt?: string;
}

export interface TabStructure {
  conclusion: string; // 결론 문단
  insights: string[]; // 인사이트 항목
  keyPoints: KeyPoint[]; // 핵심 내용 + 판단 근거(인터리브)
  forecast: string; // 향후 전망 문단
  questions: OpenQuestion[]; // 의문점 + 프롬프트
  recognized: boolean; // 알려진 섹션을 하나라도 찾았는가(없으면 자유 마크다운으로 폴백)
}

interface Section {
  title: string;
  lines: string[];
}

// `## 제목` 단위로 본문을 섹션으로 자른다(첫 제목 앞 텍스트는 preamble).
function splitSections(body: string): { preamble: string[]; sections: Section[] } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const preamble: string[] = [];
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const raw of lines) {
    const h = /^#{1,3}\s+(.*)$/.exec(raw.trim());
    if (h) {
      cur = { title: h[1]!.trim(), lines: [] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(raw);
    } else {
      preamble.push(raw);
    }
  }
  return { preamble, sections };
}

const norm = (s: string): string => s.replace(/\s+/g, '');

// 순서 목록(1. 2.) 항목 추출. 이어지는 비목록 줄은 직전 항목에 합친다.
function orderedItems(lines: string[]): string[] {
  const items: string[] = [];
  for (const raw of lines) {
    const m = /^\s*\d+\.\s+(.*)$/.exec(raw);
    if (m) items.push(m[1]!.trim());
    else if (items.length && raw.trim()) items[items.length - 1] += ` ${raw.trim()}`;
  }
  return items;
}

// 비순서 목록(- *) 항목 추출.
function bulletItems(lines: string[]): string[] {
  const items: string[] = [];
  for (const raw of lines) {
    const m = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (m) items.push(m[1]!.trim());
    else if (items.length && raw.trim()) items[items.length - 1] += ` ${raw.trim()}`;
  }
  return items;
}

function paragraph(lines: string[]): string {
  return lines.map(l => l.trim()).filter(Boolean).join(' ');
}

// 의문점 섹션 파싱: 각 항목(번호/불릿)에 이어지는 `프롬프트:` 줄을 후속 프롬프트로 묶는다.
function parseQuestions(lines: string[]): OpenQuestion[] {
  const items: { q: string[]; prompt: string[] | null }[] = [];
  let cur: { q: string[]; prompt: string[] | null } | null = null;
  for (const raw of lines) {
    const promptLine = /^\s*(?:[-*]\s*)?프롬프트\s*[:：]\s*(.*)$/.exec(raw);
    const start = /^\s*(?:\d+\.|[-*])\s+(.*)$/.exec(raw);
    if (promptLine && cur) {
      cur.prompt = [promptLine[1]!.trim()];
    } else if (start) {
      cur = { q: [start[1]!.trim()], prompt: null };
      items.push(cur);
    } else if (cur && raw.trim()) {
      if (cur.prompt) cur.prompt.push(raw.trim());
      else cur.q.push(raw.trim());
    }
  }
  return items
    .map(it => ({
      question: it.q.join(' ').trim(),
      prompt: it.prompt ? it.prompt.join(' ').trim() : undefined,
    }))
    .filter(it => it.question);
}

// 한 탭 본문 → 구조화. 알려진 섹션이 하나도 없으면 recognized=false.
export function parseTabStructure(body: string): TabStructure {
  const { sections } = splitSections(body);
  let conclusion = '';
  let insights: string[] = [];
  let points: string[] = [];
  let bases: string[] = [];
  let forecast = '';
  let questions: OpenQuestion[] = [];
  let recognized = false;

  for (const sec of sections) {
    const t = norm(sec.title);
    if (t.includes('결론')) {
      conclusion = paragraph(sec.lines);
      recognized = true;
    } else if (t.includes('인사이트')) {
      insights = bulletItems(sec.lines);
      if (insights.length === 0) insights = orderedItems(sec.lines);
      recognized = true;
    } else if (t.includes('핵심내용') || t.includes('핵심정리') || t.includes('요약정리') || t.includes('요약')) {
      points = orderedItems(sec.lines);
      recognized = true;
    } else if (t.includes('판단근거') || t.includes('근거')) {
      bases = orderedItems(sec.lines);
      recognized = true;
    } else if (t.includes('전망') || t.includes('예측')) {
      forecast = paragraph(sec.lines);
      recognized = true;
    } else if (t.includes('의문')) {
      questions = parseQuestions(sec.lines);
      recognized = true;
    }
  }

  const keyPoints: KeyPoint[] = points.map((p, i) => ({ point: p, basis: bases[i] }));
  return { conclusion, insights, keyPoints, forecast, questions, recognized };
}
