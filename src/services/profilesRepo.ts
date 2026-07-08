import { supabase } from './supabase';

// 회원 승인 상태 / 권한
export type ProfileStatus = 'pending' | 'approved' | 'rejected';
export type ProfileRole = 'user' | 'admin';

export interface Profile {
  id: string;
  email: string | null;
  status: ProfileStatus;
  role: ProfileRole;
  name: string | null;
  company: string | null;
  position: string | null;
  phone: string | null;
  createdAt: string;
  // 관리자 목록(admin_list_members RPC)에서만 채워진다. 본인 프로필 조회에선 null.
  lastSignInAt: string | null;    // 마지막 로그인 시각 (없으면 미접속)
  emailConfirmedAt: string | null; // 이메일 인증 완료 시각 (null이면 미인증 → 로그인 불가)
}

interface ProfileRow {
  id: string;
  email: string | null;
  status: ProfileStatus;
  role: ProfileRole;
  name: string | null;
  company: string | null;
  position: string | null;
  phone: string | null;
  created_at: string;
}

const COLS = 'id, email, status, role, name, company, position, phone, created_at';

function toProfile(r: ProfileRow): Profile {
  return {
    id: r.id,
    email: r.email,
    status: r.status,
    role: r.role,
    name: r.name,
    company: r.company,
    position: r.position,
    phone: r.phone,
    createdAt: r.created_at,
    lastSignInAt: null,
    emailConfirmedAt: null,
  };
}

// admin_list_members RPC 행 (profiles + auth.users 조인)
interface MemberRow extends ProfileRow {
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
}

function toMember(r: MemberRow): Profile {
  return {
    ...toProfile(r),
    lastSignInAt: r.last_sign_in_at,
    emailConfirmedAt: r.email_confirmed_at,
  };
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

// 전체 회원 목록 (관리자 전용). auth.users의 마지막 로그인·이메일 인증 정보까지 함께 조회한다.
// RPC 내부에서 is_admin() 으로 관리자만 허용(비관리자는 0행).
export async function listProfiles(): Promise<Profile[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('admin_list_members');
  if (error) throw error;
  return ((data as MemberRow[] | null) ?? []).map(toMember);
}

// 회원 승인 상태 변경 (관리자 전용 — RLS 가 강제).
export async function setProfileStatus(id: string, status: ProfileStatus): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('profiles').update({ status }).eq('id', id);
  if (error) throw error;
}

// 회원 정보 수정 (관리자 전용 — RLS 가 강제).
export async function updateProfileInfo(
  id: string,
  fields: { name?: string; company?: string; position?: string; phone?: string },
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('profiles').update(fields).eq('id', id);
  if (error) throw error;
}
