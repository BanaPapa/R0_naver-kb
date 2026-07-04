// 사용자 저장 데이터(저장된 분석·차트 슬롯) ↔ Supabase 계정 동기화.
//
// 구조: kb_user_state 테이블에 계정당 1행 — 전체 상태를 통째로 upsert.
//   - 로그인 시: 클라우드 상태를 내려받아 로컬(localStorage)과 병합 후 양쪽 반영.
//     · 분석: id 기준 합집합(양쪽에 있으면 클라우드 우선), 최신순 정렬
//     · 슬롯: 인덱스별 updatedAt 이 최신인 쪽 채택
//     → 기존에 브라우저에만 있던 항목이 첫 로그인 때 자동으로 계정에 이관된다.
//   - 이후: 두 스토어의 모든 변경을 디바운스(2초) 후 통째로 업로드.
//   - 비로그인: 기존 그대로 localStorage 만 사용(업로드 없음).
//
// 시작점: App 루트에서 startUserDataSync() 1회 호출.

import { supabase } from '../../../services/supabase';
import { useSavedStore } from '../../features/analysis/model/saved-store';
import { useSlotStore } from '../../features/chart-slots/model/slot-store';
import { SLOT_COUNT, type SlotEntry } from '../../features/chart-slots/model/types';
import type { SavedAnalysis } from '../../features/analysis/model/saved.types';

const TABLE = 'kb_user_state';
const PUSH_DEBOUNCE_MS = 2000;

let started = false;
let currentUserId: string | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let applyingRemote = false; // 클라우드 → 스토어 반영 중 재업로드 방지

interface CloudState {
  saved_analyses: SavedAnalysis[];
  chart_slots: (SlotEntry | null)[];
}

// 분석 병합: id 합집합, 같은 id는 클라우드 우선, 생성일 내림차순.
function mergeAnalyses(cloud: SavedAnalysis[], local: SavedAnalysis[]): SavedAnalysis[] {
  const byId = new Map<string, SavedAnalysis>();
  for (const it of local) if (it?.id) byId.set(it.id, it);
  for (const it of cloud) if (it?.id) byId.set(it.id, it);
  return [...byId.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

// 슬롯 병합: 인덱스별로 updatedAt 이 최신인 쪽.
function mergeSlots(cloud: (SlotEntry | null)[], local: (SlotEntry | null)[]): (SlotEntry | null)[] {
  const out: (SlotEntry | null)[] = Array(SLOT_COUNT).fill(null);
  for (let i = 0; i < SLOT_COUNT; i++) {
    const c = cloud?.[i] ?? null;
    const l = local?.[i] ?? null;
    out[i] = !c ? l : !l ? c : (c.updatedAt ?? 0) >= (l.updatedAt ?? 0) ? c : l;
  }
  return out;
}

async function pushNow(): Promise<void> {
  if (!supabase || !currentUserId) return;
  const payload = {
    user_id: currentUserId,
    saved_analyses: useSavedStore.getState().items,
    chart_slots: useSlotStore.getState().slots,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from(TABLE).upsert(payload);
  if (error) console.warn('[user-data-sync] 업로드 실패:', error.message);
}

function schedulePush(): void {
  if (!currentUserId || applyingRemote) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void pushNow(), PUSH_DEBOUNCE_MS);
}

async function pullAndMerge(userId: string): Promise<void> {
  if (!supabase) return;
  const { data, error } = await supabase
    .from(TABLE)
    .select('saved_analyses, chart_slots')
    .eq('user_id', userId)
    .maybeSingle<CloudState>();
  if (error) {
    console.warn('[user-data-sync] 클라우드 로드 실패:', error.message);
    return; // 테이블 미생성 등 — 로컬 동작은 그대로 유지
  }

  const mergedItems = mergeAnalyses(data?.saved_analyses ?? [], useSavedStore.getState().items);
  const mergedSlots = mergeSlots(data?.chart_slots ?? [], useSlotStore.getState().slots);

  applyingRemote = true;
  try {
    useSavedStore.setState({ items: mergedItems });
    useSlotStore.setState({ slots: mergedSlots });
  } finally {
    applyingRemote = false;
  }
  // 병합 결과(로컬 전용 항목 포함)를 즉시 계정에 반영 — 첫 로그인 이관.
  await pushNow();
}

export function startUserDataSync(): void {
  if (started || !supabase) return;
  started = true;

  supabase.auth.onAuthStateChange((_event, session) => {
    const uid = session?.user?.id ?? null;
    if (uid && uid !== currentUserId) {
      currentUserId = uid;
      void pullAndMerge(uid);
    } else if (!uid) {
      // 로그아웃: 업로드만 중단. 로컬 데이터는 기기에 그대로 남긴다(비로그인 사용 지원).
      currentUserId = null;
      if (pushTimer) clearTimeout(pushTimer);
    }
  });

  useSavedStore.subscribe(schedulePush);
  useSlotStore.subscribe(schedulePush);
}
