import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthMethod, ModelInfo, ProviderStatus } from './provider.types';
import * as api from '../api/provider.api';

interface ProviderStore {
  selectedProviderId: string;
  selectedModelId: string | null;
  statuses: Record<string, { connected: boolean; method?: AuthMethod }>;
  models: Record<string, ModelInfo[]>;
  loadingModels: Record<string, boolean>;
  modelErrors: Record<string, string | null>;

  refreshProviders: () => Promise<void>;
  refreshModels: (id: string, force?: boolean) => Promise<void>;
  saveApiKey: (id: string, key: string) => Promise<void>;
  saveSessionToken: (id: string, token: string) => Promise<void>;
  startOAuth: (id: string) => Promise<void>;
  startOAuthCode: (id: string) => Promise<string>;
  submitOAuthCode: (id: string, state: string, code: string) => Promise<void>;
  startDeviceCode: (id: string) => Promise<api.DeviceStart>;
  pollDeviceCode: (id: string, state: string) => Promise<{ pending: boolean }>;
  disconnect: (id: string) => Promise<void>;
  select: (providerId: string, modelId: string | null) => void;
}

export const useProviderStore = create<ProviderStore>()(
  persist(
    (set, get) => ({
      selectedProviderId: 'claude-bridge',
      selectedModelId: null,
      statuses: {},
      models: {},
      loadingModels: {},
      modelErrors: {},

      refreshProviders: async () => {
        const list: ProviderStatus[] = await api.fetchProviders();
        const statuses: ProviderStore['statuses'] = {};
        for (const s of list) statuses[s.id] = { connected: s.connected, method: s.method };
        set({ statuses });
      },

      refreshModels: async (id, force = false) => {
        if (!force && get().models[id]?.length) return;
        set(s => ({ loadingModels: { ...s.loadingModels, [id]: true } }));
        try {
          const models = await api.fetchModels(id, force);
          set(s => ({ models: { ...s.models, [id]: models }, modelErrors: { ...s.modelErrors, [id]: null } }));
        } catch (err) {
          // 에러를 삼키지 않고 UI에 노출(예: 403 크레딧/권한 부족).
          const message = err instanceof Error ? err.message : '모델 목록을 불러오지 못했습니다.';
          set(s => ({ models: { ...s.models, [id]: [] }, modelErrors: { ...s.modelErrors, [id]: message } }));
        } finally {
          set(s => ({ loadingModels: { ...s.loadingModels, [id]: false } }));
        }
      },

      saveApiKey: async (id, key) => {
        await api.saveApiKey(id, key);
        await get().refreshProviders();
      },

      saveSessionToken: async (id, token) => {
        await api.saveSessionToken(id, token);
        await get().refreshProviders();
      },

      startOAuth: async (id) => {
        const { authUrl } = await api.startOAuth(id);
        window.open(authUrl, '_blank', 'width=520,height=720');
      },

      // 코드 붙여넣기 방식: 새 창을 열고 사용자가 붙여넣을 state를 반환.
      startOAuthCode: async (id) => {
        const { authUrl, state } = await api.startOAuth(id);
        window.open(authUrl, '_blank', 'width=520,height=720');
        return state ?? '';
      },

      submitOAuthCode: async (id, state, code) => {
        await api.exchangeOAuthCode(id, state, code);
        await get().refreshProviders();
      },

      // device-code(OpenAI) — 배포 전용. 시작(코드 표시) → 폴링(승인 대기) → 저장.
      startDeviceCode: async (id) => api.startDeviceCode(id),
      pollDeviceCode: async (id, state) => {
        const r = await api.pollDeviceCode(id, state);
        if (!r.pending) await get().refreshProviders();
        return r;
      },

      disconnect: async (id) => {
        await api.disconnect(id);
        await get().refreshProviders();
      },

      select: (providerId, modelId) => set({ selectedProviderId: providerId, selectedModelId: modelId }),
    }),
    {
      name: 'kb-provider',
      partialize: s => ({ selectedProviderId: s.selectedProviderId, selectedModelId: s.selectedModelId }),
    },
  ),
);
