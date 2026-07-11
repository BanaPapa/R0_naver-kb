import { randomDelay } from './utils';
import { callExtension } from './extensionBridge';

// 전송 경로 선택:
//  - 확장 감지됨 → 브라우저 확장 경유(주거 IP + 브라우저 네이버 쿠키). Vercel 배포의 정상 경로.
//  - 확장 없음   → dev 프록시(/naver-api). 로컬 개발용 폴백.
let useExtension = false;
let _crawlToken: string | null = null;

// (이름 유지: NaverCrawlerTab이 호출) 확장 감지 여부로 전송 경로를 전환한다.
export function setNaverBases(extensionPresent: boolean): void {
  useExtension = extensionPresent;
}

export function setNaverCrawlToken(token: string | null): void {
  _crawlToken = token;
}

const COOKIE_KEY = 'naver_cookie';
const BEARER_KEY = 'naver_bearer';

export function getStoredCookie(): string {
  return localStorage.getItem(COOKIE_KEY) ?? '';
}

export function setStoredCookie(cookie: string): void {
  localStorage.setItem(COOKIE_KEY, cookie);
}

export function clearStoredCookie(): void {
  localStorage.removeItem(COOKIE_KEY);
}

export function getStoredBearer(): string {
  return localStorage.getItem(BEARER_KEY) ?? '';
}

export function setStoredBearer(token: string): void {
  // "Bearer " 접두사가 포함된 경우 제거하고 토큰만 저장
  localStorage.setItem(BEARER_KEY, token.replace(/^Bearer\s+/i, '').trim());
}

export function clearStoredBearer(): void {
  localStorage.removeItem(BEARER_KEY);
}

// ── 통합 전송 계층 ──────────────────────────────────────────
// 확장 경유(useExtension) 또는 dev 프록시 폴백. 두 경로 모두 실패 시
// .status를 가진 Error를 던져 withRetry의 429 백오프가 동작하게 한다.
interface NaverReq {
  base: 'fin' | 'new';
  path: string;
  method?: 'GET' | 'POST';
  query?: Record<string, unknown>;
  body?: unknown;
  referer?: string;
}

function statusError(message: string, status: number): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

async function naverRequest(req: NaverReq): Promise<unknown> {
  const { base, path, method = 'GET', query, body, referer } = req;

  if (useExtension) {
    const res = await callExtension<{ status?: number; body?: string; error?: string }>(
      'NAVER_FETCH',
      { base, path, method, query, body, referer },
      45_000,
    );
    if (res?.error) throw statusError(`확장 오류: ${res.error}`, 0);
    const status = res?.status ?? 0;
    if (status < 200 || status >= 300) {
      throw statusError(`매물 API 오류: ${status}`, status);
    }
    try {
      return JSON.parse(res?.body ?? '{}');
    } catch {
      return {};
    }
  }

  // 폴백: dev 프록시(로컬 개발). 배포 환경에서 확장이 없으면 이 경로는 IP 차단으로 실패한다.
  const baseUrl = base === 'fin' ? '/naver-api' : '/naver-new-api';
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
  }
  const url = `${baseUrl}${path}${qs.toString() ? `?${qs.toString()}` : ''}`;
  const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' };
  const cookie = getStoredCookie();
  if (cookie) headers['X-Naver-Cookie'] = cookie;
  if (base === 'new') {
    const bearer = getStoredBearer();
    if (bearer) headers['X-Naver-Bearer'] = bearer;
  }
  if (referer) headers['X-Naver-Referer'] = referer;
  if (_crawlToken) headers['X-Crawl-Token'] = _crawlToken;

  const init: RequestInit = { method, headers, credentials: 'omit' };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }

  const resp = await fetch(url, init);
  if (!resp.ok) throw statusError(`매물 API 오류: ${resp.status}`, resp.status);
  return resp.json();
}

