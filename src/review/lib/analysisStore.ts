// AI 분석 결과 저장·관리 (localStorage). R7 analysisStore 포트.
import type { AnalysisResult, SavedAnalysis } from '../types';

const LS_KEY = 'r0_review_analysis_history';
const MAX_ITEMS = 100;

export function loadAnalyses(): SavedAnalysis[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persist(list: SavedAnalysis[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, MAX_ITEMS)));
  } catch {
    /* ignore quota errors */
  }
}

export function saveAnalysis(input: {
  aptName: string;
  provider: string;
  model: string;
  result: AnalysisResult;
}): SavedAnalysis {
  const list = loadAnalyses();
  const item: SavedAnalysis = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    aptName: input.aptName || '이름 없음',
    provider: input.provider,
    model: input.model,
    savedAt: new Date().toISOString(),
    result: input.result,
  };
  const next = [item, ...list].slice(0, MAX_ITEMS);
  persist(next);
  return item;
}

export function deleteAnalysis(id: string): SavedAnalysis[] {
  const next = loadAnalyses().filter((a) => a.id !== id);
  persist(next);
  return next;
}

export function clearAnalyses(): SavedAnalysis[] {
  persist([]);
  return [];
}
