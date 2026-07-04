-- AI 분석 프로바이더 자격증명 — 사용자 본인 계정에 귀속 (BYOK: Bring Your Own Key)
-- 적용 방법: Supabase 대시보드 → SQL Editor → 붙여넣기 → Run
--
-- 각 로그인 사용자가 자신의 API 키를 연결해 자신의 비용으로 분석을 실행한다.
-- RLS로 본인 행만 접근 가능. 서버(api/kb-analysis)는 사용자 JWT로 대신 조회하므로
-- 키가 다른 사용자·클라이언트에 노출되지 않는다.

create table if not exists public.kb_user_providers (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider_id text not null,
  credential jsonb not null, -- { method: 'apiKey'|'subscription', apiKey?/token? }
  updated_at timestamptz not null default now(),
  primary key (user_id, provider_id)
);

alter table public.kb_user_providers enable row level security;

drop policy if exists "kb_user_providers_select_own" on public.kb_user_providers;
create policy "kb_user_providers_select_own" on public.kb_user_providers
  for select using (auth.uid() = user_id);

drop policy if exists "kb_user_providers_insert_own" on public.kb_user_providers;
create policy "kb_user_providers_insert_own" on public.kb_user_providers
  for insert with check (auth.uid() = user_id);

drop policy if exists "kb_user_providers_update_own" on public.kb_user_providers;
create policy "kb_user_providers_update_own" on public.kb_user_providers
  for update using (auth.uid() = user_id);

drop policy if exists "kb_user_providers_delete_own" on public.kb_user_providers;
create policy "kb_user_providers_delete_own" on public.kb_user_providers
  for delete using (auth.uid() = user_id);
