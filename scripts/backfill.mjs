#!/usr/bin/env node
/**
 * 과거 청약 데이터 백필 — Supabase apply_announcements / apply_competition_snapshots
 * 를 2015년부터 현재까지 채운다. 청약홈은 목록을 ~5년만 노출하므로, 사용자가 과거
 * 연월을 조회해도 끊김 없이 결과가 나오도록 영구 아카이브를 미리 적재하는 용도.
 *
 * 데이터 소스(연월에 따라 자동 선택):
 *   • 2020-02 이후 : odcloud OpenAPI — 분양정보(공급) + 경쟁률(요약 + 상세 그리드)
 *   • 2015 ~ 2020-01 : 청약홈 detail 페이지 직접 스캔 — 공급정보만(경쟁률은 어디에도 없음)
 *
 * 멱등: (house_manage_no, pblanc_no) upsert 라 몇 번 돌려도 안전.
 *
 * 필요 env (.env):
 *   SUPABASE_URL (또는 VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY, ODCLOUD_SERVICE_KEY
 *
 * 사용(.env 로드는 Node 의 --env-file 사용 — 별도 dotenv 의존성 없음):
 *   node --env-file=.env scripts/backfill.mjs                    # 2015-01 ~ 이번달 전체
 *   node --env-file=.env scripts/backfill.mjs --from 2020-02     # odcloud 구간만(권장 1차)
 *   node --env-file=.env scripts/backfill.mjs --from 2020-02 --to 2026-06
 *   node --env-file=.env scripts/backfill.mjs --skip-old         # 2015~2020-01 청약홈 스캔 생략
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { getSupabaseAdmin } from '../lib/supabase/serverClient.mjs';
import {
  isOdcloudEnabled,
  fetchSupplyMonth,
  fetchFullCompetition,
  ODCLOUD_SUPPLY_FLOOR_YM,
} from '../lib/applyhome/odcloud.mjs';

const APPLYHOME = 'https://www.applyhome.co.kr';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── args ──────────────────────────────────────────────
function parseArgs(argv) {
  const a = { from: '201501', to: null, skipOld: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') a.from = (argv[++i] ?? '').replace(/[^\d]/g, '').slice(0, 6) || a.from;
    else if (argv[i] === '--to') a.to = (argv[++i] ?? '').replace(/[^\d]/g, '').slice(0, 6) || null;
    else if (argv[i] === '--skip-old') a.skipOld = true;
  }
  if (!a.to) {
    const d = new Date();
    a.to = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  return a;
}

function monthsAsc(startYM, endYM) {
  const out = [];
  let y = Number(startYM.slice(0, 4));
  let m = Number(startYM.slice(4, 6));
  const ey = Number(endYM.slice(0, 4));
  const em = Number(endYM.slice(4, 6));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

const digits = (s) => String(s || '').replace(/[^\d]/g, '');
const num = (v) => { const n = parseInt(digits(v), 10); return Number.isFinite(n) ? n : 0; };

// ── upsert helpers ────────────────────────────────────
async function upsertAnnouncements(rows) {
  if (!rows.length) return;
  const { error } = await getSupabaseAdmin()
    .from('apply_announcements')
    .upsert(rows, { onConflict: 'house_manage_no,pblanc_no' });
  if (error) throw new Error(`announcements upsert: ${error.message}`);
}

async function upsertSnapshots(rows, snapshotDate) {
  if (!rows.length) return;
  const snaps = rows.map((s) => ({ ...s, snapshot_date: snapshotDate }));
  const { error } = await getSupabaseAdmin()
    .from('apply_competition_snapshots')
    .upsert(snaps, { onConflict: 'house_manage_no,pblanc_no,snapshot_date' });
  if (error) throw new Error(`snapshots upsert: ${error.message}`);
}

// ── odcloud 구간(>=2020-02) ───────────────────────────
async function backfillOdcloudMonth(ym) {
  const supply = await fetchSupplyMonth({ yyyymm: ym });
  if (!supply.length) return { count: 0, withRate: 0 };

  const announcements = [];
  const snapshots = [];
  let withRate = 0;

  // 단지별 경쟁률 + 당첨가점 + 특별공급(순차로 안전하게).
  for (const a of supply) {
    let summary = null;
    let competition = { rows: [] };
    let specialSupply = null;
    try {
      const full = await fetchFullCompetition({ houseManageNo: a.houseManageNo, pblancNo: a.pblancNo });
      if (full) {
        summary = full.summary;
        competition = full.competition;
        specialSupply = full.specialSupply;
        if (summary) withRate += 1;
      }
    } catch { /* 경쟁률 없음(미접수/공급만) — 공급정보만 적재 */ }
    await sleep(60);

    announcements.push({
      house_manage_no: a.houseManageNo,
      pblanc_no: a.pblancNo,
      supply_area_code: a.region || null,
      region: a.region || null,
      house_name: a.houseName || null,
      constructor: a.constructor || null,
      notice_date: a.noticeDate || null,
      notice_month: digits(a.noticeDate).slice(0, 6) || ym,
      subscription_period: a.subscriptionPeriod || null,
      announcement_date: a.announcementDate || null,
      total_units: summary ? summary.totalUnits || a.supplyTotalUnits : a.supplyTotalUnits || null,
      first_round_applications: summary ? summary.firstRoundApplications : null,
      average_competition_rate: summary ? summary.averageCompetitionRate : null,
      max_competition_rate: summary ? summary.maxCompetitionRate : null,
      subscription_result: summary ? summary.subscriptionResult : null,
      detail: {
        competition,
        specialSupply,
        homepageUrl: a.homepageUrl || null,
        noticeUrl: null,
        detailUrl: a.detailUrl || `${APPLYHOME}/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=${a.houseManageNo}&pblancNo=${a.pblancNo}`,
        source: 'odcloud',
      },
      last_crawled_at: new Date().toISOString(),
    });
    if (summary && Number.isFinite(summary.averageCompetitionRate)) {
      snapshots.push({
        house_manage_no: a.houseManageNo,
        pblanc_no: a.pblancNo,
        average_competition_rate: summary.averageCompetitionRate,
        max_competition_rate: summary.maxCompetitionRate,
        subscription_result: summary.subscriptionResult || null,
      });
    }
  }

  await upsertAnnouncements(announcements);
  // 과거 경쟁률은 확정값 → 모집공고일 기준 날짜로 스냅샷 1건 적재(시계열 기준점).
  await upsertSnapshots(snapshots, `${ym.slice(0, 4)}-${ym.slice(4, 6)}-01`);
  return { count: announcements.length, withRate };
}

