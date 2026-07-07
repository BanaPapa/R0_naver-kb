import { getSupabaseAdmin } from '../supabase/serverClient.mjs';
import logger from './logger.mjs';

/**
 * 청약 archive (Supabase). Purpose: applyhome drops 공고 from its search list
 * after ~5 years, so we persist every crawled 단지 to preserve the data and to
 * cache results. Every call is a no-op when Supabase is not configured, so the
 * app runs identically as pure live-crawl without credentials.
 *
 * Tables (see supabase/apply-schema.sql, all `apply_` prefixed to coexist with
 * naver-kb's tables in the shared instance):
 *   apply_announcements           — 단지/공고 master + latest summary + detail jsonb
 *   apply_competition_snapshots   — daily time-series of 경쟁률 (one row/day/단지)
 */

const PAGE_SIZE = 10;

// noticeDate ('2024.01.15' | '2024-01-15' | …) → 'YYYYMM' for range filtering.
function toNoticeMonth(noticeDate) {
  if (!noticeDate) return null;
  const digits = String(noticeDate).replace(/[^\d]/g, '');
  return digits.length >= 6 ? digits.slice(0, 6) : null;
}

// today's date as 'YYYY-MM-DD' (snapshot key). Server-local date is fine.
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function toAnnouncementRow(a, supplyAreaCode) {
  return {
    house_manage_no: a.houseManageNo,
    pblanc_no: a.pblancNo || a.houseManageNo,
    supply_area_code: supplyAreaCode || null,
    region: a.region || null,
    house_name: a.houseName || null,
    constructor: a.constructor || null,
    notice_date: a.noticeDate || null,
    notice_month: toNoticeMonth(a.noticeDate),
    subscription_period: a.subscriptionPeriod || null,
    announcement_date: a.announcementDate || null,
    total_units: Number.isFinite(a.totalUnits) ? a.totalUnits : null,
    first_round_applications: Number.isFinite(a.firstRoundApplications) ? a.firstRoundApplications : null,
    average_competition_rate: Number.isFinite(a.averageCompetitionRate) ? a.averageCompetitionRate : null,
    max_competition_rate: Number.isFinite(a.maxCompetitionRate) ? a.maxCompetitionRate : null,
    subscription_result: a.subscriptionResult || null,
    last_crawled_at: new Date().toISOString(),
  };
}

/**
 * Write-through: upsert the freshly enriched page into the archive and append a
 * daily competition snapshot. Fire-and-forget (never blocks/breaks the response).
 *
 * @param {Array}  enriched         raw enriched listings (numeric fields, pre-shape)
 * @param {string} [supplyAreaCode] the suplyAreaCode the page was crawled with
 */
export async function archivePage(enriched, supplyAreaCode) {
  const _sb = getSupabaseAdmin(); if (!_sb || !Array.isArray(enriched) || enriched.length === 0) return;
  try {
    const rows = enriched.map((a) => toAnnouncementRow(a, supplyAreaCode));
    const { error } = await _sb
      .from('apply_announcements')
      .upsert(rows, { onConflict: 'house_manage_no,pblanc_no' });
    if (error) throw error;

    const day = todayKey();
    const snapshots = enriched
      .filter((a) => Number.isFinite(a.averageCompetitionRate))
      .map((a) => ({
        house_manage_no: a.houseManageNo,
        pblanc_no: a.pblancNo || a.houseManageNo,
        snapshot_date: day,
        average_competition_rate: a.averageCompetitionRate,
        max_competition_rate: a.maxCompetitionRate,
        subscription_result: a.subscriptionResult || null,
      }));
    if (snapshots.length) {
      const { error: snapErr } = await _sb
        .from('apply_competition_snapshots')
        .upsert(snapshots, { onConflict: 'house_manage_no,pblanc_no,snapshot_date' });
      if (snapErr) throw snapErr;
    }
  } catch (error) {
    // archive is best-effort — log and move on, never fail the user's request.
    logger.warn(`Archive write failed: ${error.message}`);
  }
}

