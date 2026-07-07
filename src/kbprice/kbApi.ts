// KB Land 시세 API 클라이언트 (fetch 기반 — R2_KB의 axios 구현을 의존성 없이 이식)
// 개발: vite 프록시 /api/kbland → https://api.kbland.kr
// 배포: vercel.json rewrite /api/kbland → https://api.kbland.kr (CORS 프리플라이트 회피)
import {
  KBApiResponse,
  ComplexPriceData,
  ComplexNameItem,
  ComplexMainData,
  TypeInfoData,
  KbSearchParams,
} from './types';

const BASE_URL = '/api/kbland';
const TIMEOUT_MS = 15000;

async function getJson<T>(path: string): Promise<KBApiResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE_URL}${path}`, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        webservice: '1',
      },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`KB API 오류: ${resp.status}`);
    return (await resp.json()) as KBApiResponse<T>;
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;

class KBApiClient {
  /**
   * 동 코드로 단지 목록 조회 (fastPriceComplexName)
   * 검색의 첫 단계 - 해당 동의 단지 목록을 가져온다
   */
  async fetchComplexNames(regionCode: string, propertyType: number): Promise<ComplexNameItem[]> {
    try {
      const qs = `${enc('법정동코드')}=${regionCode}&${enc('유형')}=${propertyType}`;
      const json = await getJson<ComplexNameItem[]>(`/land-price/price/fastPriceComplexName?${qs}`);
      const data = json?.dataBody?.data;
      if (!data || json.dataBody.message === 'No Data.') return [];
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error('단지 목록 조회 실패:', error);
      throw new Error('단지 목록을 가져오는데 실패했습니다.');
    }
  }

  /**
   * 특정 단지의 빠른시세 조회 (fastPriceInfo + 단지기본일련번호)
   * KB 사이트와 동일한 방식: 법정동코드 + 유형 + 거래유형 + 단지기본일련번호
   */
  async fetchFastPriceForComplex(
    regionCode: string,
    propertyType: number,
    complexId: number,
  ): Promise<ComplexPriceData | null> {
    try {
      const qs = [
        `${enc('법정동코드')}=${regionCode}`,
        `${enc('유형')}=${propertyType}`,
        `${enc('거래유형')}=0`,
        `${enc('단지기본일련번호')}=${complexId}`,
      ].join('&');

      const json = await getJson<ComplexPriceData | ComplexPriceData[]>(
        `/land-price/price/fastPriceInfo?${qs}`,
      );
      const raw = json?.dataBody?.data;
      if (!raw) return null;

      // 응답이 배열이면 첫 번째 요소 사용
      const data = Array.isArray(raw) ? raw[0] : raw;
      if (!data) return null;

      // API 응답의 숫자 필드가 문자열로 오므로 변환
      return this.normalizeComplexPriceData(data);
    } catch (error) {
      console.error(`단지 시세 조회 실패 (${complexId}):`, error);
      return null;
    }
  }

  private normalizeComplexPriceData(data: ComplexPriceData): ComplexPriceData {
    const parseNum = (v: unknown): number => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string') return parseFloat(v) || 0;
      return 0;
    };

    const normalizeDeal = (deals: unknown): ComplexPriceData['매매'] => {
      if (!Array.isArray(deals)) return undefined;
      return deals.map((d: Record<string, unknown>) => ({
        전용면적: parseNum(d['전용면적']),
        공급면적: parseNum(d['공급면적']),
        계약면적: parseNum(d['계약면적']),
        주택형타입내용: String(d['주택형타입내용'] ?? ''),
        연결구분명: String(d['연결구분명'] ?? ''),
        상위평균: parseNum(d['상위평균']),
        일반평균: parseNum(d['일반평균']),
        하위평균: parseNum(d['하위평균']),
        보증금: d['보증금'] != null ? parseNum(d['보증금']) : undefined,
        월세: d['월세'] != null ? String(d['월세']) : undefined,
      }));
    };

    return {
      ...data,
      단지기본일련번호:
        typeof data.단지기본일련번호 === 'number'
          ? data.단지기본일련번호
          : parseInt(String(data.단지기본일련번호), 10),
      매매: normalizeDeal((data as unknown as Record<string, unknown>)['매매']),
      전세: normalizeDeal((data as unknown as Record<string, unknown>)['전세']),
      월세: normalizeDeal((data as unknown as Record<string, unknown>)['월세']),
    };
  }

  /**
   * 여러 단지 시세 배치 조회
   * KB API 흐름: fetchComplexNames → fetchFastPriceForComplex × N
   */
  async fetchFastPrice(params: KbSearchParams): Promise<ComplexPriceData[]> {
    // 1) 단지 목록 조회
    const complexList = await this.fetchComplexNames(params.regionCode, params.propertyType);
    if (complexList.length === 0) return [];

    // 2) 각 단지별 시세 배치 조회
    const requests = complexList.map(
      (c) => () =>
        this.fetchFastPriceForComplex(params.regionCode, params.propertyType, c.단지기본일련번호).then(
          (data) => (data ? { ...data, 단지명: data.단지명 || c.단지명 } : null),
        ),
    );

    const results = await this.batchRequest(requests, 5);
    return results.filter((r): r is ComplexPriceData => r !== null);
  }

  /** 단지 기본정보 조회 */
  async fetchComplexMain(aptId: number): Promise<ComplexMainData | null> {
    try {
      const json = await getJson<ComplexMainData>(
        `/land-complex/complex/main?${enc('단지기본일련번호')}=${aptId}`,
      );
      return json?.dataBody?.data ?? null;
    } catch (error) {
      console.error(`단지 기본정보 조회 실패 (${aptId}):`, error);
      return null;
    }
  }

  /** 타입정보 조회 */
  async fetchTypInfo(aptId: number): Promise<TypeInfoData[]> {
    try {
      const json = await getJson<TypeInfoData[]>(
        `/land-complex/complex/typInfo?${enc('단지기본일련번호')}=${aptId}`,
      );
      return json?.dataBody?.data ?? [];
    } catch (error) {
      console.error(`타입정보 조회 실패 (${aptId}):`, error);
      return [];
    }
  }

  async batchRequest<T>(requests: (() => Promise<T>)[], maxConcurrent = 5): Promise<T[]> {
    const results: T[] = [];
    for (let i = 0; i < requests.length; i += maxConcurrent) {
      const batch = requests.slice(i, i + maxConcurrent);
      const batchResults = await Promise.allSettled(batch.map((req) => req()));
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          console.error('배치 요청 실패:', result.reason);
          results.push(null as T);
        }
      });
    }
    return results;
  }
}

export const kbApi = new KBApiClient();