// 429에 대해 지수 백오프 + 지터로 재시도 — WAF cooldown을 더 키우지 않기 위함
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  const backoffsMs = [5000, 12000, 30000]; // 단조 증가, WAF 누적 패턴 방지
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 429 && attempt < retries) {
        const base = backoffsMs[Math.min(attempt, backoffsMs.length - 1)];
        const jitter = Math.floor(Math.random() * 2000); // 0~2s
        const wait = base + jitter;
        console.warn(
          `[ListingAPI] 429 Too Many Requests — ${Math.round(wait / 1000)}초 대기 후 재시도 (${attempt + 1}/${retries})`,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

// GET 요청 (fin.land — search/autocomplete 등)
async function naverFetch(path: string, params: Record<string, unknown>): Promise<unknown> {
  return naverRequest({ base: 'fin', path, method: 'GET', query: params });
}

// POST 요청 (fin.land — complex/article/list)
async function naverPost(path: string, body: unknown): Promise<unknown> {
  return naverRequest({ base: 'fin', path, method: 'POST', body });
}

// GET 요청 (new.land.naver.com — 단지목록/빌라·단독 매물)
async function naverNewFetch(
  path: string,
  params: Record<string, unknown>,
  referer?: string,
): Promise<unknown> {
  return naverRequest({ base: 'new', path, method: 'GET', query: params, referer });
}

// ====================================================
// 타입 정의
// ====================================================

export interface ComplexItem {
  complexNumber: number;
  complexName: string;
  type: string;
  legalDivisionName: string;
  coordinates: { xCoordinate: number; yCoordinate: number };
}

export interface ComplexSearchResult {
  hasNextPage: boolean;
  totalCount: number;
  list: ComplexItem[];
}

export interface ArticleListParams {
  complexNumber: number;
  tradeTypes: string[];       // 실제 API: 배열 (예: ["A1"])
  lastInfoCursor: unknown[];  // 첫 요청: [], 이후: 이전 응답의 lastInfo
  size?: number;
}

export interface ArticleListResult {
  seed: string;
  lastInfo: unknown[];
  hasNextPage: boolean;
  totalCount: number;
  list: RawArticleItem[];
}

export interface RawArticleItem {
  representativeArticleInfo: RawArticleInfo;
  duplicatedArticleInfo?: {
    representativePriceInfo?: unknown;
    realtorCount?: number;
    directTradeCount?: number;
    articleInfoList?: RawArticleInfo[];
  };
}

export interface RawArticleInfo {
  complexName?: string;
  articleNumber: string;
  dongName?: string;
  tradeType: string;
  realEstateType: string;
  spaceInfo?: {
    supplySpace?: number;
    contractSpace?: number;
    exclusiveSpace?: number;
    supplySpaceName?: string;
    exclusiveSpaceName?: string;
    nameType?: string;
  };
  buildingInfo?: {
    buildingConjunctionDate?: string;
    approvalElapsedYear?: number;
  };
  verificationInfo?: {
    verificationType?: string;
    exposureStartDate?: string;
    articleConfirmDate?: string;
  };
  brokerInfo?: {
    cpId?: string;
    brokerageName?: string;
    brokerName?: string;
  };
  articleDetail?: {
    direction?: string;
    directionStandard?: string;
    articleFeatureDescription?: string;
    directTrade?: boolean;
    floorInfo?: string;
    floorDetailInfo?: {
      targetFloor?: string;
      totalFloor?: string;
    };
  };
  address?: {
    city?: string;
    division?: string;
    sector?: string;
    coordinates?: { xCoordinate?: number; yCoordinate?: number };
  };
  priceInfo?: {
    dealPrice?: number;
    warrantyPrice?: number;
    rentPrice?: number;
    managementFeeAmount?: number;
    priceChangeStatus?: number;
    priceChangeHistories?: Array<{ modifiedDate: string; dealPrice: number }>;
    premiumPrice?: number;
    optionPrice?: number;
  };
}

// ====================================================
// API 함수
// ====================================================

export async function searchComplexes(
  keyword: string,
  page = 0,
  size = 10,
): Promise<ComplexSearchResult> {
  return withRetry(async () => {
    await randomDelay(500, 1500);
    const data = await naverFetch('/search/autocomplete/complexes', { keyword, size, page }) as {
      result?: {
        hasNextPage?: boolean;
        totalCount?: number;
        list?: ComplexItem[];
      };
    };
    const result = data?.result ?? {};
    return {
      hasNextPage: result.hasNextPage ?? false,
      totalCount: result.totalCount ?? 0,
      list: result.list ?? [],
    };
  });
}

export interface RegionComplexItem {
  complexNumber: number;
  complexName: string;
}

interface CortarBounds {
  topLat: number;
  bottomLat: number;
  leftLon: number;
  rightLon: number;
}

async function getCortarBounds(cortarNo: string): Promise<CortarBounds> {
  const data = (await naverNewFetch('/api/cortars', { cortarNo, zoom: 16 })) as Record<string, unknown>;
  const vertexLists = data.cortarVertexLists as number[][][] | undefined;

  if (vertexLists?.length) {
    const vertices = vertexLists.flat();
    const lats = vertices.map((v) => v[0]);
    const lons = vertices.map((v) => v[1]);
    return {
      topLat: Math.max(...lats),
      bottomLat: Math.min(...lats),
      leftLon: Math.min(...lons),
      rightLon: Math.max(...lons),
    };
  }

  // 폴백: 해당 cortarNo의 실제 중심좌표(centerLat/centerLon) 기준 ±0.05도 박스
  // ⚠️ 좌표가 없을 때 서울(37.5/127.0)로 기본값을 두면, 군산 등 지방 동을 조회할 때
  //    바운딩박스가 서울로 잡혀 송파 등 엉뚱한 지역 단지가 딸려온다. 따라서 좌표가 없으면
  //    임의 기본값 대신 명시적 에러로 던져 호출부가 그 동을 0건 처리하게 한다.
  if (data.centerLat != null && data.centerLon != null) {
    const centerLat = Number(data.centerLat);
    const centerLon = Number(data.centerLon);
    const pad = 0.05;
    return {
      topLat: centerLat + pad,
      bottomLat: centerLat - pad,
      leftLon: centerLon - pad,
      rightLon: centerLon + pad,
    };
  }

  throw new Error(`cortarNo ${cortarNo} 좌표 조회 실패 — 바운딩박스를 만들 수 없습니다`);
}

// new.land.naver.com/api/complexes/single-markers/2.0 — cortarNo + 바운딩박스 기반 단지 목록
export async function getComplexesByCortarNo(
  cortarNo: string,
  realEstateType: string,
  tradeType: string,
  areaMin: number,
  areaMax: number,
): Promise<RegionComplexItem[]> {
  const bounds = await getCortarBounds(cortarNo);

  const data = await naverNewFetch('/api/complexes/single-markers/2.0', {
    cortarNo,
    zoom: 16,
    priceType: 'RETAIL',
    markerId: '',
    markerType: '',
    selectedComplexNo: '',
    selectedComplexBuildingNo: '',
    fakeComplexMarker: '',
    realEstateType,
    tradeType,
    tag: '::::::::',
    rentPriceMin: 0,
    rentPriceMax: 900000000,
    priceMin: 0,
    priceMax: 900000000,
    areaMin: areaMin > 0 ? areaMin : 0,
    areaMax: areaMax < 900000 ? areaMax : 900000,
    oldBuildYears: '',
    recentlyBuildYears: '',
    minHouseHoldCount: '',
    maxHouseHoldCount: '',
    showArticle: 'false',
    sameAddressGroup: 'true',
    minMaintenanceCost: '',
    maxMaintenanceCost: '',
    directions: '',
    leftLon: bounds.leftLon,
    rightLon: bounds.rightLon,
    topLat: bounds.topLat,
    bottomLat: bounds.bottomLat,
  });

  const rawList = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  return rawList
    .map((item) => ({
      complexNumber: Number(item.markerId ?? 0),
      complexName: String(item.complexName ?? ''),
    }))
    .filter((item) => item.complexNumber > 0);
}

// ====================================================
// new.land.naver.com /api/articles — VL/DDDGG/SMS/APTHGJ cortarNo 기반 직접 매물 검색
// ====================================================

export interface NewLandArticle {
  articleNo: string;
  articleName: string;
  articleStatus: string;
  realEstateTypeCode: string;
  realEstateTypeName: string;
  tradeTypeCode: string;
  tradeTypeName: string;
  verificationTypeCode: string;
  floorInfo: string;
  dealOrWarrantPrc: string;
  rentPrc?: string;
  area1: number;
  area2: number;
  areaName?: string;
  direction?: string;
  articleConfirmYmd: string;
  sameAddrCnt: number;
  buildingName?: string;
  articleFeatureDesc?: string;
  latitude?: string;
  longitude?: string;
  realtorName?: string;
  realtorId?: string;
  cpName?: string;
  cpid?: string;
  priceChangeState?: string;
}

export interface CortarArticlesResponse {
  hasNextPage: boolean;
  list: NewLandArticle[];
}

export async function getArticlesByCortar(
  cortarNo: string,
  realEstateType: string,
  tradeType: string,
  page: number,
  referer?: string,
): Promise<CortarArticlesResponse> {
  return withRetry(async () => {
    await randomDelay(500, 1500);
    const data = (await naverNewFetch('/api/articles', {
      cortarNo,
      order: 'rank',
      realEstateType,
      tradeType,
      tag: '::::::::',
      rentPriceMin: 0,
      rentPriceMax: 900000000,
      priceMin: 0,
      priceMax: 900000000,
      areaMin: 0,
      areaMax: 900000000,
      oldBuildYears: '',
      recentlyBuildYears: '',
      minHouseHoldCount: '',
      maxHouseHoldCount: '',
      showArticle: 'false',
      sameAddressGroup: 'true',
      minMaintenanceCost: '',
      maxMaintenanceCost: '',
      priceType: 'RETAIL',
      directions: '',
      page,
      articleState: '',
    }, referer)) as {
      isMoreData?: boolean;
      articleList?: NewLandArticle[];
    };
    return {
      hasNextPage: data?.isMoreData ?? false,
      list: data?.articleList ?? [],
    };
  });
}

export async function getArticleList(params: ArticleListParams): Promise<ArticleListResult> {
  return withRetry(async () => {
    await randomDelay(500, 1500);

    // 실제 Naver 앱 캡처 기준 POST body 포맷
    const body = {
      complexNumber: String(params.complexNumber),
      tradeTypes: params.tradeTypes,
      pyeongTypes: [],
      dongNumbers: [],
      userChannelType: 'PC',
      articleSortType: 'RANKING_DESC',
      lastInfo: params.lastInfoCursor,
      size: params.size ?? 20,
    };

    const data = await naverPost('/complex/article/list', body) as {
      result?: {
        seed?: string;
        lastInfo?: unknown[];
        hasNextPage?: boolean;
        totalCount?: number;
        list?: RawArticleItem[];
      };
    };

    const result = data?.result ?? {};
    return {
      seed: result.seed ?? '',
      lastInfo: result.lastInfo ?? [],
      hasNextPage: result.hasNextPage ?? false,
      totalCount: result.totalCount ?? 0,
      list: result.list ?? [],
    };
  });
}

// ====================================================
// 개별 매물 상세 조회 (new.land /api/articles/{articleNo})
// 분양권 프리미엄/옵션, 상세설명, 중개업소 상세 정보 포함
// ====================================================

export interface ArticleDetailResult {
  detailDescription: string;
  isalePrice: number;            // 원 단위 (API만원 × 10000) — 분양가
  premiumPrice: number;          // 원 단위 (API만원 × 10000)
  optionPrice: number;           // 원 단위 (API만원 × 10000)
  realtorName: string;
  realtorAddress: string;
  cellPhoneNo: string;
  representativeTelNo: string;
  dealCount: number;
  leaseCount: number;
  rentCount: number;
}

// ====================================================
// 단지 상세 정보 (fin.land /complex)
// 주의: 과거 /complex/detail 경로는 404. 현재 fin.land 단지정보는 /complex.
// 응답 필드명도 다르다(useApprovalDate, totalHouseholdNumber 등).
// 구조(현관방식)는 더 이상 제공되지 않아 용적률/건폐율로 대체한다.
// ====================================================

export interface ComplexDetailResult {
  aptUseApproveYmd: string;              // 입주일 (YYYYMMDD)
  aptHouseholdCount: number;             // 세대수
  totalDongCount: number;                // 동수
  complexHighestFloor: number;           // 최고층
  aptParkingCountPerHousehold: number;   // 세대당 주차대수
  aptConstructionCompanyName: string;    // 시공사
  floorAreaRatio: number;                // 용적률 (%)
  buildingCoverageRatio: number;         // 건폐율 (%)
}

export async function getComplexDetail(complexNo: number): Promise<ComplexDetailResult | null> {
  try {
    const data = await naverFetch('/complex', { complexNumber: complexNo }) as Record<string, unknown>;
    const r = (data.result ?? {}) as Record<string, unknown>;
    const parking = (r.parkingInfo      ?? {}) as Record<string, unknown>;
    const ratio   = (r.buildingRatioInfo ?? {}) as Record<string, unknown>;
    return {
      aptUseApproveYmd:            String(r.useApprovalDate              ?? ''),
      aptHouseholdCount:           Number(r.totalHouseholdNumber         ?? 0),
      totalDongCount:              Number(r.dongCount                    ?? 0),
      complexHighestFloor:         Number(r.highestDongFloor             ?? 0),
      aptParkingCountPerHousehold: Number(parking.parkingCountPerHousehold ?? 0),
      aptConstructionCompanyName:  String(r.constructionCompany          ?? ''),
      floorAreaRatio:              Number(ratio.floorAreaRatio           ?? 0),
      buildingCoverageRatio:       Number(ratio.buildingCoverageRatio    ?? 0),
    };
  } catch {
    return null;
  }
}

// ====================================================
// 매입비용 조회 (fin.land /complex/article/acquisition-cost)
// ====================================================

export interface AcquisitionCostResult {
  acquisitionTax: number;   // 취득세 (원)
  eduTax: number;           // 교육세 (원)
  specialTax: number;       // 농어촌특별세 (원)
  totalPrice: number;       // 매입비용 총액 (원)
  brokerFee: number;        // 중개보수 (원)
}

export async function getAcquisitionCost(
  articleNo: string,
  complexNo: number,
  _dealPriceWon: number,  // 서명 유지용 (new.land 응답에 articleTax 포함)
): Promise<AcquisitionCostResult | null> {
  try {
    // new.land /api/articles/{articleNo} 응답의 articleTax에 취득세/중개보수가 포함됨
    const params: Record<string, unknown> = {};
    if (complexNo > 0) params.complexNo = complexNo;
    const data = await naverNewFetch(
      `/api/articles/${encodeURIComponent(articleNo)}`,
      params,
    ) as Record<string, unknown>;
    const tax = (data.articleTax ?? {}) as Record<string, unknown>;
    const toNum = (v: unknown) => Number(v ?? 0);
    if (toNum(tax.totalPrice) === 0 && toNum(tax.acquisitionTax) === 0) return null;
    return {
      acquisitionTax: toNum(tax.acquisitionTax),
      eduTax:         toNum(tax.eduTax),
      specialTax:     toNum(tax.specialTax),
      totalPrice:     toNum(tax.totalPrice),
      brokerFee:      toNum(tax.brokerFee),
    };
  } catch (e) {
    console.error('[AcquisitionCost] 매입비용 조회 실패:', e);
    return null;
  }
}

export async function getArticleDetail(
  articleNo: string,
  complexNo?: number,
): Promise<ArticleDetailResult | null> {
  try {
    const params: Record<string, unknown> = {};
    if (complexNo && complexNo > 0) params.complexNo = complexNo;
    const data = await naverNewFetch(
      `/api/articles/${encodeURIComponent(articleNo)}`,
      params,
    ) as Record<string, unknown>;
    const detail  = (data.articleDetail  ?? {}) as Record<string, unknown>;
    const price   = (data.articlePrice   ?? {}) as Record<string, unknown>;
    const realtor = (data.articleRealtor ?? {}) as Record<string, unknown>;
    return {
      detailDescription:   String(detail.detailDescription   ?? ''),
      isalePrice:          Number(price.isalePrice            ?? 0) * 10_000,
      premiumPrice:        Number(price.premiumPrice          ?? 0) * 10_000,
      optionPrice:         Number(price.optionPrice           ?? 0) * 10_000,
      realtorName:         String(realtor.realtorName         ?? ''),
      realtorAddress:      String(realtor.address             ?? ''),
      cellPhoneNo:         String(realtor.cellPhoneNo         ?? ''),
      representativeTelNo: String(realtor.representativeTelNo ?? ''),
      dealCount:           Number(realtor.dealCount           ?? 0),
      leaseCount:          Number(realtor.leaseCount          ?? 0),
      rentCount:           Number(realtor.rentCount           ?? 0),
    };
  } catch {
    return null;
  }
}
