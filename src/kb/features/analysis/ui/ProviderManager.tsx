import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { PROVIDERS, useProviderStore, getStorageMode, setStorageMode, type StorageMode } from '../../../entities/provider';

interface ProviderManagerProps {
  onBack: () => void;
}

type FormState =
  | { id: string; kind: 'apiKey' | 'token' | 'oauthCode'; state?: string }
  | null;

// device-code 진행 상태(OpenAI 배포 구독): 코드 표시 + 폴링.
interface DeviceState {
  id: string;
  state: string;
  userCode: string;
  verificationUrl: string;
}

export const ProviderManager: React.FC<ProviderManagerProps> = ({ onBack }) => {
  const statuses = useProviderStore(s => s.statuses);
  const refreshProviders = useProviderStore(s => s.refreshProviders);
  const saveApiKey = useProviderStore(s => s.saveApiKey);
  const saveSessionToken = useProviderStore(s => s.saveSessionToken);
  const startOAuth = useProviderStore(s => s.startOAuth);
  const startOAuthCode = useProviderStore(s => s.startOAuthCode);
  const submitOAuthCode = useProviderStore(s => s.submitOAuthCode);
  const startDeviceCode = useProviderStore(s => s.startDeviceCode);
  const pollDeviceCode = useProviderStore(s => s.pollDeviceCode);
  const disconnect = useProviderStore(s => s.disconnect);

  const isProd = !import.meta.env.DEV;
  const [openForm, setOpenForm] = useState<FormState>(null);
  const [value, setValue] = useState('');
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<StorageMode>(getStorageMode());
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { void refreshProviders(); }, [refreshProviders]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'oauth-done') void refreshProviders();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refreshProviders]);

  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current); }, []);

  const changeMode = (m: StorageMode) => { setStorageMode(m); setMode(m); void refreshProviders(); };

  const submit = async () => {
    if (!openForm || !value.trim()) return;
    setError(null);
    try {
      if (openForm.kind === 'apiKey') await saveApiKey(openForm.id, value.trim());
      else if (openForm.kind === 'token') await saveSessionToken(openForm.id, value.trim());
      else await submitOAuthCode(openForm.id, openForm.state ?? '', value.trim());
      setOpenForm(null);
      setValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장 실패');
    }
  };

  // oauth-code(xAI): 새 창에서 동의 → 코드 복사 → 붙여넣기 폼.
  const beginOAuthCode = async (id: string) => {
    setError(null);
    try {
      const state = await startOAuthCode(id);
      setOpenForm({ id, kind: 'oauthCode', state });
      setValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '구독 인증 시작 실패');
    }
  };

  // device-code(OpenAI): 코드 표시 + 승인 페이지 열기 + 폴링 시작.
  const beginDeviceCode = async (id: string) => {
    setError(null);
    setBusy(id);
    try {
      const d = await startDeviceCode(id);
      setDevice({ id, state: d.state, userCode: d.userCode, verificationUrl: d.verificationUrl });
      window.open(d.verificationUrl, 'device-login', 'width=520,height=720');
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = setInterval(async () => {
        try {
          const r = await pollDeviceCode(id, d.state);
          if (!r.pending) {
            if (pollTimer.current) clearInterval(pollTimer.current);
            setDevice(null);
            setBusy(null);
          }
        } catch (e) {
          if (pollTimer.current) clearInterval(pollTimer.current);
          setError(e instanceof Error ? e.message : '승인 확인 실패');
          setDevice(null);
          setBusy(null);
        }
      }, Math.max(3, d.interval) * 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : '구독 인증 시작 실패');
      setBusy(null);
    }
  };

  // 프로바이더별 구독 버튼 — 배포/개발 모두에서 흐름 종류로 노출한다.
  // (device-code·oauth-code·oauth-pkce는 배포 작동. oauth-loopback·session-token은 로컬 전용.)
  const subscriptionButton = (id: string, kind?: string) => {
    if (kind === 'device-code') return <button onClick={() => void beginDeviceCode(id)} disabled={busy === id} className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50">{busy === id ? '대기 중…' : '구독으로 로그인'}</button>;
    if (kind === 'oauth-code') return <button onClick={() => void beginOAuthCode(id)} className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50">구독으로 로그인</button>;
    if (kind === 'oauth-pkce') return <button onClick={() => void startOAuth(id)} className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50">구독으로 로그인</button>;
    // 로컬 전용 흐름은 배포에서 숨김
    if (!isProd && (kind === 'oauth-loopback')) return <button onClick={() => void startOAuth(id)} className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50">구독으로 로그인</button>;
    return null;
  };

  return (
    <div className="space-y-3">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-4 w-4" /> 돌아가기
      </button>

      {/* 저장 위치 선택 — 배포에서만 의미가 있다(로컬은 파일 저장 고정) */}
      {isProd && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <p className="mb-2 text-sm font-semibold text-gray-700">키·구독 저장 위치</p>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input type="radio" name="storeMode" checked={mode === 'session'} onChange={() => changeMode('session')} className="mt-0.5" />
              <span><b>이번만 사용</b> — 이 브라우저 탭에만 보관하고 서버에 저장하지 않습니다(탭을 닫으면 사라짐).</span>
            </label>
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input type="radio" name="storeMode" checked={mode === 'account'} onChange={() => changeMode('account')} className="mt-0.5" />
              <span><b>내 계정에 저장</b> — 로그인 계정에 안전하게 저장해 다른 기기에서도 사용합니다(본인만 접근).</span>
            </label>
          </div>
          <p className="mt-2 text-xs text-gray-400">어느 경우든 분석은 회원님의 키·구독으로 실행되며, 다른 사용자와 공유되지 않습니다.</p>
        </div>
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {/* device-code 진행 카드 */}
      {device && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
          <p className="font-semibold text-blue-800">1회용 코드: <span className="font-mono text-lg tracking-widest">{device.userCode}</span></p>
          <p className="mt-1 text-blue-700">열린 창(또는 <a href={device.verificationUrl} target="_blank" rel="noreferrer" className="underline">이 링크</a>)에서 위 코드를 입력하고 승인하세요. 승인되면 자동으로 완료됩니다.</p>
        </div>
      )}

      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
        {PROVIDERS.filter(p => p.apiShape !== 'claude-bridge').map(p => {
          const st = statuses[p.id];
          const sub = p.subscription;
          return (
            <li key={p.id} className="flex flex-col gap-2 p-3">
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900">{p.label}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs ${st?.connected ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                  {st?.connected ? '연결됨' : '미연결'}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  {p.auth.includes('apiKey') && (
                    <button onClick={() => { setOpenForm({ id: p.id, kind: 'apiKey' }); setValue(''); setError(null); }} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">API 키</button>
                  )}
                  {p.auth.includes('subscription') && subscriptionButton(p.id, sub?.kind)}
                  {st?.connected && (
                    <button aria-label={`${p.id} 연결해제`} onClick={() => void disconnect(p.id)} className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">연결해제</button>
                  )}
                </div>
              </div>

              {openForm?.id === p.id && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      placeholder={openForm.kind === 'apiKey' ? 'API 키 입력' : openForm.kind === 'oauthCode' ? '발급된 코드 붙여넣기' : '구독 토큰 입력'}
                      value={value}
                      onChange={e => setValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
                      className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                    <button onClick={() => void submit()} className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700">저장</button>
                    <button onClick={() => { setOpenForm(null); setError(null); }} className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-600">취소</button>
                  </div>
                  {openForm.kind === 'token' && sub?.tokenHint && <p className="text-xs text-gray-400">{sub.tokenHint}</p>}
                  {openForm.kind === 'oauthCode' && <p className="text-xs text-gray-400">새 창에서 로그인 후 표시된 코드를 복사해 붙여넣으세요.</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