// ── 청약홈 detail 스캔 구간(2015 ~ 2020-01, 공급정보만) ──
// houseManageNo = YYYY + 6자리 일련번호(연도내 공고일순). 연도별로 1부터 스캔.
async function fetchDetailSupply(hmno) {
  try {
    const res = await axios.get(`${APPLYHOME}/ai/aia/selectAPTLttotPblancDetail.do`, {
      params: { houseManageNo: hmno, pblancNo: hmno },
      headers: { 'User-Agent': UA }, responseType: 'arraybuffer', timeout: 20000, validateStatus: () => true,
    });
    const t = cheerio.load(res.data.toString('utf-8'))('body').text().replace(/\s+/g, ' ').trim();
    if (t.length < 2500) return null;
    const date = (t.match(/모집공고일\s+(20\d{2}-\d{2}-\d{2})/) || [])[1];
    if (!date) return null;
    // 전각문자(ＡＢ１５, （）) 포함, "입주자모집공고 주요정보" 중복 prefix 건너뜀
    const nameRaw = (t.match(/주요정보\s+(?:입주자모집공고\s+주요정보\s+)?(.{2,60}?)\s+공급위치/) || [])[1] || '';
    const name = nameRaw.replace(/^입주자모집공고\s+주요정보\s+/, '').trim();
    const loc = (t.match(/공급위치\s+(.{4,80}?)\s+공급규모/) || [])[1]?.trim() || '';
    const scale = num((t.match(/공급규모\s+([\d,]+)\s*세대/) || [])[1]);
    return { hmno, date, name: name.trim(), loc: loc.trim(), scale };
  } catch { return null; }
}