/**
 * Attach the full detail (일반/특별공급 tables + official links) to an archived
 * announcement. Called when a 단지 detail popup is fetched.
 */
export async function archiveDetail(houseManageNo, pblancNo, detail) {
  const _sb = getSupabaseAdmin(); if (!_sb || !detail) return;
  try {
    const { error } = await _sb
      .from('apply_announcements')
      .update({ detail, last_crawled_at: new Date().toISOString() })
      .eq('house_manage_no', houseManageNo)
      .eq('pblanc_no', pblancNo || houseManageNo);
    if (error) throw error;
  } catch (error) {
    logger.warn(`Archive detail write failed for ${houseManageNo}: ${error.message}`);
  }
}

// Map an archived row back to the crawler's enriched shape (so handlers can
// shape it identically to live results).
function fromAnnouncementRow(r) {
  return {
    houseManageNo: r.house_manage_no,
    pblancNo: r.pblanc_no,
    region: r.region,
    houseName: r.house_name,
    constructor: r.constructor,
    noticeDate: r.notice_date,
    subscriptionPeriod: r.subscription_period,
    announcementDate: r.announcement_date,
    totalUnits: r.total_units || 0,
    firstRoundApplications: r.first_round_applications || 0,
    averageCompetitionRate: r.average_competition_rate ?? null,
    maxCompetitionRate: r.max_competition_rate ?? null,
    subscriptionResult: r.subscription_result || '-',
  };
}

// applyhome 공급지역 단축명 → 아카이브 region 접두 변형.
// 수작업 백필(2015~) 데이터는 supply_area_code 가 없고 region 표기가
// 장·단 혼재('서울'/'서울특별시'/'서울시', '전북'/'전라북도' 등)라 접두 매칭으로 흡수한다.
const REGION_PREFIX_VARIANTS = {
  '전북': ['전북', '전라북'],
  '전남': ['전남', '전라남'],
  '경북': ['경북', '경상북'],
  '경남': ['경남', '경상남'],
  '충북': ['충북', '충청북'],
  '충남': ['충남', '충청남'],
};

/**
 * Read fallback: serve archived 청약 data for a date range when applyhome no
 * longer lists it (the >5yr case). Returns { apartments, totalCount } in the
 * crawler's enriched shape, or null when the archive is unavailable/empty.
 *
 * Region filtering: supply_area_code(라이브 write-through 데이터) 일치 또는
 * region 접두 일치(수작업 백필 데이터) — 둘 중 하나면 매칭.
 */
export async function queryArchive({ startDate, endDate, filterRegion, keyword, page }) {
  const _sb = getSupabaseAdmin();
  if (!_sb) return null;
  try {
    let q = _sb
      .from('apply_announcements')
      .select('*', { count: 'exact' })
      .order('notice_month', { ascending: false })
      .order('house_name', { ascending: true });

    if (startDate) q = q.gte('notice_month', startDate);
    if (endDate) q = q.lte('notice_month', endDate);
    if (filterRegion) {
      const prefixes = REGION_PREFIX_VARIANTS[filterRegion] ?? [filterRegion];
      const ors = [
        `supply_area_code.eq.${filterRegion}`,
        ...prefixes.map((p) => `region.like.${p}*`),
      ];
      q = q.or(ors.join(','));
    }
    if (keyword) q = q.ilike('house_name', `%${keyword}%`);

    const from = (page - 1) * PAGE_SIZE;
    q = q.range(from, from + PAGE_SIZE - 1);

    const { data, count, error } = await q;
    if (error) throw error;
    if (!count) return null;

    return { apartments: (data || []).map(fromAnnouncementRow), totalCount: count };
  } catch (error) {
    logger.warn(`Archive query failed: ${error.message}`);
    return null;
  }
}
