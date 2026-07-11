// AI 리뷰 분석 — R7 /api/analyze의 프롬프트·응답 스키마를 재현하되,
// 호출은 R0 방식(POST /api/kb-analysis action:'chat', useProviderStore·sessionCredential·supabase 토큰)을 유지.
// R0 chat 엔드포인트는 원문 텍스트만 돌려주므로, 파싱·정규화·추세·신뢰도 계산을 클라이언트에서 수행한다.
import { supabase } from '../../services/supabase';
import { sessionCredential } from '../../kb/entities/provider/api/provider.api';
import { postAnalysis, pollAnalysis, type AnalysisRequest } from '../../kb/entities/analysis';
import type {
  AnalysisResult,
  AnalysisCategory,
  ResidentReview,
  SentimentCounts,
  TrendPoint,
  DataReliability,
} from '../types';

const DEV = import.meta.env.DEV;

// 모델과 무관하게 일관된 결과를 위해 고정 분류 체계 사용
const CATEGORIES = ['입지', '교통', '가격', '미래가치', '주거인프라', '관리·시설'];

const SYSTEM_PROMPT =
  '당신은 아파트 입주민 리뷰 분석 전문가입니다. 제공된 리뷰만 근거로 분석하고, 과장하거나 확인되지 않은 사실을 만들지 마세요. 반드시 요청된 JSON 형식으로만 응답하세요.';

function buildUserPrompt(reviews: ResidentReview[]): string {
  const N = reviews.length;
  const reviewTexts = reviews.map((r, i) => `[${i + 1}] ${r.content}`).join('\n');
  return `아래 입주민 리뷰 ${N}건을 분석하세요.

${reviewTexts}

반드시 아래 JSON 형식으로만 응답하세요 (설명·마크다운 없이 JSON만):
{
  "totalCount": ${N},
  "sentiment": { "positive": 0, "negative": 0, "neutral": 0 },
  "overallSentiment": "긍정",
  "summary": "전체 요약 2~3문장",
  "categories": [
    { "name": "입지",      "positive": ["긍정 요점"], "negative": ["부정 요점"] },
    { "name": "교통",      "positive": [], "negative": [] },
    { "name": "가격",      "positive": [], "negative": [] },
    { "name": "미래가치",  "positive": [], "negative": [] },
    { "name": "주거인프라","positive": [], "negative": [] },
    { "name": "관리·시설", "positive": [], "negative": [] }
  ],
  "reviewSentiments": ["긍정", "부정", "중립"],
  "confidence": { "score": 80, "reason": "판단 근거 한 문장" },
  "conclusion": "거주·투자 관점의 최종 결론 2~3문장"
}

규칙:
- "sentiment"의 positive+negative+neutral 정수 합은 반드시 ${N}이어야 합니다.
- "overallSentiment"는 "긍정" | "부정" | "중립" 중 하나.
- "categories"는 위 6개(${CATEGORIES.join(', ')})만 사용하고 새 분류를 만들지 마세요.
- 각 분류의 positive/negative에는 그 분류에 해당하는 핵심 요점만 20자 내외로 간결히 넣고, 없으면 빈 배열([]).
- "reviewSentiments"는 리뷰 순서대로 각 리뷰의 감성("긍정"/"부정"/"중립")을 나열한 배열이며 길이는 정확히 ${N}이어야 합니다.
- "confidence"는 이 분석에 대한 당신의 확신도입니다. score는 0~100 정수, reason은 그 근거 한 문장.
- 반드시 유효한 JSON 하나만 출력하세요.`;
}

// 리뷰별 감성 라벨(index-aligned) + 작성일 → 월별 추세 데이터
function buildTrend(reviews: ResidentReview[], labels: (string | null)[]): TrendPoint[] {
  const bins = new Map<string, { positive: number; negative: number; neutral: number }>();
  for (let i = 0; i < reviews.length; i += 1) {
    const raw = reviews[i]?.date;
    const label = labels[i];
    if (!raw || !label) continue;
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) continue;
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    if (!bins.has(key)) bins.set(key, { positive: 0, negative: 0, neutral: 0 });
    const b = bins.get(key)!;
    if (label === '긍정') b.positive += 1;
    else if (label === '부정') b.negative += 1;
    else b.neutral += 1;
  }
  return [...bins.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([period, v]) => ({ period, ...v, total: v.positive + v.negative + v.neutral }));
}

// 모델과 무관한 데이터 기반 신뢰도(0~100): 표본 수 + 분류 커버리지 + 감성 명확성
function computeDataReliability(N: number, classified: number, sentiment: SentimentCounts): DataReliability {
  const { positive, negative, neutral } = sentiment;
  const volume = Math.min(1, N / 100);
  const coverage = N ? classified / N : 0;
  const total = positive + negative + neutral;
  const decisiveness = total ? Math.abs(positive - negative) / total : 0;
  const score = Math.round(100 * (0.5 * volume + 0.3 * coverage + 0.2 * decisiveness));
  const level: DataReliability['level'] = score >= 75 ? '높음' : score >= 50 ? '보통' : '낮음';
  return {
    score,
    level,
    factors: {
      volume: Math.round(volume * 100),
      coverage: Math.round(coverage * 100),
      decisiveness: Math.round(decisiveness * 100),
    },
  };
}

