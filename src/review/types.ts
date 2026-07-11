// 입주민 리뷰 모듈 도메인 타입 (R7_Review 포트)

export interface ResidentReview {
  reviewId: string | null;
  content: string;
  date: string | null;
  score: number | null;
  aptId: string | null;
}

export interface Apartment {
  id: string;
  name: string;
  address?: string;
  dong?: string;
  type: string;
}

// 단지별 수집 결과 (R7 reviewsByApt[aptId] 구조와 동일)
export interface ReviewGroup {
  aptId: string;
  aptName: string;
  reviews: ResidentReview[];
}

export type ReviewsByApt = Record<string, ReviewGroup>;

// ── 분석 결과 (R7 /api/analyze 응답 스키마 재현) ──
export interface SentimentCounts {
  positive: number;
  negative: number;
  neutral: number;
}

export interface AnalysisCategory {
  name: string;
  positive: string[];
  negative: string[];
}

export interface TrendPoint {
  period: string;
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}

export interface DataReliability {
  score: number;
  level: '높음' | '보통' | '낮음';
  factors: { volume: number; coverage: number; decisiveness: number };
}

export interface ModelConfidence {
  score: number;
  reason: string;
}

export interface AnalysisResult {
  totalCount: number;
  reviewCount: number;
  sentiment: SentimentCounts;
  overallSentiment: string;
  summary: string;
  categories: AnalysisCategory[];
  conclusion: string;
  trend: TrendPoint[];
  dataReliability: DataReliability;
  confidence: ModelConfidence;
  provider: string;
  model: string;
  analyzedAt: string;
}

export interface AnalysisMeta {
  aptName: string;
  provider: string;
  model: string;
  savedAt?: string;
}

export interface SavedAnalysis {
  id: string;
  aptName: string;
  provider: string;
  model: string;
  savedAt: string;
  result: AnalysisResult;
}

// 리뷰 수집 진행 상태
export interface FetchProgress {
  current: number;
  total: number;
  aptName: string;
}