async function backfillApplyhomeYear(year, untilYM) {
  let seq = 1;
  let consecutiveMiss = 0;
  const rows = [];
  while (consecutiveMiss < 25 && seq <= 2000) {
    const hmno = `${year}${String(seq).padStart(6, '0')}`;
    const d = await fetchDetailSupply(hmno);
    seq += 1;
    if (!d) { consecutiveMiss += 1; await sleep(40); continue; }
    consecutiveMiss = 0;
    const ym = digits(d.date).slice(0, 6);
    if (untilYM && ym > untilYM) break; // 목표 상한 초과(2020-01 등) → 중단
    rows.push({
      house_manage_no: hmno,
      pblanc_no: hmno,
      supply_area_code: null,
      region: (d.loc.split(' ')[0] || '').slice(0, 6) || null,
      house_name: d.name || null,
      constructor: null,
      notice_date: d.date,
      notice_month: ym,
      subscription_period: null,
      announcement_date: null,
      total_units: d.scale || null,
      first_round_applications: null,
      average_competition_rate: null,
      max_competition_rate: null,
      subscription_result: null,
      detail: {
        competition: { rows: [] },
        specialSupply: null,
        homepageUrl: null,
        noticeUrl: null,
        detailUrl: `${APPLYHOME}/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=${hmno}&pblancNo=${hmno}`,
        source: 'applyhome-detail',
        supplyLocation: d.loc,
      },
      last_crawled_at: new Date().toISOString(),
    });
    await sleep(40);
  }
  await upsertAnnouncements(rows);
  return rows.length;
}

// ── main ──────────────────────────────────────────────
(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!getSupabaseAdmin()) {
    console.error('✗ Supabase 미설정 — .env 에 SUPABASE_URL(또는 VITE_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY 필요');
    process.exit(1);
  }
  if (!isOdcloudEnabled()) {
    console.error('✗ ODCLOUD_SERVICE_KEY 미설정 — .env 에 추가 필요');
    process.exit(1);
  }
  console.log(`백필 범위: ${args.from} ~ ${args.to}  (odcloud 하한 ${ODCLOUD_SUPPLY_FLOOR_YM}, skipOld=${args.skipOld})`);

  // 1) odcloud 구간 (월 단위)
  const months = monthsAsc(args.from < ODCLOUD_SUPPLY_FLOOR_YM ? ODCLOUD_SUPPLY_FLOOR_YM : args.from, args.to);
  let total = 0;
  for (const ym of months) {
    try {
      const { count, withRate } = await backfillOdcloudMonth(ym);
      total += count;
      console.log(`  [odcloud ${ym}] ${count}건 (경쟁률 ${withRate}건)  누적 ${total}`);
    } catch (e) {
      console.error(`  [odcloud ${ym}] 실패: ${e.message}`);
    }
  }

  // 2) 청약홈 detail 스캔 구간 (2015 ~ 2020-01) — 공급정보만
  if (!args.skipOld && args.from < ODCLOUD_SUPPLY_FLOOR_YM) {
    const startYear = Number(args.from.slice(0, 4));
    const floorYear = Number(ODCLOUD_SUPPLY_FLOOR_YM.slice(0, 4)); // 2020
    for (let year = startYear; year <= floorYear; year += 1) {
      // 2020 은 2020-01 까지만(2020-02+ 는 odcloud 가 담당).
      const untilYM = year === floorYear ? '202001' : `${year}12`;
      try {
        const n = await backfillApplyhomeYear(year, untilYM);
        total += n;
        console.log(`  [청약홈 ${year}] ${n}건(공급만)  누적 ${total}`);
      } catch (e) {
        console.error(`  [청약홈 ${year}] 실패: ${e.message}`);
      }
    }
  }

  console.log(`\n✓ 백필 완료 — 총 ${total}건 적재/갱신`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
