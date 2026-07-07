import axios from 'axios';
import logger from './logger.mjs';
import { classifySubscriptionResult } from './dataProcessor.mjs';

/**
 * 공공데이터포털(odcloud) — 한국부동산원 청약홈 OpenAPI 클라이언트.
 *
 * 청약홈 사이트(applyhome.co.kr)는 목록을 롤링 ~5년으로 잘라 보여주고 경쟁률
 * 팝업도 5년 윈도우 밖이면 빈 응답을 준다. 운영기관(한국부동산원)이 같은 데이터를
 * odcloud OpenAPI 로 공개하는데, 이쪽은 고정 하한(분양정보 ~2020-02, 경쟁률 ~2021)
 * 으로 윈도우 밖 과거도 내려준다. → 청약홈 live 가 0건인 과거 구간을 이 API 로 메운다.
 *
 * 서비스:
 *   ApplyhomeInfoDetailSvc  — 분양정보(공급) : getAPTLttotPblancDetail
 *   ApplyhomeInfoCmpetRtSvc — 청약경쟁률      : getAPTLttotPblancCmpet
 *
 * 미설정(ODCLOUD_SERVICE_KEY 없음) 시 isOdcloudEnabled()===false 로 모든 호출이
 * no-op 이 되어 앱은 순수 청약홈 live-crawl 로 그대로 동작한다.
 */

// 키는 지연 읽기 — vite.config 는 플러그인 import 이후에 .env 를 process.env 로
// 주입하므로 모듈 로드 시점에 캡처하면 비어버린다. 호출 시마다 process.env 에서 읽는다.
const getKey = () => process.env.ODCLOUD_SERVICE_KEY || '';
const BASE = 'https://api.odcloud.kr/api';
const DETAIL_SVC = 'ApplyhomeInfoDetailSvc';
const CMPET_SVC = 'ApplyhomeInfoCmpetRtSvc';

// odcloud 분양정보의 가장 오래된 모집공고일(검증값). 이보다 과거 월은 odcloud 에
// 없으므로(=청약홈 detail 스캔/백필 영역) 호출을 건너뛴다.
export const ODCLOUD_SUPPLY_FLOOR_YM = '202002';

export const isOdcloudEnabled = () => Boolean(getKey());

// odcloud SUBSCRPT_AREA_CODE_NM 은 청약홈 공급지역 단축명과 동일("서울","경기"…),
// 프런트가 보내는 region 이름을 그대로 EQ 필터에 쓸 수 있다.
const KNOWN_AREA_NAMES = new Set([
  '서울', '강원', '대전', '충남', '세종', '충북', '인천', '경기',
  '광주', '전남', '전북', '부산', '경남', '울산', '제주', '대구', '경북',
]);

async function odcloudGet(svc, ep, cond = {}, { page = 1, perPage = 100 } = {}) {
  const params = new URLSearchParams({ page: String(page), perPage: String(perPage), serviceKey: getKey() });
  for (const [k, v] of Object.entries(cond)) {
    if (v != null && v !== '') params.append(k, String(v));
  }
  const url = `${BASE}/${svc}/v1/${ep}?${params.toString()}`;
  const res = await axios.get(url, {
    timeout: 25000,
    headers: { Accept: 'application/json' },
    validateStatus: () => true,
  });
  if (res.status !== 200 || (res.data && res.data.code)) {
    const msg = res.data && res.data.msg ? res.data.msg : `status ${res.status}`;
    throw new Error(`odcloud ${ep} 실패: ${msg}`);
  }
  return res.data; // { data, page, perPage, currentCount, matchCount, totalCount }
}

// cond 필터된 결과 전체를 perPage 페이지로 끝까지 수집.
async function odcloudGetAll(svc, ep, cond, perPage = 100, maxPages = 30) {
  const first = await odcloudGet(svc, ep, cond, { page: 1, perPage });
  const rows = [...(first.data || [])];
  const match = first.matchCount ?? rows.length;
  let page = 2;
  while (rows.length < match && page <= maxPages) {
    const next = await odcloudGet(svc, ep, cond, { page, perPage });
    if (!next.data || next.data.length === 0) break;
    rows.push(...next.data);
    page += 1;
  }
  return rows;
}

const ymToDash = (yyyymm) => `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}`;
const lastDayOfMonth = (yyyymm) => {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  return new Date(y, m, 0).getDate();
};
const num = (v) => {
  const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};

