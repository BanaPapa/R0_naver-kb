-- KB 시계열 사용자 저장 데이터 (계정 연동)
-- 적용 방법: Supabase 대시보드 → SQL Editor → 이 파일 내용 붙여넣기 → Run
--
-- 설계: 계정당 1행에 저장된 분석 목록·차트 슬롯을 통째로 보관(jsonb).
-- 항목별 CRUD 대신 전체 상태 upsert — 단순하고, 이름변경/삭제가 자연히 반영되며,
-- 기기 간 병합은 클라이언트(user-data-sync)가 로그인 시 수행한다.

create table if not exists public.kb_user_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  saved_analyses jsonb not null default '[]'::jsonb, -- SavedAnalysis[]
  chart_slots jsonb not null default '[]'::jsonb,    -- (SlotEntry | null)[]
  updated_at timestamptz not null default now()
);

alter table public.kb_user_state enable row level security;

-- 본인 행만 읽기/쓰기 (RLS)
drop policy if exists "kb_user_state_select_own" on public.kb_user_state;
create policy "kb_user_state_select_own" on public.kb_user_state
  for select using (auth.uid() = user_id);

drop policy if exists "kb_user_state_insert_own" on public.kb_user_state;
create policy "kb_user_state_insert_own" on public.kb_user_state
  for insert with check (auth.uid() = user_id);

drop policy if exists "kb_user_state_update_own" on public.kb_user_state;
create policy "kb_user_state_update_own" on public.kb_user_state
  for update using (auth.uid() = user_id);

drop policy if exists "kb_user_state_delete_own" on public.kb_user_state;
create policy "kb_user_state_delete_own" on public.kb_user_state
  for delete using (auth.uid() = user_id);

-- KB 원본 데이터 버킷(kb-data)의 익명 읽기 보장.
-- 버킷은 public 이라 기본적으로 읽히지만, API 경로(download/signed URL)까지
-- 확실히 허용하도록 명시 정책을 둔다. (공개 통계 데이터 — 비밀 아님)
drop policy if exists "kb_data_public_read" on storage.objects;
create policy "kb_data_public_read" on storage.objects
  for select using (bucket_id = 'kb-data');
