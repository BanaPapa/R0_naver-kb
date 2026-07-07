import logger from './logger.mjs';
import { ApplyHomeCrawler } from './crawler.mjs';
import { validateSearchRequest, validateCrawlRequest } from './validation.mjs';
import { formatNumber } from './dataProcessor.mjs';
import { archivePage, archiveDetail, queryArchive } from './archive.mjs';
import { queryHistoricalList, enrichHistoricalDetail } from './historical.mjs';

/**
 * Framework-agnostic request handlers for the applyhome endpoints.
 * Ported from the former Express src/controllers/* so the same logic can run
 * under a Vite dev middleware (local) or a Vercel serverless function (prod) —
 * there is no standing Express server anymore.
 *
 * JSON handlers return { status, body }. The streaming handler writes Server-
 * Sent Events straight to the Node `res` (and watches `req` for client abort).
 */

const PAGE_SIZE = 10; // applyhome.co.kr native page size

// Accept both YYYYMM and YYYY-MM (the UI sends the latter).
function normalizeYYYYMM(value) {
  if (!value) return value;
  return String(value).replace(/[^\d]/g, '').slice(0, 6);
}

// Parse + validate the shared search query. applyhome supports server-side
// filtering by 공급지역(suplyAreaCode) and 단지명(houseNm), so we never crawl
// every page — region/keyword are pushed down to the source.
function parseSearchParams(query) {
  const normalized = {
    ...query,
    startDate: normalizeYYYYMM(query.startDate),
    endDate: normalizeYYYYMM(query.endDate),
  };
  const { error, value } = validateSearchRequest(normalized);
  if (error) return { error };

  const { startDate, endDate, region, keyword, page } = value;
  if (!startDate || !endDate) {
    return { error: { details: [{ message: 'startDate and endDate are required (YYYYMM)' }] } };
  }

  // '공급지역 전체' (the UI's 전체 option) → no region filter at all.
  const filterRegion = region && region !== '공급지역 전체' ? region : undefined;
  return {
    value: { startDate, endDate, filterRegion, keyword: keyword || undefined, page },
  };
}

function buildPagination(page, totalCount) {
  return {
    currentPage: page,
    totalPages: Math.ceil(totalCount / PAGE_SIZE),
    totalCount,
    hasNextPage: page * PAGE_SIZE < totalCount,
    hasPreviousPage: page > 1,
  };
}

// ── 아카이브 우선 조회 ────────────────────────────────────────
// 청약 결과는 마감되면 바뀌지 않는 확정 과거 데이터이고, 주간 동기화
// (scripts/apply-archive-sync.mjs)가 최근 공고를 계속 아카이브에 적재한다.
// 따라서 "닫힌 범위"(2개월 이전에 끝나는 검색)는 라이브 크롤 없이 아카이브에서
// 바로 서빙하고, 최신 범위(지난달·이번달 포함)만 청약홈 라이브 크롤을 쓴다.
// 아카이브가 비어있으면(동기화 공백) 라이브로 폴백하는 안전망을 유지한다.

// n개월 전의 'YYYYMM'.
function monthsAgoYM(n) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 검색 종료월이 2개월 이전이면 결과가 확정된 닫힌 범위로 본다.
// (주간 동기화 지연을 감안해 지난달·이번달은 라이브로 조회)
const isClosedRange = (endDate) => !!endDate && endDate <= monthsAgoYM(2);

function shapeApartment(a, page, i) {
  return {
    id: (page - 1) * PAGE_SIZE + i + 1,
    houseManageNo: a.houseManageNo,
    pblancNo: a.pblancNo,
    region: a.region,
    houseName: a.houseName,
    constructor: a.constructor,
    noticeDate: a.noticeDate,
    subscriptionPeriod: a.subscriptionPeriod,
    announcementDate: a.announcementDate,
    totalUnits: formatNumber(a.totalUnits),
    firstRoundApplications: formatNumber(a.firstRoundApplications),
    averageCompetitionRate: a.averageCompetitionRate,
    maxCompetitionRate: a.maxCompetitionRate,
    subscriptionResult: a.subscriptionResult,
  };
}

