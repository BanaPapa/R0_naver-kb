-- ============================================================
-- R6_Apply (지역별 청약현황) — Supabase schema
-- Runs in naver-kb's shared instance, so every table is `apply_` prefixed to
-- avoid colliding with naver-kb's tables (profiles / naver_slots / search_logs
-- / inquiries). Apply via the Supabase SQL editor (naver-kb has no migrations
-- folder; it ships plain supabase/*.sql files).
--
-- Purpose: applyhome drops 공고 from its search list after ~5 years, so this is
-- the permanent archive of 청약 data, plus a result cache, a daily 경쟁률
-- time-series, and per-user saved searches.
-- ============================================================

-- ── 단지/공고 master + latest summary + full detail ──────────
create table if not exists public.apply_announcements (
  id                       uuid primary key default gen_random_uuid(),
  house_manage_no          text not null,
  pblanc_no                text not null,
  supply_area_code         text,                 -- suplyAreaCode the page was crawled with (region filter)
  region                   text,                 -- display region name (예: '서울')
  house_name               text,
  constructor              text,
  notice_date              text,
  notice_month             text,                 -- 'YYYYMM' derived from notice_date (range filtering)
  subscription_period      text,
  announcement_date        text,
  total_units              integer,
  first_round_applications integer,
  average_competition_rate numeric,
  max_competition_rate     numeric,
  subscription_result      text,
  detail                   jsonb,                -- { competition, specialSupply, homepageUrl, noticeUrl, detailUrl }
  first_crawled_at         timestamptz not null default now(),
  last_crawled_at          timestamptz not null default now(),
  unique (house_manage_no, pblanc_no)
);

create index if not exists apply_announcements_month_idx  on public.apply_announcements (notice_month);
create index if not exists apply_announcements_region_idx on public.apply_announcements (supply_area_code);
create index if not exists apply_announcements_name_idx   on public.apply_announcements (house_name);

-- ── daily 경쟁률 time-series (one row per 단지 per day) ───────
create table if not exists public.apply_competition_snapshots (
  id                       uuid primary key default gen_random_uuid(),
  house_manage_no          text not null,
  pblanc_no                text not null,
  snapshot_date            date not null default current_date,
  average_competition_rate numeric,
  max_competition_rate     numeric,
  subscription_result      text,
  created_at               timestamptz not null default now(),
  unique (house_manage_no, pblanc_no, snapshot_date)
);

create index if not exists apply_snapshots_unit_idx
  on public.apply_competition_snapshots (house_manage_no, pblanc_no, snapshot_date);

-- ── per-user 저장 검색 / 즐겨찾기 ────────────────────────────
create table if not exists public.apply_saved_searches (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  label       text,
  query       jsonb not null,                    -- { region, startDate, endDate, keyword }
  created_at  timestamptz not null default now()
);

create index if not exists apply_saved_searches_user_idx on public.apply_saved_searches (user_id);

-- ── 저장 슬롯 (고정 20칸, 검색 결과 스냅샷) ──────────────────
-- naver_slots 패턴 이식: user_id + slot_index 가 충돌 키, data 에 ApplySavedSlot jsonb.
create table if not exists public.apply_slots (
  user_id     uuid not null references auth.users (id) on delete cascade,
  slot_index  integer not null,
  data        jsonb not null,                    -- ApplySavedSlot (meta + apartments snapshot)
  updated_at  timestamptz not null default now(),
  primary key (user_id, slot_index)
);

-- ============================================================
-- Row Level Security
-- 청약 data is public information: anyone may READ the archive. Writes happen
-- server-side with the service_role key (which bypasses RLS), so no write policy
-- is granted to anon/authenticated. Saved searches are private per user.
-- ============================================================

alter table public.apply_announcements         enable row level security;
alter table public.apply_competition_snapshots enable row level security;
alter table public.apply_saved_searches        enable row level security;
alter table public.apply_slots                 enable row level security;

-- archive: public read-only
drop policy if exists apply_announcements_read on public.apply_announcements;
create policy apply_announcements_read
  on public.apply_announcements for select
  using (true);

drop policy if exists apply_snapshots_read on public.apply_competition_snapshots;
create policy apply_snapshots_read
  on public.apply_competition_snapshots for select
  using (true);

-- saved searches: owner-scoped CRUD
drop policy if exists apply_saved_searches_select on public.apply_saved_searches;
create policy apply_saved_searches_select
  on public.apply_saved_searches for select
  using (auth.uid() = user_id);

drop policy if exists apply_saved_searches_insert on public.apply_saved_searches;
create policy apply_saved_searches_insert
  on public.apply_saved_searches for insert
  with check (auth.uid() = user_id);

drop policy if exists apply_saved_searches_delete on public.apply_saved_searches;
create policy apply_saved_searches_delete
  on public.apply_saved_searches for delete
  using (auth.uid() = user_id);

-- 저장 슬롯: owner-scoped CRUD (upsert 위해 insert+update 모두 필요)
drop policy if exists apply_slots_select on public.apply_slots;
create policy apply_slots_select
  on public.apply_slots for select
  using (auth.uid() = user_id);

drop policy if exists apply_slots_insert on public.apply_slots;
create policy apply_slots_insert
  on public.apply_slots for insert
  with check (auth.uid() = user_id);

drop policy if exists apply_slots_update on public.apply_slots;
create policy apply_slots_update
  on public.apply_slots for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists apply_slots_delete on public.apply_slots;
create policy apply_slots_delete
  on public.apply_slots for delete
  using (auth.uid() = user_id);