interface ParsedResponse {
  sentiment?: Partial<SentimentCounts>;
  overallSentiment?: string;
  summary?: string;
  categories?: { name?: string; positive?: unknown; negative?: unknown }[];
  reviewSentiments?: unknown;
  confidence?: { score?: unknown; reason?: unknown };
  conclusion?: string;
}

// 원문 텍스트 → 정규화된 AnalysisResult (R7 route.js 후처리 재현)
function normalize(
  rawResponse: string,
  reviews: ResidentReview[],
  provider: string,
  model: string,
): AnalysisResult {
  const N = reviews.length;

  let parsed: ParsedResponse;
  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawResponse) as ParsedResponse;
  } catch {
    // 파싱 실패 → 원문 텍스트를 요약으로 폴백
    parsed = {
      sentiment: { positive: 0, negative: 0, neutral: N },
      overallSentiment: '중립',
      summary: rawResponse,
      categories: [],
      reviewSentiments: [],
      confidence: { score: 0, reason: '응답 파싱 실패' },
      conclusion: '',
    };
  }

  // 감성 카운트 보정
  const s = parsed.sentiment ?? {};
  const sentiment: SentimentCounts = {
    positive: Math.max(0, Number(s.positive) || 0),
    negative: Math.max(0, Number(s.negative) || 0),
    neutral: Math.max(0, Number(s.neutral) || 0),
  };
  const sum = sentiment.positive + sentiment.negative + sentiment.neutral;
  if (sum !== N) sentiment.neutral = Math.max(0, sentiment.neutral + (N - sum));

  // 분류 순서·구조 보장
  const byName = new Map((parsed.categories ?? []).map((c) => [c.name, c]));
  const categories: AnalysisCategory[] = CATEGORIES.map((name) => {
    const c = byName.get(name) ?? {};
    return {
      name,
      positive: Array.isArray(c.positive) ? (c.positive as unknown[]).filter(Boolean).map(String) : [],
      negative: Array.isArray(c.negative) ? (c.negative as unknown[]).filter(Boolean).map(String) : [],
    };
  });

  // 리뷰별 감성 라벨 정규화(길이 N) → 추세선·데이터 신뢰도
  const rawLabels = Array.isArray(parsed.reviewSentiments) ? (parsed.reviewSentiments as unknown[]) : [];
  const labels = Array.from({ length: N }, (_, i) => {
    const v = rawLabels[i];
    return v === '긍정' || v === '부정' || v === '중립' ? (v as string) : null;
  });
  const classified = labels.filter(Boolean).length;
  const trend = buildTrend(reviews, labels);
  const dataReliability = computeDataReliability(N, classified, sentiment);

  const conf = parsed.confidence ?? {};
  const confidence = {
    score: Math.max(0, Math.min(100, Math.round(Number(conf.score) || 0))),
    reason: typeof conf.reason === 'string' ? conf.reason : '',
  };

  return {
    totalCount: N,
    reviewCount: N,
    sentiment,
    overallSentiment: parsed.overallSentiment ?? '중립',
    summary: parsed.summary ?? '',
    categories,
    conclusion: parsed.conclusion ?? '',
    trend,
    dataReliability,
    confidence,
    provider,
    model,
    analyzedAt: new Date().toISOString(),
  };
}

// chat 호출 — 환경별 분기 (KB 분석 모듈과 동일 규칙):
//  - 개발(DEV): vite 브리지(/api/analysis) 큐 + 폴링. 러너가 kind==='chat'의 system/user를 그대로 사용.
//  - 배포(PROD): 서버리스(/api/kb-analysis) 동기 호출.
async function callChat(provider: string, model: string, system: string, user: string): Promise<string> {
  if (DEV) {
    // 러너가 디스크(.analysis/providers)의 자격증명으로 실행하므로 클라이언트 자격증명 첨부 불필요.
    const payload = {
      kind: 'chat',
      generatedAt: new Date().toISOString(),
      provider,
      model,
      system,
      user,
    };
    // postAnalysis는 AnalysisRequest|AskRequest 타입만 받지만 런타임은 JSON을 그대로 전달한다.
    const id = await postAnalysis(payload as unknown as AnalysisRequest);
    const result = await pollAnalysis(id);
    return result.result ?? '';
  }

  const credential = sessionCredential(provider);
  const accessToken = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;

  const res = await fetch('/api/kb-analysis', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({
      action: 'chat',
      provider,
      model,
      system,
      user,
      ...(credential ? { credential } : {}),
    }),
  });

  const body = (await res.json().catch(() => ({}))) as { result?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? 'AI 분석에 실패했습니다.');
  return body.result ?? '';
}

// 리뷰 분석 실행 — chat 호출 후 클라이언트 정규화.
export async function analyzeReviews(
  reviews: ResidentReview[],
  provider: string,
  model: string,
): Promise<AnalysisResult> {
  const rawResponse = await callChat(provider, model, SYSTEM_PROMPT, buildUserPrompt(reviews));
  return normalize(rawResponse, reviews, provider, model);
}