/**
 * GET /api/apartments/search — crawls applyhome.co.kr live and returns a page.
 * Used for pagination (the initial search uses the streaming endpoint to drive
 * the progress modal). Returns { status, body }.
 */
export async function searchApartments(query) {
  const parsed = parseSearchParams(query);
  if (parsed.error) {
    return { status: 400, body: { error: 'Invalid search parameters', details: parsed.error.details } };
  }
  const { startDate, endDate, filterRegion, keyword, page } = parsed.value;

  try {
    // 닫힌 범위(확정 과거)는 아카이브 우선 — 크롤 없이 즉시 응답.
    if (isClosedRange(endDate)) {
      const archived = await queryArchive({ startDate, endDate, filterRegion, keyword, page });
      if (archived && archived.totalCount > 0) {
        const shaped = archived.apartments.map((a, i) => shapeApartment(a, page, i));
        return { status: 200, body: { apartments: shaped, pagination: buildPagination(page, archived.totalCount), source: 'archive' } };
      }
      // 아카이브 공백 → 라이브 크롤로 폴백
    }

    const crawler = new ApplyHomeCrawler();
    // Server-side filtered: 1 count request + 1 page request, regardless of how
    // many total results match — applyhome does the filtering for us.
    const totalCount = await crawler.getTotalCount(startDate, endDate, filterRegion, keyword);

    // applyhome drops 공고 from its list after ~5 years → serve the historical
    // fallback (Supabase archive → odcloud OpenAPI) when live returns nothing.
    if (totalCount === 0) {
      const historical = await queryHistoricalList({ startDate, endDate, filterRegion, keyword, page });
      if (historical) {
        const shaped = historical.apartments.map((a, i) => shapeApartment(a, page, i));
        return { status: 200, body: { apartments: shaped, pagination: buildPagination(page, historical.totalCount), source: historical.source } };
      }
      return { status: 200, body: { apartments: [], pagination: buildPagination(page, 0) } };
    }

    const pageSlice = await crawler.extractApartmentsFromPage(page, startDate, endDate, filterRegion, keyword);
    const apartments = await crawler.enrich(pageSlice);
    await archivePage(apartments, filterRegion); // write-through archive (no-op without Supabase)

    const shaped = apartments.map((a, i) => shapeApartment(a, page, i));
    return { status: 200, body: { apartments: shaped, pagination: buildPagination(page, totalCount) } };
  } catch (error) {
    logger.error('Failed to search apartments:', error.message);
    return { status: 500, body: { error: 'Failed to search apartments', message: error.message } };
  }
}

/**
 * GET /api/apartments/:houseManageNo/detail — official links + 청약결과 tables.
 * Returns { status, body }.
 */
export async function getApartmentDetail(houseManageNo, query = {}) {
  if (!houseManageNo) {
    return { status: 400, body: { error: 'houseManageNo is required' } };
  }
  try {
    const crawler = new ApplyHomeCrawler();
    const detail = await crawler.getApartmentRawDetail({
      houseManageNo,
      pblancNo: query.pblancNo,
      houseName: query.houseNm || query.houseName,
    });
    // >5년 단지는 청약홈 popup 이 비어있음 → odcloud 경쟁률로 보강.
    await enrichHistoricalDetail(detail);
    await archiveDetail(houseManageNo, query.pblancNo, detail); // attach detail to archive (no-op without Supabase)
    return { status: 200, body: detail };
  } catch (error) {
    logger.error('Failed to fetch apartment detail:', error.message);
    return { status: 500, body: { error: 'Failed to fetch apartment detail', message: error.message } };
  }
}

/**
 * GET /api/apartments/search/stream — Server-Sent Events with live progress so
 * the UI can render the 단지정보 수집 modal (matching the Naver app design).
 * Writes directly to the Node `res`; watches `req` for client disconnect.
 *
 * Events: phase | total | listed | progress | done | failed
 */
