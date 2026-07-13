// KB 데이터허브 통계 API로 엑셀 시계열의 소도시 공백을 보강한다 (하이브리드).
//
// 배경: 엑셀 주간/월간 시계열은 시군구 커버리지가 제한적이라 남원시·정읍시 등
//   소도시가 누락된다(전북은 전주/군산/익산만 존재). 반면 KB 데이터허브의 공개
//   통계 API(data-api.kbland.kr)는 전국 시군구 전체를 준다. 이 스크립트는 엑셀
//   산출물(public/data/kb-weekly.json, kb-monthly.json)을 읽어 "기존에 없고 +
//   앱 지역선택자로 도달 가능한" 지역만 API 시계열로 **추가 병합**한다.
//
// 원칙: 추가 전용. 기존 지역/값/날짜축은 절대 수정하지 않는다.
//   날짜축은 기존 파일을 마스터로 삼고, API 값을 날짜 문자열로 정합한다.
//
// 데이터 소스 계약: docs/kbland-datahub-api (메모리) · scripts/kb-ingest.mjs(엑셀)
//
// 사용법:
//   node scripts/kb-api-augment.mjs [--out public/data] [--dry] [--only-weekly|--only-monthly]

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argOf = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const OUT_DIR = argOf('out') ?? 'public/data';
const DRY = args.includes('--dry');
const ONLY_WEEKLY = args.includes('--only-weekly');
const ONLY_MONTHLY = args.includes('--only-monthly');

const STAT = 'https://data-api.kbland.kr/bfmstat/weekMnthlyHuseTrnd/priceIndex';
const LAND = 'https://api.kbland.kr/land-price/price/areaName';
const UA = { 'User-Agent': 'Mozilla/5.0' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => 300 + Math.floor(Math.random() * 400); // 차단 회피: 300~700ms

// ── 시도 표기 매핑 (stats short → 파일 full) ───────────────────
// 근거: kb-regions.mjs CANON + kb-weekly.json 실측 키. 광주는 2026 광주+전남 통합이라
//   파일별로 표기가 다르다(주간 (구)광주광역시/(구)전라남도, 월간 광주광역시/전라남도).
const SIDO_FULL = {
  '서울':'서울특별시','부산':'부산광역시','대구':'대구광역시','인천':'인천광역시',
  '광주':'광주광역시','대전':'대전광역시','울산':'울산광역시','세종':'세종특별자치시',
  '경기':'경기도','강원':'강원특별자치도','충북':'충청북도','충남':'충청남도',
  '전북':'전북특별자치도','전남':'전라남도','경북':'경상북도','경남':'경상남도','제주':'제주특별자치도',
};

// 월간 로더의 sidoKey/keyName 재현 (src/kb/entities/monthly-data/api/monthly-local.ts)
const SIDO_PREFIXES = [
  ['서울','서울'],['부산','부산'],['대구','대구'],['인천','인천'],['광주','광주'],
  ['대전','대전'],['울산','울산'],['세종','세종'],['경기','경기'],
  ['충청북','충북'],['충청남','충남'],
  ['전라남','전남'],['전라북','전북'],['전북','전북'],
  ['경상북','경북'],['경상남','경남'],['강원','강원'],['제주','제주'],
];
const sidoKey = name => { for (const [p, k] of SIDO_PREFIXES) if (name.startsWith(p)) return k; return null; };
const keyName = name => (name.endsWith('시') ? name.slice(0, -1) : name);

// ── stats API ────────────────────────────────────────────────
async function statFetch({ 매매전세코드, 월간주간구분코드, 지역코드 = '', 기간 = '99' }) {
  const p = new URLSearchParams({ 기간, 매매전세코드, 매물종별구분:'01', 월간주간구분코드, 지역코드, type:'false', 메뉴코드:'1' });
  const res = await fetch(`${STAT}?${p}`, { headers: UA });
  if (!res.ok) throw new Error(`stats API HTTP ${res.status}`);
  const j = await res.json();
  if (j?.dataHeader?.resultCode !== '10000') throw new Error(`stats API 오류: ${JSON.stringify(j?.dataHeader)}`);
  const b = j.dataBody?.data ?? {};
  return { dates: b.날짜리스트 ?? [], list: b.데이터리스트 ?? [] };
}

// ── land-price API (셀렉터가 쓰는 지역명/코드) ──────────────────
async function landFetch(step, parentCode) {
  const url = step > 1 && parentCode ? `${LAND}?${new URLSearchParams({ 법정동코드: parentCode })}` : LAND;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`land API HTTP ${res.status}`);
  const items = (await res.json())?.dataBody?.data ?? [];
  const seen = new Set(), out = [];
  for (const it of items) {
    const name = ((step === 1 ? it.대지역명 : it.중지역명) ?? '').trim();
    const code = it.법정동코드.substring(0, step === 1 ? 2 : 5);
    if (name && !seen.has(code)) { seen.add(code); out.push({ name, code }); }
  }
  return out;
}

