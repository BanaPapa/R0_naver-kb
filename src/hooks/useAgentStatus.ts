import { useState, useEffect, useCallback } from 'react';
import {
  pingAgent,
  getCookieStatus,
  startNaverLogin,
  validateConnection,
  AgentStatus,
  CookieStatus,
  ValidateReason,
} from '../services/agentApi';

const POLL_INTERVAL_MS = 10_000;
// 10분마다 실제 Naver API 호출로 토큰 유효성 검증
const VALIDATE_INTERVAL_MS = 600_000;

export interface AgentStatusHook {
  status: AgentStatus;
  cookieReady: boolean;
  bearerReady: boolean;
  connectionValid: boolean | null;
  connectionReason: ValidateReason | null;
  loginLoading: boolean;
  loginError: string | null;
  loginJustSucceeded: boolean;
  recheck: () => Promise<CookieStatus | null>;
  triggerLogin: () => Promise<void>;
}

export function useAgentStatus(): AgentStatusHook {
  const [status, setStatus] = useState<AgentStatus>('unknown');
  const [cookieReady, setCookieReady] = useState(false);
  const [bearerReady, setBearerReady] = useState(false);
  const [connectionValid, setConnectionValid] = useState<boolean | null>(null);
  const [connectionReason, setConnectionReason] = useState<ValidateReason | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginJustSucceeded, setLoginJustSucceeded] = useState(false);

  const check = useCallback(async (): Promise<CookieStatus | null> => {
    const agentSt = await pingAgent();
    setStatus(agentSt);
    if (agentSt === 'running') {
      const cs = await getCookieStatus();
      setCookieReady(cs.hasCookies);
      setBearerReady(cs.hasBearer);
      return cs;
    } else {
      setCookieReady(false);
      setBearerReady(false);
      setConnectionValid(null);
      return null;
    }
  }, []);

  const validate = useCallback(async (): Promise<void> => {
    const agentSt = await pingAgent();
    if (agentSt !== 'running') return;
    const cs = await getCookieStatus();
    if (!cs.hasCookies) return;
    const result = await validateConnection();
    setConnectionValid(result.valid);
    setConnectionReason(result.valid ? null : result.reason);
  }, []);

  const triggerLogin = useCallback(async (): Promise<void> => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      await startNaverLogin();
      const cs = await check();
      if (cs?.hasCookies && cs?.hasBearer) {
        setLoginJustSucceeded(true);
        setTimeout(() => setLoginJustSucceeded(false), 5000);
      }
      await validate();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : '로그인 중 오류가 발생했습니다.');
    } finally {
      setLoginLoading(false);
    }
  }, [check, validate]);

  // 확장 설치·활성 여부 10초마다 감지
  useEffect(() => {
    void check();
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [check]);

  // 확장 활성 + 쿠키 있을 때만 10분마다 실제 토큰 검증
  useEffect(() => {
    if (status !== 'running' || !cookieReady) return;
    void validate();
    const id = setInterval(validate, VALIDATE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [status, cookieReady, validate]);

  return {
    status,
    cookieReady,
    bearerReady,
    connectionValid,
    connectionReason,
    loginLoading,
    loginError,
    loginJustSucceeded,
    recheck: check,
    triggerLogin,
  };
}
