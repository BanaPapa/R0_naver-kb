import { callExtension } from '../services/extensionBridge';
import type { ResidentReview } from './types';

export type { ResidentReview } from './types';

interface RawReview {
  id?: string | number;
  reviewId?: string | number;
  content?: string;
  text?: string;
  body?: string;
  createdAt?: string;
  date?: string;
  created_at?: string;
  score?: number | string;
  rating?: number | string;
  aptId?: string;
}

function normalizeReview(raw: RawReview): ResidentReview {
  const rawScore = raw.score ?? raw.rating;
  const rawId = raw.id ?? raw.reviewId;
  return {
    reviewId: rawId != null ? String(rawId) : null,
    content: String(raw.content ?? raw.text ?? raw.body ?? ''),
    date: raw.createdAt ?? raw.date ?? raw.created_at ?? null,
    score: Number.isFinite(Number(rawScore)) ? Number(rawScore) : null,
    aptId: raw.aptId ?? null,
  };
}

// 확장 릴레이로 단지 리뷰를 페이지 단위로 수집.
// R7 hgnnBridge.collectReviews와 동작 일치: 페이지 캡 40, 요청 간 200ms 딜레이.
// maxCount는 호출부에서 '전체'(0) → 9999로 변환해 넘긴다.
export async function collectResidentReviews(
  aptId: string,
  maxCount: number,
  onProgress?: (count: number) => void,
): Promise<{ ok: boolean; error?: string; reviews: ResidentReview[] }> {
  const all: ResidentReview[] = [];
  let page = 1;
  const MAX_PAGES = 40;

  while (all.length < maxCount && page <= MAX_PAGES) {
    let response: { ok?: boolean; error?: string; data?: { data?: { data?: unknown; isEnd?: boolean } } };
    try {
      response = await callExtension('HGNN_FETCH_REVIEW_PAGE', { aptId, page }, 25_000);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'TIMEOUT', reviews: all };
    }
    if (!response?.ok) return { ok: false, error: response?.error ?? 'UNKNOWN', reviews: all };

    const rows = response.data?.data?.data;
    if (!Array.isArray(rows) || rows.length === 0) break;

    const remaining = maxCount - all.length;
    all.push(...rows.slice(0, remaining).map((r) => normalizeReview(r as RawReview)));
    onProgress?.(all.length);

    if (response.data?.data?.isEnd || all.length >= maxCount) break;
    page += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return { ok: true, reviews: all };
}
