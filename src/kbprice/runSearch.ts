// KB시세 검색 실행기 — 검색 패널과 슬롯 '재검색'이 공유하는 단일 진입점.
// 지역 해석(소지역 1개 vs 중지역 하위 동 순회) 후 SearchService 를 실행해
// 결과를 스토어에 반영한다.
import { getRegions } from '../services/kbland';
import { useKbPriceStore } from './store';
import { SearchService, type SearchRegion } from './searchService';

// KB 시세 API는 법정동코드 10자리를 요구한다 (kbland areaName 응답은 2/5/10자리 혼재)
export function toFullCode(code: string): string {
  if (code.length === 8) return code + '00';
  if (code.length === 5) return code + '00000';
  if (code.length === 2) return code + '00000000';
  return code;
}

export async function executeKbSearch(): Promise<void> {
  const store = useKbPriceStore.getState();
  const { searchParams, regionSelection } = store;

  if (!regionSelection.mid) {
    alert('시/도와 시/군/구까지 선택해주세요.');
    return;
  }
  if (searchParams.priceTypes.length === 0) {
    alert('시세 유형을 하나 이상 선택해주세요.');
    return;
  }

  try {
    store.setLoading(true);

    // 소지역(동) 선택 시 해당 동 1개만, 중지역까지면 구/군 내 모든 동을 순회 검색
    let regions: SearchRegion[];
    if (regionSelection.small) {
      regions = [{ code: toFullCode(regionSelection.small.code), name: regionSelection.small.name }];
    } else {
      const dongs = await getRegions(3, regionSelection.mid.code);
      regions = dongs.map((d) => ({ code: toFullCode(d.code), name: d.name }));
      if (regions.length === 0) {
        store.setError('해당 지역의 동 정보를 찾을 수 없습니다.');
        return;
      }
    }

    const results = await SearchService.executeSearch(searchParams, regions);
    store.setResults(results);
  } catch (error) {
    store.setError(error instanceof Error ? error.message : '검색 중 오류가 발생했습니다.');
  } finally {
    useKbPriceStore.getState().setLoading(false);
  }
}
