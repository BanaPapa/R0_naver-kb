import { callExtension } from '../services/extensionBridge';

export interface ResidentReview {
  id: string | null;
  content: string;
  date: string | null;
  score: number | null;
}

export async function collectResidentReviews(
  aptId: string,
  maxCount: number,
  onProgress?: (count: number) => void,
): Promise<{ ok: boolean; error?: string; reviews: ResidentReview[] }> {
  const reviews: ResidentReview[] = [];
  for (let page = 1; page <= 40 && reviews.length < maxCount; page += 1) {
    const response = await callExtension<any>('HGNN_FETCH_REVIEW_PAGE', { aptId, page }, 25_000);
    if (!response?.ok) return { ok: false, error: response?.error ?? 'UNKNOWN', reviews };
    const rows = response.data?.data?.data;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      if (reviews.length >= maxCount) break;
      reviews.push({
        id: row.id ? String(row.id) : null,
        content: String(row.content ?? row.text ?? row.body ?? ''),
        date: row.createdAt ?? row.date ?? row.created_at ?? null,
        score: Number.isFinite(Number(row.score ?? row.rating)) ? Number(row.score ?? row.rating) : null,
      });
    }
    onProgress?.(reviews.length);
    if (response.data?.data?.isEnd) break;
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  return { ok: true, reviews };
}