// buildMidOptions 키 생성 재현 (src/kb/shared/lib/kb-mid-options.ts)
function collectUiKeys(level2, sido, weeklyUi, monthlyReach) {
  const seenCity = new Set();
  for (const it of level2) {
    const name = it.name.trim();
    const parts = name.split(/\s+/);
    if (parts.length >= 2) {
      const [city, ...rest] = parts; const gu = rest.join(' ');
      if (!seenCity.has(city)) { seenCity.add(city); weeklyUi.add(`${sido}|${city}`); }
      weeklyUi.add(`${sido}|${gu}`);
      const sk = sidoKey(sido);
      if (sk) { monthlyReach.add(`${sk}|${keyName(city)}`); monthlyReach.add(`${sk}|${keyName(gu)}`); }
    } else {
      weeklyUi.add(`${sido}|${name}`);
      const sk = sidoKey(sido);
      if (sk) monthlyReach.add(`${sk}|${keyName(name)}`);
    }
  }
}

// ── 매핑: stats (시도-short, 지역명) → 파일 키/경로 ──────────────
function weeklyKeyOf(sidoShort, name) {
  let full = SIDO_FULL[sidoShort];
  if (sidoShort === '광주') full = name.endsWith('구') ? '(구)광주광역시' : '(구)전라남도';
  const parts = name.split(' ');
  return parts.length === 2 ? `${full}|${parts[1]}` : `${full}|${name}`;
}
function monthlyMetaOf(sidoShort, name) {
  let full = SIDO_FULL[sidoShort];
  if (sidoShort === '광주') full = name.endsWith('구') ? '광주광역시' : '전라남도';
  const parts = name.split(' ');
  if (parts.length === 2) {
    const [si, gu] = parts;
    return { path:`전국>${full}>${si}>${gu}`, region:gu, level:4, parentPath:`전국>${full}>${si}` };
  }
  return { path:`전국>${full}>${name}`, region:name, level:3, parentPath:`전국>${full}` };
}

