import { create } from 'zustand';
import { KbSearchParams, ProcessedData } from './types';
import { RegionSelection } from '../types';
import type { AreaUnit, PriceUnit } from './units';

// 지역 선택 → 검색용 법정동코드 10자리 변환 (소지역 > 중지역 > 대지역 우선)
export function getLegalDivisionCode(region: RegionSelection): string {
  const code = region.small?.code ?? region.mid?.code ?? region.large?.code ?? '';
  if (code.length === 8) return code + '00';
  if (code.length === 5) return code + '00000';
  if (code.length === 2) return code + '00000000';
  return code;
}

interface KbPriceState {
  loading: boolean;
  results: ProcessedData[];
  error: string | null;
  searchParams: KbSearchParams;
  regionSelection: RegionSelection;
  areaUnit: AreaUnit;   // 면적 표시 단위 (㎡ / 평) — 결과 테이블 공유
  priceUnit: PriceUnit; // 가격 표시 단위 (만원 / 천원) — 결과 테이블 공유

  setLoading: (loading: boolean) => void;
  setResults: (results: ProcessedData[]) => void;
  setError: (error: string | null) => void;
  setSearchParams: (params: Partial<KbSearchParams>) => void;
  setRegionSelection: (region: RegionSelection) => void;
  setAreaUnit: (unit: AreaUnit) => void;
  setPriceUnit: (unit: PriceUnit) => void;
  resetResults: () => void;
}

const initialSearchParams: KbSearchParams = {
  regionCode: '',
  propertyType: 1,
  dealType: '매매',
  priceTypes: ['일반'],
  areaMode: 'preset',
  spaceIndex: 0,
  areaMin: 0,
  areaMax: 0,
};

const initialRegionSelection: RegionSelection = {
  large: null,
  mid: null,
  small: null,
};

export const useKbPriceStore = create<KbPriceState>((set) => ({
  loading: false,
  results: [],
  error: null,
  searchParams: initialSearchParams,
  regionSelection: initialRegionSelection,
  areaUnit: 'pyeong',
  priceUnit: 'manwon',

  setLoading: (loading) => set({ loading }),

  setResults: (results) => set({ results, error: null }),

  setError: (error) => set({ error, results: [] }),

  setSearchParams: (params) =>
    set((state) => ({
      searchParams: { ...state.searchParams, ...params },
    })),

  setRegionSelection: (region) =>
    set((state) => ({
      regionSelection: region,
      searchParams: {
        ...state.searchParams,
        regionCode: getLegalDivisionCode(region),
      },
    })),

  setAreaUnit: (areaUnit) => set({ areaUnit }),

  setPriceUnit: (priceUnit) => set({ priceUnit }),

  // 초기화 — 결과만 비운다 (검색 조건·지역 선택은 유지)
  resetResults: () => set({ results: [], error: null }),
}));
