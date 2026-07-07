import logger from './logger.mjs';
import { queryArchive } from './archive.mjs';
import {
  isOdcloudEnabled,
  fetchSupplyMonth,
  fetchCompetition,
  fetchFullCompetition,
  ODCLOUD_SUPPLY_FLOOR_YM,
} from './odcloud.mjs';

/**
 * 과거(>5년) 청약 조회 폴백 오케스트레이터.
 *
 * 청약홈 live 가 0건을 주는 과거 구간을 다음 우선순위로 메운다:
 *   1) Supabase 아카이브(queryArchive) — backfill 로 채워둔 경우 가장 빠름(경쟁률 포함)
 *   2) odcloud OpenAPI(live) — 분양정보 ~2020-02+, 경쟁률 ~2021+ (키 설정 시)
 *   3) 둘 다 없으면 null → 핸들러가 빈 결과 처리
 *
 * 사용자는 청약홈 live / 아카이브 / odcloud 출처를 구분하지 못한 채 2020년대 과거까지
 * 동일 UI 로 조회한다. (2015~2020-01 공급정보는 backfill 로만 Supabase 에 적재됨)
 */

const PAGE_SIZE = 10;
const MAX_MONTHS = 36; // 라이브 폴백이 한 번에 훑을 월 상한(과도한 호출 방지)

// 'YYYYMM' 범위를 내림차순 월 배열로. start>end 면 swap.
function monthsDesc(startYM, endYM) {
  let s = startYM;
  let e = endYM;
  if (s > e) [s, e] = [e, s];
  const out = [];
  let y = Number(e.slice(0, 4));
  let m = Number(e.slice(4, 6));
  const sy = Number(s.slice(0, 4));
  const sm = Number(s.slice(4, 6));
  while (y > sy || (y === sy && m >= sm)) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

// 모집공고일('YYYY-MM-DD' | 'YYYY.MM.DD' | …) 내림차순 정렬 키.
const noticeKey = (a) => String(a.noticeDate || '').replace(/[^\d]/g, '');

// 바운디드 병렬 실행.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const emptySummary = {
  totalUnits: 0,
  firstRoundApplications: 0,
  averageCompetitionRate: 0,
  maxCompetitionRate: 0,
  subscriptionResult: '-',
};

/**
 * odcloud 라이브로 과거 한 페이지를 구성. 범위 내 월별 분양정보를 모아
 * 모집공고일 내림차순 정렬 후 해당 페이지만 경쟁률로 enrich.
 * @returns {{apartments, totalCount, source}|null}
 */
async function queryOdcloud({ startDate, endDate, filterRegion, keyword, page }) {
  if (!isOdcloudEnabled()) return null;

  // odcloud 분양정보 하한(2020-02)보다 과거 월은 건너뛴다.
  const start = startDate < ODCLOUD_SUPPLY_FLOOR_YM ? ODCLOUD_SUPPLY_FLOOR_YM : startDate;
  if (endDate < ODCLOUD_SUPPLY_FLOOR_YM) return null;

  let months = monthsDesc(start, endDate);
  if (months.length > MAX_MONTHS) {
    logger.warn(`odcloud fallback: 범위 ${months.length}개월 → 최근 ${MAX_MONTHS}개월로 제한`);
    months = months.slice(0, MAX_MONTHS);
  }

  // 월별 분양정보 수집(바운디드 병렬).
  const perMonth = await mapLimit(months, 4, async (ym) => {
    try {
      return await fetchSupplyMonth({ yyyymm: ym, region: filterRegion, keyword });
    } catch (error) {
      logger.warn(`odcloud 분양정보(${ym}) 실패: ${error.message}`);
      return [];
    }
  });

  const all = perMonth.flat().sort((a, b) => noticeKey(b).localeCompare(noticeKey(a)));
  if (all.length === 0) return null;

  // 현재 페이지 슬라이스만 경쟁률 enrich.
  const from = (page - 1) * PAGE_SIZE;
  const slice = all.slice(from, from + PAGE_SIZE);
  const enriched = await mapLimit(slice, 4, async (a) => {
    let summary = emptySummary;
    try {
      const c = await fetchCompetition({ houseManageNo: a.houseManageNo, pblancNo: a.pblancNo });
      if (c) summary = c.summary;
    } catch (error) {
      logger.warn(`odcloud 경쟁률(${a.houseManageNo}) 실패: ${error.message}`);
    }
    return {
      houseManageNo: a.houseManageNo,
      pblancNo: a.pblancNo,
      region: a.region,
      houseName: a.houseName,
      constructor: a.constructor,
      noticeDate: a.noticeDate,
      subscriptionPeriod: a.subscriptionPeriod,
      announcementDate: a.announcementDate,
      // 경쟁률 미보유(주로 공급만 있는 건)면 공급규모라도 표시.
      totalUnits: summary.totalUnits || a.supplyTotalUnits || 0,
      firstRoundApplications: summary.firstRoundApplications,
      averageCompetitionRate: summary.averageCompetitionRate,
      maxCompetitionRate: summary.maxCompetitionRate,
      subscriptionResult: summary.subscriptionResult,
    };
  });

  return { apartments: enriched, totalCount: all.length, source: 'odcloud' };
}

/**
 * 과거 목록 폴백: Supabase 아카이브 → odcloud 순. 둘 다 없으면 null.
 * 반환 형태는 queryArchive 와 동일(크롤러 enriched shape) + source.
 */
export async function queryHistoricalList(params) {
  // 1) Supabase 아카이브(backfill/write-through 로 채워진 경우)
  const archived = await queryArchive(params);
  if (archived && archived.totalCount > 0) {
    return { ...archived, source: 'archive' };
  }
  // 2) odcloud 라이브
  try {
    return await queryOdcloud(params);
  } catch (error) {
    logger.warn(`odcloud 폴백 실패: ${error.message}`);
    return null;
  }
}

/**
 * 상세 보강: 청약홈 popup 이 비어있는 과거 단지면 odcloud 경쟁률 그리드로 채운다.
 * detail 은 crawler.getApartmentRawDetail 의 반환값(공식 링크 + 빈 competition).
 */
export async function enrichHistoricalDetail(detail) {
  if (!detail || !isOdcloudEnabled()) return detail;
  const hasGeneral = detail.competition && Array.isArray(detail.competition.rows) && detail.competition.rows.length > 0;
  if (hasGeneral) return detail; // 청약홈 popup 이 이미 데이터를 줬다(=5년 이내)
  try {
    const full = await fetchFullCompetition({ houseManageNo: detail.houseManageNo, pblancNo: detail.pblancNo });
    if (full) {
      detail.competition = full.competition;       // 일반공급 경쟁률 + 당첨가점
      detail.specialSupply = full.specialSupply;   // 특별공급 신청현황
      detail.source = 'odcloud';
    }
  } catch (error) {
    logger.warn(`odcloud 상세 경쟁률(${detail.houseManageNo}) 실패: ${error.message}`);
  }
  return detail;
}
