-- KB시세 조회 탭 저장 슬롯 (naver_slots 와 동일 구조, 사용자별 고정 20칸)
-- 적용: Supabase Dashboard → SQL Editor 에서 실행

create table if not exists public.kbprice_slots (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade default auth.uid(),
  slot_index  int  not null check (slot_index >= 0 and slot_index < 20),
  data        jsonb not null,                 -- KbSavedSlot 전체(meta/params/region/count/results)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, slot_index)
);

-- updated_at 자동 갱신 (touch_updated_at 함수는 schema.sql 에서 이미 생성됨)
drop trigger if exists trg_kbprice_slots_touch on public.kbprice_slots;
create trigger trg_kbprice_slots_touch
  before update on public.kbprice_slots
  for each row execute function public.touch_updated_at();

-- ── Row Level Security: 본인 행만 접근 ──
alter table public.kbprice_slots enable row level security;

drop policy if exists "kbprice_slots_select_own" on public.kbprice_slots;
create policy "kbprice_slots_select_own" on public.kbprice_slots
  for select using (auth.uid() = user_id);

drop policy if exists "kbprice_slots_insert_own" on public.kbprice_slots;
create policy "kbprice_slots_insert_own" on public.kbprice_slots
  for insert with check (auth.uid() = user_id);

drop policy if exists "kbprice_slots_update_own" on public.kbprice_slots;
create policy "kbprice_slots_update_own" on public.kbprice_slots
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "kbprice_slots_delete_own" on public.kbprice_slots;
create policy "kbprice_slots_delete_own" on public.kbprice_slots
  for delete using (auth.uid() = user_id);
