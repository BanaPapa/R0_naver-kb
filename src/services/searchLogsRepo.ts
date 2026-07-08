import { supabase } from './supabase';
import type { SearchMeta } from '../types';

// 검색 요약 로그 (결과 매물 제외). status 는 검색 진행 상태.
export type SearchLogStatus = 'running' | 'done' | 'error' | 'stopped';

// 어느 탭(앱)에서 발생한 검색인지 구분.
export type SearchApp = 'naver' | 'kbprice' | 'apply' | 'kb';

export interface SearchLog {
  id: string;
  userId: string;
  app: SearchApp;
  summary: string | null;    // 검색내용 한 줄 요약 (매물시세 외 탭용)
  largeName: string | null;
  midName: string | null;
  smallName: string | null;
  realEstateType: string | null;
  tradeType: string | null;
  areaLabel: string | null;
  status: SearchLogStatus;
  resultCount: number | null;
  errorMessage: string | null;
  createdAt: string;
  endedAt: string | null;
}

interface SearchLogRow {
  id: string;
  user_id: string;
  app: SearchApp | null;
  summary: string | null;
  large_name: string | null;
  mid_name: string | null;
  small_name: string | null;
  real_estate_type: string | null;
  trade_type: string | null;
  area_label: string | null;
  status: SearchLogStatus;
  result_count: number | null;
  error_message: string | null;
  created_at: string;
  ended_at: string | null;
}

const COLS =
  'id, user_id, app, summary, large_name, mid_name, small_name, real_estate_type, trade_type, area_label, status, result_count, error_message, created_at, ended_at';

function toSearchLog(r: SearchLogRow): SearchLog {
  return {
    id: r.id,
    userId: r.user_id,
    app: r.app ?? 'naver',
    summary: r.summary,
    largeName: r.large_name,
    midName: r.mid_name,
    smallName: r.small_name,
    realEstateType: r.real_estate_type,
    tradeType: r.trade_type,
    areaLabel: r.area_label,
    status: r.status,
    resultCount: r.result_count,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    endedAt: r.ended_at,
  };
}

// 검색 시작 시 'running' 행 삽입 → 생성된 id 반환. 실패/비로그인 시 null(검색은 계속 진행).
export async function startSearchLog(meta: SearchMeta): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth.user?.id;
    if (!uid) return null;
    const { data, error } = await supabase
      .from('search_logs')
      .insert({
        user_id: uid,
        app: 'naver',
        large_name: meta.largeName || null,
        mid_name: meta.midName || null,
        small_name: meta.smallName || null,
        real_estate_type: meta.realEstateType,
        trade_type: meta.tradeType || null,
        area_label: meta.areaLabel || null,
        status: 'running',
      })
      .select('id')
      .single();
    if (error) {
      console.warn('검색 로그 시작 기록 실패:', error.message);
      return null;
    }
    return (data as { id: string }).id;
  } catch (err) {
    console.warn('검색 로그 시작 기록 예외:', err);
    return null;
  }
}

// 검색 종료 시 같은 행을 종료 상태로 갱신. id 없으면(=시작 기록 실패) no-op.
export async function finishSearchLog(
  id: string | null,
  patch: { status: SearchLogStatus; resultCount?: number; errorMessage?: string },
): Promise<void> {
  if (!supabase || !id) return;
  try {
    const { error } = await supabase
      .from('search_logs')
      .update({
        status: patch.status,
        result_count: patch.resultCount ?? null,
        error_message: patch.errorMessage ?? null,
        ended_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) console.warn('검색 로그 종료 기록 실패:', error.message);
  } catch (err) {
    console.warn('검색 로그 종료 기록 예외:', err);
  }
}

// 매물시세 외 탭(KB시세/청약/KB분석)용 단발 검색 로그. 결과는 저장하지 않고
// '언제·어느 탭·무엇을' 한 줄(summary)만 즉시 기록한다(fire-and-forget, 실패해도 무시).
export async function logSearch(entry: {
  app: SearchApp;
  summary: string;
  resultCount?: number;
}): Promise<void> {
  if (!supabase) return;
  try {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth.user?.id;
    if (!uid) return;
    const { error } = await supabase.from('search_logs').insert({
      user_id: uid,
      app: entry.app,
      summary: entry.summary.slice(0, 300),
      status: 'done',
      result_count: entry.resultCount ?? null,
      ended_at: new Date().toISOString(),
    });
    if (error) console.warn('검색 로그 기록 실패:', error.message);
  } catch (err) {
    console.warn('검색 로그 기록 예외:', err);
  }
}

// 관리자: 특정 사용자의 최근 6개월 검색내역 (최신순).
export async function listSearchLogs(userId: string): Promise<SearchLog[]> {
  if (!supabase) return [];
  const since = new Date();
  since.setMonth(since.getMonth() - 6);
  const { data, error } = await supabase
    .from('search_logs')
    .select(COLS)
    .eq('user_id', userId)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data as SearchLogRow[] | null) ?? []).map(toSearchLog);
}
