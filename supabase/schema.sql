-- ============================================================
-- 매물시세 앱 — Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 실행하세요.
-- ============================================================

-- ============================================================
-- 회원 프로필 + 관리자 승인제
--   가입 → pending → 관리자 승인 → approved 만 앱 사용 가능.
--   첫 가입자는 자동으로 admin + approved (부트스트랩).
-- ============================================================
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  role        text not null default 'user'    check (role   in ('user', 'admin')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 신규 auth.users 생성 시 프로필 자동 생성.
-- 첫 사용자(=프로필 0건)는 admin+approved 로 부트스트랩, 이후는 user+pending.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  is_first boolean;
begin
  select count(*) = 0 into is_first from public.profiles;
  insert into public.profiles (id, email, role, status)
  values (
    new.id,
    new.email,
    case when is_first then 'admin'    else 'user'    end,
    case when is_first then 'approved' else 'pending' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 관리자 판별 헬퍼. SECURITY DEFINER 로 RLS 를 우회해 정책 내 재귀를 방지한다.
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and status = 'approved'
  );
$$;

-- updated_at 자동 갱신 (slots 와 공용 함수, 아래에서 먼저 정의되므로 여기선 생략하고 슬롯 쪽 함수 재사용)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ── Row Level Security ──
alter table public.profiles enable row level security;

-- 본인 프로필 조회, 관리자는 전체 조회
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (id = auth.uid() or public.is_admin());

-- 트리거(SECURITY DEFINER)가 주로 생성하지만, 본인 행 보강 삽입 허용
drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles
  for insert with check (id = auth.uid());

-- status/role 변경은 관리자만 가능
drop policy if exists "profiles_update_admin" on public.profiles;
create policy "profiles_update_admin" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- 저장 슬롯 (사용자별 고정 20칸, 0~19)
create table if not exists public.naver_slots (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade default auth.uid(),
  slot_index  int  not null check (slot_index >= 0 and slot_index < 20),
  data        jsonb not null,                 -- SavedSlot 전체(meta/config/count/properties)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, slot_index)
);

-- updated_at 자동 갱신
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_naver_slots_touch on public.naver_slots;
create trigger trg_naver_slots_touch
  before update on public.naver_slots
  for each row execute function public.touch_updated_at();

-- ── Row Level Security: 본인 행만 접근 ──
alter table public.naver_slots enable row level security;

drop policy if exists "naver_slots_select_own" on public.naver_slots;
create policy "naver_slots_select_own" on public.naver_slots
  for select using (auth.uid() = user_id);

drop policy if exists "naver_slots_insert_own" on public.naver_slots;
create policy "naver_slots_insert_own" on public.naver_slots
  for insert with check (auth.uid() = user_id);

drop policy if exists "naver_slots_update_own" on public.naver_slots;
create policy "naver_slots_update_own" on public.naver_slots
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "naver_slots_delete_own" on public.naver_slots;
create policy "naver_slots_delete_own" on public.naver_slots
  for delete using (auth.uid() = user_id);
