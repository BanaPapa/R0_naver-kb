// KB시세 조회 모듈 도메인 타입 (R2_KB 이식)
// 지역 타입(RegionItem/RegionSelection)은 호스트 공용 타입(src/types)을 재사용한다.

// 시세 타입
export type PriceType = '상위' | '일반' | '하위';

// 면적 프리셋 (전용면적 기준, ㎡) — 네이버 탭 SPACE_OPTIONS(공급면적)와 기준이 다르므로 별도 정의
export const KB_SPACE_OPTIONS = [
  { label: '전체',   min: 0,  max: 0  },
  { label: '59미만', min: 0,  max: 59 },
  { label: '59타입', min: 59, max: 74 },
  { label: '74타입', min: 74, max: 84 },
  { label: '84타입', min: 84, max: 99 },
  { label: '85초과', min: 99, max: 0  },
];

// 검색 파라미터
export interface KbSearchParams {
  regionCode: string;
  propertyType: 1 | 2;           // 1:아파트, 2:오피스텔
  dealType: '매매' | '전세' | '월세';
  priceTypes: PriceType[];       // 선택된 시세 타입 (1~3개)
  areaMode: 'preset' | 'manual'; // 아파트: 타입 프리셋 / 직접설정
  spaceIndex: number;            // 프리셋 인덱스
  areaMin: number;               // 직접설정 최솟값 (㎡, 0=제한없음)
  areaMax: number;               // 직접설정 최댓값 (㎡, 0=제한없음)
}

// API 응답 타입
export interface KBApiResponse<T> {
  dataBody: {
    message: 'Success' | 'No Data.';
    data: T;
  };
}

// 시세 데이터
export interface DealData {
  전용면적: number;
  공급면적?: number;
  계약면적?: number;
  주택형타입내용: string;
  연결구분명: string;
  상위평균?: number;
  일반평균?: number;
  하위평균?: number;
  보증금?: number | '-';
  월세?: string;
}

// 단지 목록 아이템
export interface ComplexNameItem {
  단지기본일련번호: number;
  단지명: string;
  법정동코드?: string;
}

// 단지 시세 데이터
export interface ComplexPriceData {
  단지기본일련번호: number;
  단지명: string;
  매매?: DealData[];
  전세?: DealData[];
  월세?: DealData[];
}

// 단지 기본 정보
export interface ComplexMainData {
  단지기본일련번호: number;
  입주년월: string;
  총세대수: number;
}

// 타입 정보
export interface TypeInfoData {
  단지기본일련번호: number;
  전용면적: number;
  공급면적?: number;
  계약면적?: number;
  주택형타입내용: string;
  세대수: number;
  복층여부: number;
}

// 가공된 결과 데이터
export interface ProcessedData {
  id: string;
  단지기본일련번호: number;
  동: string;          // 소속 동 이름
  단지명: string;
  전용면적: number;    // ㎡
  공급면적: number;    // ㎡ (0이면 미상 — 아파트)
  계약면적: number;    // ㎡ (0이면 미상 — 오피스텔)
  타입: string;
  탑층여부: string;
  상위평균: number;
  일반평균: number;
  하위평균: number;
  입주년월?: string;
  총세대수?: number;
  세대수?: number;
}
