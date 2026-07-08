
export interface TransactionProperty {
  no: number;
  region: string;     // 거래지역 (시군구 코드 sggCd)
  dong: string;       // 법정동
  name: string;       // 아파트/단지명
  area: string;       // 전용면적 (전용M2)
  floor: string;      // 층 (실거래층)
  price: string;      // 거래금액 (실거래가)
  monthlyRent: string;// 월세 (0이면 전세)
  date: string;       // 실거래일 (YY.MM.DD)
  type: string;       // 거래유형
  cancelDate: string; // 해제유무 (해제일)
  buildYear: string;  // 건축년도
}

export interface AreaOption {
  id: number;
  name: string;
  min: number;
  max: number;
}

export interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'error';
}

export interface RegionCode {
  region_cd: string;
  locatadd_nm: string;
  sido_cd?: string;
  sgg_cd?: string;
  umd_cd?: string;
  ri_cd?: string;
  lat?: number; // Added for crawler centering
  lng?: number; // Added for crawler centering
}

export interface CrawlerStatus {
  step: string;
  progress: number; // 0 to 100
  clustersFound: number;
  propertiesFound: number;
  isRunning: boolean;
}

export type TabType = 
  | 'naver'        // 네이버 매물
  | 'commercial'   // 상가 매물
  | 'subscription' // 청약 데이터
  | 'transaction'  // 실거래 다운로드
  | 'review'       // 입주민 리뷰
  | 'location'     // 입지 분석
  | 'school'       // 학군 분석
  | 'agent';       // 중개업소 분석
