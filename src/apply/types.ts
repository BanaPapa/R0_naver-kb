// 지역별 청약현황(R6_Apply 이식) 도메인 타입.
// 지역 타입(RegionItem/RegionSelection)은 호스트 공용 타입(src/types)을 재사용한다.

// 청약 결과 한 행 (검색 결과 표 / 슬롯 / 내보내기 공용)
export interface ApplyApartment {
  id: number;
  houseManageNo: string;
  pblancNo: string;
  region: string;
  houseName: string;
  constructor: string;
  noticeDate: string;
  subscriptionPeriod: string;
  announcementDate: string;
  totalUnits: string;
  firstRoundApplications: string;
  averageCompetitionRate: number;
  maxCompetitionRate: number;
  subscriptionResult: string;
}

// 검색 조건 스냅샷 — 슬롯 메타 표기 + 재검색용
export interface ApplySearchMeta {
  regionName: string;   // 표시용 (예: '서울특별시', '전체')
  regionCode?: string;  // 청약홈 공급지역 코드 (재검색용)
  startDate: string;    // YYYYMM
  endDate: string;      // YYYYMM
  keyword?: string;
}

// 저장 슬롯 — 검색 결과 스냅샷 (게스트는 localStorage, 로그인 시 Supabase apply_slots)
export interface ApplySavedSlot {
  id: string;
  createdAt: number;
  meta: ApplySearchMeta;
  count: number;                 // 전체 청약 건수
  apartments: ApplyApartment[];  // 저장 시점 결과 스냅샷
}

// 청약홈 검색 진행 모달 — 단지별 경쟁률 정보 수집 진행 상태
export type CollectStatus = 'counting' | 'running' | 'done' | 'stopped';

export interface CollectItem {
  index: number;
  region: string;
  houseName: string;
  status: 'pending' | 'active' | 'done';
  averageCompetitionRate?: number;
  subscriptionResult?: string;
}

// 청약홈 원본처럼 rowspan 병합된 셀 — show=false는 위 셀에 병합되어 렌더 생략
export interface DetailCell {
  v: string;
  rowSpan: number;
  show: boolean;
}

// 단지 상세 — 공식 링크 + 청약홈 원본 청약결과 표(일반공급 / 특별공급)
export interface ApartmentDetail {
  houseManageNo: string;
  pblancNo: string;
  houseName: string;
  homepageUrl: string | null;
  noticeUrl: string | null;
  detailUrl: string;
  // 일반공급 (1·2순위) 경쟁률
  competition: {
    rows: DetailCell[][];
  };
  // 특별공급 청약접수 현황 — 없으면 null
  specialSupply: {
    typeLabels: string[];
    rows: DetailCell[][];
  } | null;
}
