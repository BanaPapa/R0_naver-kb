import { useState, useCallback, useEffect } from 'react';
import { ApplySavedSlot, ApplySearchMeta, ApplyApartment } from './types';
import { isSupabaseConfigured } from '../services/supabase';
import { fetchSlots, upsertSlot, removeSlot } from './applySlotsRepo';

export const MAX_SLOTS = 20;
const LS_KEY = 'apply_slots_v1';

let _slotSeq = 0;

export type SlotArray = (ApplySavedSlot | null)[];

const emptySlots = (): SlotArray => Array(MAX_SLOTS).fill(null);

function makeSlot(meta: ApplySearchMeta, count: number, apartments: ApplyApartment[]): ApplySavedSlot {
  return { id: `slot-${++_slotSeq}-${Date.now()}`, createdAt: Date.now(), meta, count, apartments };
}

// localStorage 영속 (게스트용)
function readLocal(): SlotArray {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return emptySlots();
    const arr = JSON.parse(raw) as SlotArray;
    const next = emptySlots();
    for (let i = 0; i < MAX_SLOTS; i++) next[i] = arr[i] ?? null;
    return next;
  } catch {
    return emptySlots();
  }
}

function writeLocal(slots: SlotArray): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(slots));
  } catch {
    /* 용량 초과 등 — 무시 (메모리 상태는 유지) */
  }
}

/**
 * 고정 20칸 저장 슬롯 (naver-kb useSlots 이식).
 * 로그인(userId) + Supabase 설정 시 → apply_slots 테이블에 사용자별 영속.
 * 그 외(게스트) → localStorage 에 영속(새로고침 후에도 유지).
 */
export function useApplySlots(userId: string | null) {
  const [slots, setSlots] = useState<SlotArray>(emptySlots);
  const useDb = isSupabaseConfigured && !!userId;

  useEffect(() => {
    if (!useDb) {
      setSlots(readLocal());
      return;
    }
    let cancelled = false;
    fetchSlots()
      .then((rows) => {
        if (cancelled) return;
        const next = emptySlots();
        for (const { index, slot } of rows) {
          if (index >= 0 && index < MAX_SLOTS) next[index] = slot;
        }
        setSlots(next);
      })
      .catch((err) => console.error('슬롯 불러오기 실패:', err));
    return () => { cancelled = true; };
  }, [useDb, userId]);

  const saveAt = useCallback(
    (index: number, meta: ApplySearchMeta, count: number, apartments: ApplyApartment[]) => {
      const slot = makeSlot(meta, count, apartments);
      setSlots((prev) => {
        const next = [...prev];
        next[index] = slot;
        if (!useDb) writeLocal(next);
        return next;
      });
      if (useDb && userId) {
        upsertSlot(userId, index, slot).catch((err) => {
          console.error('슬롯 저장 실패:', err);
          alert(`슬롯 저장 실패: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    },
    [useDb, userId],
  );

  const saveFirstEmpty = useCallback(
    (meta: ApplySearchMeta, count: number, apartments: ApplyApartment[]): number => {
      const idx = slots.findIndex((s) => s === null);
      if (idx === -1) return -1;
      saveAt(idx, meta, count, apartments);
      return idx;
    },
    [slots, saveAt],
  );

  const deleteSlot = useCallback(
    (index: number) => {
      setSlots((prev) => {
        const next = [...prev];
        next[index] = null;
        if (!useDb) writeLocal(next);
        return next;
      });
      if (useDb) {
        removeSlot(index).catch((err) => console.error('슬롯 삭제 실패:', err));
      }
    },
    [useDb],
  );

  return { slots, saveAt, saveFirstEmpty, deleteSlot };
}
