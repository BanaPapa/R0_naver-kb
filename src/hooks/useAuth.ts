import { useState, useEffect, useCallback, useRef } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../services/supabase';
import { fetchMyProfile, type Profile } from '../services/profilesRepo';

export interface AuthState {
  configured: boolean;      // Supabase 키 설정 여부
  loading: boolean;         // 초기 세션 복원 중
  session: Session | null;
  user: User | null;
  profile: Profile | null;  // 승인 상태/권한 (status, role)
  profileLoading: boolean;  // 로그인 후 프로필 조회 중
}

// 이메일/비밀번호 인증 + 승인 프로필 상태. Supabase 미설정 시 모든 동작은 안전하게 no-op.
export function useAuth() {
  const [state, setState] = useState<AuthState>({
    configured: isSupabaseConfigured,
    loading: isSupabaseConfigured, // 설정된 경우에만 세션 복원 대기
    session: null,
    user: null,
    profile: null,
    profileLoading: false,
  });

  // 현재 user.id 기준으로만 프로필 적용 (경쟁 상태 방지)
  const userIdRef = useRef<string | null>(null);

  const loadProfile = useCallback(async (uid: string | null) => {
    userIdRef.current = uid;
    if (!uid) {
      setState((s) => ({ ...s, profile: null, profileLoading: false }));
      return;
    }
    setState((s) => ({ ...s, profileLoading: true }));
    try {
      const profile = await fetchMyProfile();
      if (userIdRef.current !== uid) return; // 그 사이 사용자 변경됨 → 폐기
      setState((s) => ({ ...s, profile, profileLoading: false }));
    } catch (err) {
      console.error('프로필 조회 실패:', err);
      if (userIdRef.current !== uid) return;
      setState((s) => ({ ...s, profile: null, profileLoading: false }));
    }
  }, []);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user ?? null;
      setState((s) => ({ ...s, loading: false, session: data.session, user }));
      loadProfile(user?.id ?? null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      setState((s) => ({ ...s, loading: false, session, user }));
      loadProfile(user?.id ?? null);
    });

    return () => sub.subscription.unsubscribe();
  }, [loadProfile]);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) throw new Error('Supabase가 설정되지 않았습니다.');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    if (!supabase) throw new Error('Supabase가 설정되지 않았습니다.');
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    // 이메일 확인이 켜져 있으면 session=null (확인 메일 발송됨)
    return { needsEmailConfirm: !data.session };
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  }, []);

  // 관리자 승인 후 사용자가 새로고침 없이 상태를 갱신할 수 있도록
  const reloadProfile = useCallback(() => {
    loadProfile(userIdRef.current);
  }, [loadProfile]);

  return { ...state, signIn, signUp, signOut, reloadProfile };
}