// ── 시계열 조립 유틸 ──────────────────────────────────────────
const isoWeek = d => `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
const isoMonth = d => `${d.slice(0,4)}-${d.slice(4,6)}`;
const numOrNull = v => (typeof v === 'number' && isFinite(v) ? v : null);

// API 응답(1개 시도 드릴)에서 지역코드→ {날짜문자열: 값} 맵 생성
function buildValueMaps({ dates, list }, toIso) {
  const byCode = new Map();
  for (const r of list) {
    const series = (r.dataList ?? []).slice(0, dates.length); // 꼬리 증감요약 제거
    const m = new Map();
    for (let i = 0; i < dates.length; i++) {
      const v = numOrNull(series[i]);
      if (v != null) m.set(toIso(dates[i]), v);
    }
    byCode.set(r.지역코드, m);
  }
  return byCode;
}

// 파일 날짜축에 정합된 배열 생성 (없는 시점 = null)
function alignToAxis(valueMap, axis) {
  return axis.map(d => valueMap?.get(d) ?? null);
}
// 전주비/전월비 등락률(%) 파생 — KB 정의(직전 유효 지수 대비). 값 없으면 null.
function deriveChange(indexArr) {
  const out = new Array(indexArr.length).fill(null);
  let prev = null;
  for (let i = 0; i < indexArr.length; i++) {
    const cur = indexArr[i];
    if (cur != null && prev != null && prev !== 0) out[i] = ((cur - prev) / prev) * 100;
    if (cur != null) prev = cur;
  }
  return out;
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  const weeklyFile = path.join(OUT_DIR, 'kb-weekly.json');
  const monthlyFile = path.join(OUT_DIR, 'kb-monthly.json');
  const weekly = JSON.parse(readFileSync(weeklyFile, 'utf8'));
  const monthly = JSON.parse(readFileSync(monthlyFile, 'utf8'));

  // 1) land-price → UI 도달가능 키집합
  console.log('· land-price 지역 트리 로드…');
  const sidos = await landFetch(1);
  const weeklyUi = new Set(sidos.map(s => s.name)); // 시도 자체
  const monthlyReach = new Set();
  for (const s of sidos) { await sleep(jitter()); collectUiKeys(await landFetch(2, s.code), s.name, weeklyUi, monthlyReach); }
  console.log(`  UI 주간키 ${weeklyUi.size} · 월간도달키 ${monthlyReach.size}`);

  // 2) stats 시도 목록(실제 시도 = 10자리, 집계 제외)
  const top = await statFetch({ 매매전세코드:'01', 월간주간구분코드:'02', 기간:'0' });
  const AGG = /개구|개광역시|수도권|기타지방|^\(구\)/;
  const parents = top.list
    .filter(r => r.지역코드.length === 10 && r.지역코드 !== '0000000000' && !AGG.test(r.지역명))
    .map(r => ({ code: r.지역코드, short: r.지역명 }));

  const wHave = new Set(Object.keys(weekly.data));
  const mHave = new Set(monthly.regions.map(r => r.regionPath));
  const wDates = weekly.dates, mDates = monthly.dates;

  const weeklyAdds = [];  // { key, saleIndex, jeonseIndex, saleChange, jeonseChange }
  const monthlyAdds = []; // { meta, saleAptIndex, jeonseAptIndex }
  let skippedNoData = 0;

  // 3) 시도별로 필요한 지표를 드릴(기간=99) → 하위 전체 시계열 확보
  for (const p of parents) {
    const short = p.short;
    // 이 시도에서 추가 후보 leaf 식별 (드릴 1회로 leaf 이름 확보)
    await sleep(jitter());
    const wSale = await statFetch({ 매매전세코드:'01', 월간주간구분코드:'02', 지역코드:p.code });
    const wSaleMap = buildValueMaps(wSale, isoWeek);
    const leaves = wSale.list.map(r => ({ code: r.지역코드, name: r.지역명 }));

    // 주간: 추가 대상 = 미보유 && UI 도달가능
    const wTargets = leaves.filter(l => {
      const k = weeklyKeyOf(short, l.name);
      return !wHave.has(k) && weeklyUi.has(k);
    });
    // 월간: 추가 대상 = 미보유 && 월간 도달가능 && 부모 존재
    const mTargets = leaves.filter(l => {
      const meta = monthlyMetaOf(short, l.name);
      const reachKey = `${sidoKey(meta.path.split('>')[1])}|${keyName(l.name.includes(' ') ? l.name.split(' ')[1] : l.name)}`;
      return !mHave.has(meta.path) && monthlyReach.has(reachKey) && mHave.has(meta.parentPath);
    });

    // 필요한 추가 드릴만 수행
    let wJeonseMap = null, mSaleMap = null, mJeonseMap = null, mSaleDates = null;
    if (!ONLY_MONTHLY && wTargets.length) {
      await sleep(jitter());
      wJeonseMap = buildValueMaps(await statFetch({ 매매전세코드:'02', 월간주간구분코드:'02', 지역코드:p.code }), isoWeek);
    }
    if (!ONLY_WEEKLY && mTargets.length) {
      await sleep(jitter());
      const ms = await statFetch({ 매매전세코드:'01', 월간주간구분코드:'01', 지역코드:p.code });
      mSaleMap = buildValueMaps(ms, isoMonth); mSaleDates = ms.dates;
      await sleep(jitter());
      mJeonseMap = buildValueMaps(await statFetch({ 매매전세코드:'02', 월간주간구분코드:'01', 지역코드:p.code }), isoMonth);
    }

    if (!ONLY_MONTHLY) for (const l of wTargets) {
      const key = weeklyKeyOf(short, l.name);
      const saleIndex = alignToAxis(wSaleMap.get(l.code), wDates);
      const jeonseIndex = alignToAxis(wJeonseMap?.get(l.code), wDates);
      if (!saleIndex.some(v => v != null) && !jeonseIndex.some(v => v != null)) { skippedNoData++; continue; }
      weeklyAdds.push({ key, saleIndex, jeonseIndex, saleChange: deriveChange(saleIndex), jeonseChange: deriveChange(jeonseIndex) });
    }
    if (!ONLY_WEEKLY) for (const l of mTargets) {
      const meta = monthlyMetaOf(short, l.name);
      const saleAptIndex = alignToAxis(mSaleMap?.get(l.code), mDates);
      const jeonseAptIndex = alignToAxis(mJeonseMap?.get(l.code), mDates);
      if (!saleAptIndex.some(v => v != null) && !jeonseAptIndex.some(v => v != null)) { skippedNoData++; continue; }
      monthlyAdds.push({ meta, saleAptIndex, jeonseAptIndex });
    }
    console.log(`  ${short}: 주간 +${!ONLY_MONTHLY ? wTargets.length : 0} · 월간 +${!ONLY_WEEKLY ? mTargets.length : 0}`);
  }

  // 4) 병합 (추가 전용)
  for (const a of weeklyAdds) {
    if (weekly.data[a.key]) throw new Error(`무결성 위반: 기존 주간 키 덮어쓰기 시도 — ${a.key}`);
    weekly.data[a.key] = { saleChange: a.saleChange, jeonseChange: a.jeonseChange, saleIndex: a.saleIndex, jeonseIndex: a.jeonseIndex };
  }
  for (const a of monthlyAdds) {
    if (monthly.data[a.meta.path]) throw new Error(`무결성 위반: 기존 월간 경로 덮어쓰기 시도 — ${a.meta.path}`);
    monthly.data[a.meta.path] = { saleAptIndex: a.saleAptIndex, jeonseAptIndex: a.jeonseAptIndex };
    monthly.regions.push({ regionPath: a.meta.path, region: a.meta.region, level: a.meta.level, parentPath: a.meta.parentPath });
  }

  // 5) 무결성 검증
  const check = (cond, msg) => { if (!cond) throw new Error(`무결성 검증 실패: ${msg}`); };
  check(weekly.dates.length === wDates.length, '주간 날짜축 길이 변경됨');
  check(monthly.dates.length === mDates.length, '월간 날짜축 길이 변경됨');
  for (const a of weeklyAdds) for (const m of ['saleIndex','jeonseIndex','saleChange','jeonseChange'])
    check(weekly.data[a.key][m].length === wDates.length, `주간 배열 길이 불일치 ${a.key}.${m}`);
  for (const a of monthlyAdds) for (const m of ['saleAptIndex','jeonseAptIndex'])
    check(monthly.data[a.meta.path][m].length === mDates.length, `월간 배열 길이 불일치 ${a.meta.path}.${m}`);
  for (const must of ['전국','서울특별시|강남구','경기도|수원시','전북특별자치도|전주시'])
    check(!!weekly.data[must], `주간 필수 지역 소실 ${must}`);
  for (const must of ['전국','전국>서울특별시>강남구','전국>전북특별자치도>전주시'])
    check(monthly.regions.some(r => r.regionPath === must), `월간 필수 경로 소실 ${must}`);
  // 월간 부모 존재(트리 무결성)
  for (const a of monthlyAdds)
    check(monthly.regions.some(r => r.regionPath === a.meta.parentPath), `월간 부모 경로 없음 ${a.meta.parentPath}`);

  // 6) 리포트 + 쓰기
  console.log(`\n── 결과`);
  console.log(`   주간 추가 ${weeklyAdds.length}개  (샘플: ${weeklyAdds.slice(0,8).map(a=>a.key.split('|')[1]).join(', ')}${weeklyAdds.length>8?' …':''})`);
  console.log(`   월간 추가 ${monthlyAdds.length}개  (샘플: ${monthlyAdds.slice(0,8).map(a=>a.meta.region).join(', ')}${monthlyAdds.length>8?' …':''})`);
  console.log(`   데이터 없어 스킵 ${skippedNoData}개`);
  console.log(`   주간 총지역 ${Object.keys(weekly.data).length} · 월간 총지역 ${monthly.regions.length}`);

  if (DRY) { console.log('\n(dry-run — 파일을 쓰지 않았습니다)'); return; }
  if (!ONLY_MONTHLY) { writeFileSync(weeklyFile, JSON.stringify(weekly), 'utf8'); console.log(`   ✓ 저장: ${weeklyFile}`); }
  if (!ONLY_WEEKLY)  { writeFileSync(monthlyFile, JSON.stringify(monthly), 'utf8'); console.log(`   ✓ 저장: ${monthlyFile}`); }
  console.log('\n완료. 다음 단계: node scripts/kb-publish-bundles.mjs (Supabase 배포 시)');
}

main().catch(e => { console.error('\n실패:', e.message); process.exit(1); });