export async function streamSearch(query, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering so events flush live
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const parsed = parseSearchParams(query);
  if (parsed.error) {
    send('failed', { message: 'Invalid search parameters' });
    return res.end();
  }
  const { startDate, endDate, filterRegion, keyword, page } = parsed.value;

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    send('phase', { phase: 'counting' });

    // 닫힌 범위(확정 과거)는 아카이브 우선 — 크롤 없이 즉시 완료 이벤트.
    if (isClosedRange(endDate)) {
      const archived = await queryArchive({ startDate, endDate, filterRegion, keyword, page });
      if (archived && archived.totalCount > 0) {
        send('total', { totalCount: archived.totalCount, totalPages: Math.ceil(archived.totalCount / PAGE_SIZE), page });
        const shaped = archived.apartments.map((a, i) => shapeApartment(a, page, i));
        send('done', { apartments: shaped, pagination: buildPagination(page, archived.totalCount), source: 'archive' });
        return res.end();
      }
      // 아카이브 공백 → 라이브 크롤로 폴백
    }

    const crawler = new ApplyHomeCrawler();

    const totalCount = await crawler.getTotalCount(startDate, endDate, filterRegion, keyword);

    // applyhome dropped this range (>5yr) → serve the historical fallback
    // (Supabase archive → odcloud OpenAPI) if available.
    if (totalCount === 0) {
      send('phase', { phase: 'historical' });
      const historical = await queryHistoricalList({ startDate, endDate, filterRegion, keyword, page });
      if (historical) {
        send('total', { totalCount: historical.totalCount, totalPages: Math.ceil(historical.totalCount / PAGE_SIZE), page });
        const shaped = historical.apartments.map((a, i) => shapeApartment(a, page, i));
        send('done', { apartments: shaped, pagination: buildPagination(page, historical.totalCount), source: historical.source });
        return res.end();
      }
      send('total', { totalCount: 0, totalPages: 0, page });
      send('done', { apartments: [], pagination: buildPagination(page, 0) });
      return res.end();
    }

    send('total', { totalCount, totalPages: Math.ceil(totalCount / PAGE_SIZE), page });

    const pageSlice = await crawler.extractApartmentsFromPage(page, startDate, endDate, filterRegion, keyword);
    send('listed', {
      items: pageSlice.map((a, i) => ({ index: i, region: a.region, houseName: a.houseName })),
    });

    const apartments = await crawler.enrich(
      pageSlice,
      4,
      (i, stage, data) => {
        if (aborted) return;
        if (stage === 'start') {
          send('progress', { index: i, stage: 'start' });
        } else {
          send('progress', {
            index: i,
            stage: 'done',
            averageCompetitionRate: data.averageCompetitionRate,
            maxCompetitionRate: data.maxCompetitionRate,
            subscriptionResult: data.subscriptionResult,
          });
        }
      },
      () => aborted
    );

    if (aborted) return res.end();

    await archivePage(apartments, filterRegion); // write-through archive (no-op without Supabase)

    const shaped = apartments.map((a, i) => shapeApartment(a, page, i));
    send('done', { apartments: shaped, pagination: buildPagination(page, totalCount) });
  } catch (error) {
    logger.error('Stream search failed:', error.message);
    if (!aborted) send('failed', { message: error.message });
  }
  res.end();
}

/**
 * POST /api/crawl/trigger — legacy no-op kept for UI compatibility. Crawling now
 * happens live inside the search endpoints, so this just validates input.
 */
export function triggerCrawl(body = {}) {
  const normalized = {
    ...body,
    startDate: normalizeYYYYMM(body.startDate),
    endDate: normalizeYYYYMM(body.endDate),
  };
  const { error } = validateCrawlRequest(normalized);
  if (error) {
    return { status: 400, body: { error: 'Invalid request parameters', details: error.details } };
  }
  return {
    status: 200,
    body: { success: true, jobId: 'live', message: '검색 시 실시간으로 크롤링됩니다. 검색 버튼을 눌러주세요.' },
  };
}

export function getCrawlStatus(jobId) {
  return { status: 200, body: { jobId, status: 'completed', progress: 100 } };
}
