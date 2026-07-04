import React, { useEffect, useMemo, useState } from 'react';
import { Settings, RefreshCw } from 'lucide-react';
import {
  PROVIDERS, getProvider, useProviderStore,
  sortModels, modelOptionLabel, MODEL_SORTS, DEFAULT_MODEL_SORT, type ModelSort,
} from '../../../entities/provider';

interface ProviderSelectorProps {
  onManage: () => void;
}

export const ProviderSelector: React.FC<ProviderSelectorProps> = ({ onManage }) => {
  const selectedProviderId = useProviderStore(s => s.selectedProviderId);
  const selectedModelId = useProviderStore(s => s.selectedModelId);
  const models = useProviderStore(s => s.models[selectedProviderId]) ?? [];
  const loading = useProviderStore(s => s.loadingModels[selectedProviderId] ?? false);
  const modelError = useProviderStore(s => s.modelErrors[selectedProviderId] ?? null);
  const select = useProviderStore(s => s.select);
  const refreshModels = useProviderStore(s => s.refreshModels);

  const [sort, setSort] = useState<ModelSort>(DEFAULT_MODEL_SORT);
  const sortedModels = useMemo(() => sortModels(models, sort), [models, sort]);

  const def = getProvider(selectedProviderId);
  const isBridge = def?.apiShape === 'claude-bridge';

  // 배포에서는 claude-bridge(로컬 Claude 세션 대행)를 쓸 수 없다 — 목록에서 제외하고,
  // 이전 세션에서 저장된 선택이 bridge면 첫 번째 사용 가능한 프로바이더로 자동 전환.
  const isProd = !import.meta.env.DEV;
  const visibleProviders = isProd ? PROVIDERS.filter(p => p.apiShape !== 'claude-bridge') : PROVIDERS;
  useEffect(() => {
    if (isProd && isBridge && visibleProviders[0]) select(visibleProviders[0].id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProd, isBridge]);

  useEffect(() => {
    if (!isBridge) void refreshModels(selectedProviderId);
  }, [selectedProviderId, isBridge, refreshModels]);

  return (
    <div className="mb-4 space-y-1">
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1.5">
        <label htmlFor="prov" className="text-sm font-semibold text-gray-500">AI 제공자</label>
        <select
          id="prov"
          aria-label="프로바이더"
          value={selectedProviderId}
          onChange={e => select(e.target.value, null)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-base"
        >
          {visibleProviders.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>

      {!isBridge && (
        <>
          <div className="flex items-center gap-1.5">
            <label htmlFor="model" className="text-sm font-semibold text-gray-500">모델</label>
            <select
              id="model"
              aria-label="모델"
              value={selectedModelId ?? ''}
              onChange={e => select(selectedProviderId, e.target.value || null)}
              className="min-w-40 rounded-lg border border-gray-300 px-2.5 py-2 text-base"
            >
              <option value="">{loading ? '불러오는 중…' : '모델 선택'}</option>
              {sortedModels.map(m => (
                <option key={m.id} value={m.id}>{modelOptionLabel(m)}</option>
              ))}
            </select>
          </div>
          <label className="sr-only" htmlFor="model-sort">정렬</label>
          <select
            id="model-sort"
            aria-label="모델 정렬"
            value={sort}
            onChange={e => setSort(e.target.value as ModelSort)}
            className="rounded-lg border border-gray-300 px-2.5 py-2 text-base text-gray-600"
          >
            {MODEL_SORTS.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <button
            aria-label="모델 새로고침"
            onClick={() => void refreshModels(selectedProviderId, true)}
            className="rounded-lg border border-gray-300 p-2 text-gray-500 hover:bg-gray-50"
          >
            <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </>
      )}

      <button
        aria-label="프로바이더 관리"
        onClick={onManage}
        className="ml-auto flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-base text-gray-600 hover:bg-gray-50"
      >
        <Settings className="h-5 w-5" />
        설정
      </button>
    </div>
      {!isBridge && modelError && !loading && (
        <p role="alert" className="text-sm text-red-600">
          모델 목록을 불러오지 못했습니다: {modelError}
        </p>
      )}
    </div>
  );
};
