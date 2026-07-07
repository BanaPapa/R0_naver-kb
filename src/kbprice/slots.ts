// KB시세 저장 슬롯 — 네이버 탭 useSlots/slotsRepo 와 동일 구조 (테이블만 kbprice_slots)
import { useState, useCallback, useEffect } from 'react';
import { supabase, isSupabaseConfigured } from '../services/supabase';
import { RegionSelection } from '../types';
import { KbSearchParams, ProcessedData, PriceType, KB_SPACE_OPTIONS } from './types';

export const MAX_KB_SLOTS = 20;

// 슬롯 목록 표기용 메타 (검색 조건 요약)
export interface KbSlotMeta {
  regionText: string;                    // "강남구 역삼동"
  propertyType: 1 | 2;                   // 1:아파트, 2:오피스텔
  dealType: KbSearchParams['dealType'];
  priceTypes: PriceType[];
  areaLabel: string;                     // "84타입" / "공급 59~112㎡" / "전체"
}

export interface KbSavedSlot {
  id: string;
  createdAt: number;
  meta: KbSlotMeta;
  params: KbSearchParams;   // 재검색용 전체 조건
  region: RegionSelection;  // 재검색용 지역 선택
  count: number;
  results: ProcessedData[];
}

export type KbSlotArray = (KbSavedSlot | null)[];

// 면적 조건을 사람이 읽기 쉬운 라벨로
export function buildKbAreaLabel(params: KbSearchParams): string {
  if (params.propertyType === 1 && params.areaMode === 'preset') {
    return KB_SPACE_OPTIONS[params.spaceIndex]?.label ?? '전체';
  }
  const basis = params.propertyType === 2 ? '전용' : '공급';
  if (params.areaMin <= 0 && params.areaMax <= 0) return '전체';
  return `${basis} ${params.areaMin || 0}~${params.areaMax > 0 ? params.areaMax : '∞'}㎡`;
}

export function buildKbSlotMeta(params: KbSearchParams, region: RegionSelection): KbSlotMeta {
  const regionText =
    [region.mid?.name, region.small?.name].map((s) => s?.trim()).filter(Boolean).join(' ') ||
    region.large?.name.trim() ||
    '-';
  return {
    regionText,
    propertyType: params.propertyType,
    dealType: params.dealType,
    priceTypes: params.priceTypes,
    areaLabel: buildKbAreaLabel(params),
  };
}

// ── Supabase repo (kbprice_slots — RLS 로 본인 행만 접근) ──────────────────
const TABLE = 'kbprice_slots';

interface SlotRowResult {
  slot_index: number;
  data: KbSavedSlot;
}

async function fetchKbSlots(): Promise<{ index: number; slot: KbSavedSlot }[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select('slot_index, data')
    .order('slot_index', { ascending: true });
  if (error) throw error;
  return ((data as SlotRowResult[] | null) ?? []).map((r) => ({ index: r.slot_index, slot: r.data }));
}

async function upsertKbSlot(userId: string, index: number, slot: KbSavedSlot): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from(TABLE)
    .upsert({ user_id: userId, slot_index: index, data: slot }, { onConflict: 'user_id,slot_index' });
  if (error) throw error;
}

async function removeKbSlot(index: number): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from(TABLE).delete().eq('slot_index', index);
  if (error) throw error;
}

// ── 훅 ─────────────────────────────────────────────────────────────────────
let _slotSeq = 0;

const emptySlots = (): KbSlotArray => Array(MAX_KB_SLOTS).fill(null);

function makeSlot(
  params: KbSearchParams,
  region: RegionSelection,
  results: ProcessedData[],
): KbSavedSlot {
  return {
    id: `kbslot-${++_slotSeq}-${Date.now()}`,
    createdAt: Date.now(),
    meta: buildKbSlotMeta(params, region),
    params,
    region,
    count: results.length,
    results,
  };
}

// 고정 20칸 저장 슬롯.
// 로그인(userId) + Supabase 설정 시 → kbprice_slots 테이블에 사용자별 영속.
// 미설정/비로그인 시 → 메모리에만 유지.
export function useKbSlots(userId: string | null) {
  const [slots, setSlots] = useState<KbSlotArray>(emptySlots);
  const useDb = isSupabaseConfigured && !!userId;

  useEffect(() => {
    if (!useDb) {
      setSlots(emptySlots());
      return;
    }
    let cancelled = false;
    fetchKbSlots()
      .then((rows) => {
        if (cancelled) return;
        const next = emptySlots();
        for (const { index, slot } of rows) {
          if (index >= 0 && index < MAX_KB_SLOTS) next[index] = slot;
        }
        setSlots(next);
      })
      .catch((err) => console.error('KB 슬롯 불러오기 실패:', err));
    return () => {
      cancelled = true;
    };
  }, [useDb, userId]);

  const saveAt = useCallback(
    (index: number, params: KbSearchParams, region: RegionSelection, results: ProcessedData[]) => {
      const slot = makeSlot(params, region, results);
      setSlots((prev) => {
        const next = [...prev];
        next[index] = slot;
        return next;
      });
      if (useDb && userId) {
        upsertKbSlot(userId, index, slot).catch((err) => {
          console.error('KB 슬롯 저장 실패:', err);
          alert(`슬롯 저장 실패: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    },
    [useDb, userId],
  );

  const saveFirstEmpty = useCallback(
    (params: KbSearchParams, region: RegionSelection, results: ProcessedData[]): number => {
      const idx = slots.findIndex((s) => s === null);
      if (idx === -1) return -1;
      saveAt(idx, params, region, results);
      return idx;
    },
    [slots, saveAt],
  );

  const deleteSlot = useCallback(
    (index: number) => {
      setSlots((prev) => {
        const next = [...prev];
        next[index] = null;
        return next;
      });
      if (useDb) {
        removeKbSlot(index).catch((err) => console.error('KB 슬롯 삭제 실패:', err));
      }
    },
    [useDb],
  );

  return { slots, saveAt, saveFirstEmpty, deleteSlot };
}
