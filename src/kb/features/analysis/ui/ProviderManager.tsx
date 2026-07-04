import React, { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { PROVIDERS, useProviderStore } from '../../../entities/provider';

interface ProviderManagerProps {
  onBack: () => void;
}

export const ProviderManager: React.FC<ProviderManagerProps> = ({ onBack }) => {
  const statuses = useProviderStore(s => s.statuses);
  const refreshProviders = useProviderStore(s => s.refreshProviders);
  const saveApiKey = useProviderStore(s => s.saveApiKey);
  const saveSessionToken = useProviderStore(s => s.saveSessionToken);
  const startOAuth = useProviderStore(s => s.startOAuth);
  const startOAuthCode = useProviderStore(s => s.startOAuthCode);
  const submitOAuthCode = useProviderStore(s => s.submitOAuthCode);
  const disconnect = useProviderStore(s => s.disconnect);

  const [openForm, setOpenForm] = useState<{ id: string; kind: 'apiKey' | 'token' | 'oauthCode'; state?: string } | null>(null);
  const [value, setValue] = useState('');

  useEffect(() => { void refreshProviders(); }, [refreshProviders]);

  // 구독 OAuth 콜백(새 창/loopback)이 끝나면 postMessage('oauth-done')로 알려온다 → 상태 갱신.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'oauth-done') void refreshProviders();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refreshProviders]);

  const submit = async () => {
    if (!openForm || !value.trim()) return;
    if (openForm.kind === 'apiKey') await saveApiKey(openForm.id, value.trim());
    else if (openForm.kind === 'token') await saveSessionToken(openForm.id, value.trim());
    else await submitOAuthCode(openForm.id, openForm.state ?? '', value.trim());
    setOpenForm(null);
    setValue('');
  };

  const beginOAuthCode = async (id: string) => {
    const state = await startOAuthCode(id);
    setOpenForm({ id, kind: 'oauthCode', state });
    setValue('');
  };

  // 배포에서는 구독 OAuth(콜백이 localhost 전용)를 쓸 수 없다 — API 키만 지원.
  const isProd = !import.meta.env.DEV;

  return (
    <div className="space-y-3">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-4 w-4" /> 돌아가기
      </button>

      {isProd && (
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">
          API 키는 회원님 계정에 안전하게 저장되며, 분석은 회원님의 키로 실행됩니다.
          구독(OAuth) 로그인은 로컬 앱에서만 지원됩니다.
        </p>
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
                    <button onClick={() => { setOpenForm({ id: p.id, kind: 'apiKey' }); setValue(''); }} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">API 키</button>
                  )}
                  {!isProd && p.auth.includes('subscription') && (sub?.kind === 'oauth-pkce' || sub?.kind === 'oauth-loopback') && (
                    <button onClick={() => void startOAuth(p.id)} className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50">구독으로 로그인</button>
                  )}
                  {!isProd && p.auth.includes('subscription') && sub?.kind === 'oauth-code' && (
                    <button onClick={() => void beginOAuthCode(p.id)} className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50">구독으로 로그인</button>
                  )}
                  {!isProd && p.auth.includes('subscription') && sub?.kind === 'session-token' && (
                    <button onClick={() => { setOpenForm({ id: p.id, kind: 'token' }); setValue(''); }} className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50">구독으로 로그인</button>
                  )}
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
                      className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                    <button onClick={() => void submit()} className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700">저장</button>
                    <button onClick={() => setOpenForm(null)} className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-600">취소</button>
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
