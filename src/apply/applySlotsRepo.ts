import { supabase } from '../services/supabase';
import { ApplySavedSlot } from './types';

// apply_slots 테이블 접근 계층 (naver-kb의 naver_slots 패턴 이식).
// RLS가 user_id = auth.uid() 로 자동 격리하므로 select/delete 에는 user_id 를
// 명시하지 않아도 되고, upsert 충돌 키로만 사용한다.
const TABLE = 'apply_slots';

interface SlotRow {
  slot_index: number;
  data: ApplySavedSlot;
}

// 현재 로그인 사용자의 모든 슬롯 (index → slot)
export async function fetchSlots(): Promise<{ index: number; slot: ApplySavedSlot }[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select('slot_index, data')
    .order('slot_index', { ascending: true });
  if (error) throw error;
  return ((data as SlotRow[] | null) ?? []).map((r) => ({ index: r.slot_index, slot: r.data }));
}

// 지정 index 슬롯 저장(덮어쓰기). user_id 는 충돌 키로 명시.
export async function upsertSlot(userId: string, index: number, slot: ApplySavedSlot): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from(TABLE)
    .upsert({ user_id: userId, slot_index: index, data: slot }, { onConflict: 'user_id,slot_index' });
  if (error) throw error;
}

// 지정 index 슬롯 삭제 (RLS가 본인 행으로 한정)
export async function removeSlot(index: number): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from(TABLE).delete().eq('slot_index', index);
  if (error) throw error;
}