// 분양정보 응답 한 건 → 크롤러의 apartment 형태(handlers/archive 와 동일 키).
function mapSupplyRow(r) {
  const period =
    r.RCEPT_BGNDE && r.RCEPT_ENDDE ? `${r.RCEPT_BGNDE} ~ ${r.RCEPT_ENDDE}` : r.RCEPT_BGNDE || '';
  return {
    houseManageNo: r.HOUSE_MANAGE_NO,
    pblancNo: r.PBLANC_NO || r.HOUSE_MANAGE_NO,
    region: r.SUBSCRPT_AREA_CODE_NM || '',
    houseName: r.HOUSE_NM || '',
    constructor: r.CNSTRCT_ENTRPS_NM || r.BSNS_MBY_NM || '',
    noticeDate: r.RCRIT_PBLANC_DE || '', // 'YYYY-MM-DD'
    subscriptionPeriod: period,
    announcementDate: r.PRZWNER_PRESNATN_DE || '',
    supplyTotalUnits: num(r.TOT_SUPLY_HSHLDCO), // 공급규모(전체)
    homepageUrl: r.HMPG_ADRES || null,
    detailUrl: r.PBLANC_URL || null,
  };
}

/**
 * 특정 월의 APT 분양정보 목록(odcloud). region 은 공급지역 단축명("서울"…),
 * keyword 는 주택명 LIKE. 모집공고일(RCRIT_PBLANC_DE) 기준 월 범위로 조회.
 * @returns {Promise<Array>} mapSupplyRow 형태 배열(경쟁률 미포함 — 별도 enrich)
 */
export async function fetchSupplyMonth({ yyyymm, region, keyword }) {
  if (!isOdcloudEnabled()) return [];
  const dash = ymToDash(yyyymm);
  const cond = {
    'cond[RCRIT_PBLANC_DE::GTE]': `${dash}-01`,
    'cond[RCRIT_PBLANC_DE::LTE]': `${dash}-${String(lastDayOfMonth(yyyymm)).padStart(2, '0')}`,
  };
  if (region && KNOWN_AREA_NAMES.has(region)) cond['cond[SUBSCRPT_AREA_CODE_NM::EQ]'] = region;
  if (keyword) cond['cond[HOUSE_NM::LIKE]'] = keyword;

  const rows = await odcloudGetAll(DETAIL_SVC, 'getAPTLttotPblancDetail', cond);
  return rows.map(mapSupplyRow);
}

