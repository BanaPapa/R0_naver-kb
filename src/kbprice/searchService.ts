import { KbSearchParams, ProcessedData, ComplexMainData, TypeInfoData, ComplexPriceData } from './types';
import { kbApi } from './kbApi';
import { DataProcessor } from './dataProcessor';

// 검색 대상 동 (법정동코드 10자리 + 표시용 동 이름)
export interface SearchRegion {
  code: string;
  name: string;
}

export class SearchService {
  /**
   * 전체 검색 프로세스 실행.
   * regions: 검색할 동 목록 (소지역 선택 시 1개, 중지역까지만 선택 시 해당 구/군의 모든 동)
   */
  static async executeSearch(params: KbSearchParams, regions: SearchRegion[]): Promise<ProcessedData[]> {
    // 1. 동별 빠른시세 조회 (동마다 단지목록 + 단지별 시세)
    const priceData: ComplexPriceData[] = [];
    const 동명Map = new Map<number, string>();

    for (const region of regions) {
      const list = await kbApi.fetchFastPrice({ ...params, regionCode: region.code });
      list.forEach((complex) => {
        동명Map.set(complex.단지기본일련번호, region.name);
      });
      priceData.push(...list);
    }

    if (priceData.length === 0) return [];

    // 2. 단지 기본정보 배치 조회 (단지 중복 제거)
    const complexIds = [...new Set(priceData.map((item) => item.단지기본일련번호))];
    const mainDataRequests = complexIds.map((id) => () => kbApi.fetchComplexMain(id));

    const mainDataResults = await kbApi.batchRequest(mainDataRequests, 5);
    const mainDataMap = new Map<number, ComplexMainData>();

    mainDataResults.forEach((data, index) => {
      if (data) {
        mainDataMap.set(complexIds[index], data);
      }
    });

    // 3. 타입정보 배치 조회
    const typeDataRequests = complexIds.map((id) => () => kbApi.fetchTypInfo(id));
    const typeDataResults = await kbApi.batchRequest(typeDataRequests, 5);
    const typeDataMap = new Map<number, TypeInfoData[]>();

    typeDataResults.forEach((data, index) => {
      if (data && data.length > 0) {
        typeDataMap.set(complexIds[index], data);
      }
    });

    // 4. 데이터 가공
    let processedResults = DataProcessor.processSearchResults(
      priceData,
      mainDataMap,
      typeDataMap,
      params,
      동명Map,
    );

    // 5. 기본 정렬: 동 단위로 묶고(검색한 동 순서) 동 내에서는 대표 시세 높은 순
    const 동순서 = new Map(regions.map((r, i) => [r.name, i]));
    processedResults = [...processedResults].sort((a, b) => {
      const orderA = 동순서.get(a.동) ?? Number.MAX_SAFE_INTEGER;
      const orderB = 동순서.get(b.동) ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return (
        DataProcessor.getPrimaryPrice(b, params.priceTypes) -
        DataProcessor.getPrimaryPrice(a, params.priceTypes)
      );
    });

    return processedResults;
  }
}
