import { supabase } from './supabase';

// 회원 승인 상태 / 권한
export type ProfileStatus = 'pending' | 'approved' | 'rejected';
export type ProfileRole = 'user' | 'admin';

export interface Profile {
  id: string;
  email: string | null;
  status: ProfileStatus;
  role: ProfileRole;
  createdAt: string;
}

interface ProfileRow {
  id: string;
  email: string | null;
  status: ProfileStatus;
  role: ProfileRole;
  created_at: string;
}

const COLS = 'id, email, status, role, created_at';

function toProfile(r: ProfileRow): Profile {
  return { id: r.id, email: r.email, status: r.status, role: r.role, createdAt: r.created_at };
}

// 현재 로그인 사용자의 프로필. 미설정/비로그인/행없음 → null.
export async function fetchMyProfile(): Promise<Profile | null> {
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select(COLS)
    .eq('id', uid)
    .maybeSingle();
  if (error) throw error;
  return data ? toProfile(data as ProfileRow) : null;
}

// 전체 회원 목록 (관리자 전용 — RLS 가 비관리자에게는 본인 행만 반환).
export async function listProfiles(): Promise<Profile[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select(COLS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data as ProfileRow[] | null) ?? []).map(toProfile);
}

// 회원 승인 상태 변경 (관리자 전용 — RLS 가 강제).
export async function setProfileStatus(id: string, status: ProfileStatus): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('profiles').update({ status }).eq('id', id);
  if (error) throw error;
}