// 경쟁률 응답 행: CMPET_RATE, HOUSE_TY, MODEL_NO, REQ_CNT, SUPLY_HSHLDCO,
// SUBSCRPT_RANK_CODE(1|2), RESIDE_SENM(해당지역|기타지역).
const isUnder = (rate) => /△/.test(String(rate ?? ''));
const rateNum = (rate) => {
  if (isUnder(rate)) return null;
  const n = parseFloat(String(rate ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * 경쟁률 행들 → 크롤러 getApartmentDetails 와 동일한 요약 지표.
 * (1순위 해당지역 합으로 평균경쟁률, 행 단위 status 집계로 청약결과 분류)
 */
function summarizeCompetition(rows) {
  let totalSupply = 0;
  let firstRoundApplications = 0;
  let maxCompetitionRate = 0;
  const sc = { firstLocal: 0, firstOther: 0, secondLocal: 0, secondOther: 0, underSubscribed: 0, inProgress: 0 };

  for (const r of rows) {
    const supply = num(r.SUPLY_HSHLDCO);
    const applications = num(r.REQ_CNT);
    const rank = Number(r.SUBSCRPT_RANK_CODE);
    const isLocal = String(r.RESIDE_SENM || '').includes('해당');
    const rate = r.CMPET_RATE;

    if (rank === 1 && isLocal) {
      totalSupply += supply;
      firstRoundApplications += applications;
    }
    const rn = rateNum(rate);
    if (rn != null && rn > maxCompetitionRate) maxCompetitionRate = rn;

    if (isUnder(rate)) sc.underSubscribed += 1;
    else if (rank === 1) (isLocal ? sc.firstLocal++ : sc.firstOther++);
    else if (rank === 2) (isLocal ? sc.secondLocal++ : sc.secondOther++);
  }

  const avg = totalSupply > 0 ? firstRoundApplications / totalSupply : 0;
  return {
    totalUnits: totalSupply,
    firstRoundApplications,
    averageCompetitionRate: Math.round(avg * 100) / 100,
    maxCompetitionRate: Math.round(maxCompetitionRate * 100) / 100,
    subscriptionResult: rows.length ? classifySubscriptionResult(sc, rows.length) : '-',
  };
}

const cell = (v, rowSpan = 1, show = true) => ({ v: v ?? '', rowSpan, show });

// 행 단위 청약결과(모달 표 '청약결과' 열) — 팝업 표기를 근사.
function rowResult(r) {
  const rate = r.CMPET_RATE;
  if (isUnder(rate)) return '미달';
  if (rate == null || String(rate).trim() === '' || String(rate).trim() === '-') return '-';
  return `${r.SUBSCRPT_RANK_CODE}순위 마감`;
}

/**
 * 경쟁률 행들 + 당첨가점 → ApartmentDetail.competition.rows (DetailCell[][]) 11열.
 * 청약홈 팝업 모달과 동일 레이아웃:
 *   주택형 | 공급세대수 | 순위 | 지역 | 접수건수 | 순위내경쟁률 | 청약결과 | 당첨가점(지역/최저/최고/평균)
 * 당첨가점은 getAptLttotPblancScore(주택형+거주코드 키)로 채운다(미달/미당첨이면 '-').
 * 주택형/공급세대수/당첨가점은 주택형 그룹 안에서 rowspan 병합.
 */
function buildCompetitionGrid(rows, scoreRows = []) {
  // 당첨가점 맵: `${HOUSE_TY}|${RESIDE_SECD}` → { low, top, avg }
  const scoreMap = new Map();
  for (const s of scoreRows) {
    scoreMap.set(`${s.HOUSE_TY}|${s.RESIDE_SECD}`, {
      low: s.LWET_SCORE ?? '-', top: s.TOP_SCORE ?? '-', avg: s.AVRG_SCORE ?? '-',
    });
  }
  // 주택형 → 순위 → 지역 순 안정 정렬.
  const sorted = [...rows].sort((a, b) => {
    if (a.HOUSE_TY !== b.HOUSE_TY) return String(a.HOUSE_TY).localeCompare(String(b.HOUSE_TY));
    if (a.SUBSCRPT_RANK_CODE !== b.SUBSCRPT_RANK_CODE) return Number(a.SUBSCRPT_RANK_CODE) - Number(b.SUBSCRPT_RANK_CODE);
    return String(a.RESIDE_SECD).localeCompare(String(b.RESIDE_SECD));
  });

  const grid = sorted.map((r) => {
    const svc = scoreMap.get(`${r.HOUSE_TY}|${r.RESIDE_SECD}`);
    return [
      cell(r.HOUSE_TY),
      cell(String(num(r.SUPLY_HSHLDCO) || r.SUPLY_HSHLDCO || '')),
      cell(`${r.SUBSCRPT_RANK_CODE}순위`),
      cell(r.RESIDE_SENM || ''),
      cell(String(num(r.REQ_CNT))),
      cell(String(r.CMPET_RATE ?? '-')),
      cell(rowResult(r)),
      cell(r.RESIDE_SENM || '-'),       // 당첨가점 - 지역
      cell(svc ? String(svc.low) : '-'), // 최저
      cell(svc ? String(svc.top) : '-'), // 최고
      cell(svc ? String(svc.avg) : '-'), // 평균
    ];
  });

  // 주택형(0)·공급세대수(1) 를 같은 주택형 그룹 안에서 rowspan 병합.
  for (let r = 0; r < grid.length; ) {
    let e = r;
    while (e + 1 < grid.length && grid[e + 1][0].v === grid[r][0].v) e += 1;
    const span = e - r + 1;
    for (const col of [0, 1]) {
      grid[r][col].rowSpan = span;
      for (let k = r + 1; k <= e; k += 1) grid[k][col].show = false;
    }
    r = e + 1;
  }
  return grid;
}

// APT 특별공급 신청현황(getAPTSpsplyReqstStus) → 모달 특별공급 탭 그리드.
// 열: 주택형 | 공급세대수 | 지역 | [8개 유형 접수건수] | 청약결과
// 주택형별 4행(배정세대수 / 해당지역 / 기타경기 / 기타지역). 주택형·공급세대수·청약결과 rowspan4.
const SPECIAL_TYPES = [
  { label: '다자녀가구', alloc: 'MNYCH_HSHLDCO', cnt: 'MNYCH_CNT' },
  { label: '신혼부부', alloc: 'NWWDS_NMTW_HSHLDCO', cnt: 'NWWDS_NMTW_CNT' },
  { label: '생애최초', alloc: 'LFE_FRST_HSHLDCO', cnt: 'LFE_FRST_CNT' },
  { label: '청년', alloc: 'YGMN_HSHLDCO', cnt: 'YGMN_CNT' },
  { label: '노부모부양', alloc: 'OLD_PARNTS_SUPORT_HSHLDCO', cnt: 'OPS_CNT' },
  { label: '신생아', alloc: 'NWBB_NWBBSHR_HSHLDCO', cnt: 'NWBB_NWBBSHR_CNT' },
];
const SPECIAL_TYPE_LABELS = [...SPECIAL_TYPES.map((t) => t.label), '기관추천', '이전기관'];
const REGION_ROWS = [
  { senm: '해당지역', prefix: 'CRSPAREA' },
  { senm: '기타경기', prefix: 'CTPRVN' },
  { senm: '기타지역', prefix: 'ETC_AREA' },
];

function buildSpecialSupplyGrid(spRows) {
  if (!spRows.length) return null;
  const sorted = [...spRows].sort((a, b) => String(a.HOUSE_TY).localeCompare(String(b.HOUSE_TY)));
  const rows = [];
  for (const r of sorted) {
    const hty = cell(r.HOUSE_TY, 4);
    const supply = cell(String(num(r.SPSPLY_HSHLDCO)), 4);
    const result = cell(r.SUBSCRPT_RESULT_NM || '-', 4);

    // 1행: 배정세대수
    const allocCells = SPECIAL_TYPES.map((t) => cell(String(num(r[t.alloc]))));
    allocCells.push(cell(String(num(r.INSTT_RECOMEND_HSHLDCO))));   // 기관추천 배정
    allocCells.push(cell(String(num(r.TRANSR_INSTT_ENFSN_HSHLDCO)))); // 이전기관 배정
    rows.push([hty, supply, cell('배정세대수'), ...allocCells, result]);

    // 2~4행: 거주지역별 접수건수
    REGION_ROWS.forEach((reg, idx) => {
      const cnts = SPECIAL_TYPES.map((t) => cell(String(num(r[`${reg.prefix}_${t.cnt}`]))));
      // 기관추천/이전기관 접수건수는 지역 미분할 → 해당지역 행에만 표기, 나머지는 '-'.
      if (idx === 0) {
        cnts.push(cell(String(num(r.INSTT_RECOMEND_DCSN_CNT))));
        cnts.push(cell(String(num(r.TRANSR_INSTT_ENFSN_CNT))));
      } else {
        cnts.push(cell('-'));
        cnts.push(cell('-'));
      }
      rows.push([
        cell('', 1, false), cell('', 1, false), // 주택형·공급세대수 (rowspan 흡수)
        cell(reg.senm),
        ...cnts,
        cell('', 1, false), // 청약결과 (rowspan 흡수)
      ]);
    });
  }
  return { typeLabels: SPECIAL_TYPE_LABELS, rows };
}

async function fetchCmpetRows(ep, houseManageNo, pblancNo) {
  const cond = { 'cond[HOUSE_MANAGE_NO::EQ]': houseManageNo };
  if (pblancNo) cond['cond[PBLANC_NO::EQ]'] = pblancNo;
  return odcloudGetAll(CMPET_SVC, ep, cond);
}

/**
 * 한 단지의 경쟁률(odcloud) 조회 → { summary, rows(원본), grid(DetailCell[][]) }.
 * 일반공급 경쟁률 + 당첨가점을 합쳐 모달 일반공급 표와 동일한 그리드를 만든다.
 * 데이터 없으면 null.
 */
export async function fetchCompetition({ houseManageNo, pblancNo }) {
  if (!isOdcloudEnabled()) return null;
  const [rows, scoreRows] = await Promise.all([
    fetchCmpetRows('getAPTLttotPblancCmpet', houseManageNo, pblancNo),
    fetchCmpetRows('getAptLttotPblancScore', houseManageNo, pblancNo).catch(() => []),
  ]);
  if (!rows.length) return null;
  return { summary: summarizeCompetition(rows), rows, grid: buildCompetitionGrid(rows, scoreRows) };
}

/**
 * 단지 전체 청약결과(odcloud) → ApartmentDetail 의 competition + specialSupply.
 * 상세 모달이 청약홈과 동일하게(일반공급 경쟁률·당첨가점 + 특별공급 신청현황) 보이도록 한다.
 * @returns {{summary, competition:{rows}, specialSupply}|null}
 */
export async function fetchFullCompetition({ houseManageNo, pblancNo }) {
  if (!isOdcloudEnabled()) return null;
  const [rows, scoreRows, spRows] = await Promise.all([
    fetchCmpetRows('getAPTLttotPblancCmpet', houseManageNo, pblancNo),
    fetchCmpetRows('getAptLttotPblancScore', houseManageNo, pblancNo).catch(() => []),
    fetchCmpetRows('getAPTSpsplyReqstStus', houseManageNo, pblancNo).catch(() => []),
  ]);
  if (!rows.length && !spRows.length) return null;
  return {
    summary: rows.length ? summarizeCompetition(rows) : null,
    competition: { rows: rows.length ? buildCompetitionGrid(rows, scoreRows) : [] },
    specialSupply: buildSpecialSupplyGrid(spRows),
  };
}

export default {
  isOdcloudEnabled,
  ODCLOUD_SUPPLY_FLOOR_YM,
  fetchSupplyMonth,
  fetchCompetition,
  fetchFullCompetition,
};
