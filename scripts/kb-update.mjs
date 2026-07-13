// KB 시계열 완전 자동 갱신: 확인 → 다운로드 → 인제스트 → (옵션) 발행.
//
// KB부동산 통계 API(api.kbland.kr, 인증 불필요)에서 최신 주간/월간 시계열 파일을 확인하고,
// 새 파일이면 내려받아 kb-ingest.mjs 로 public/data/*.json 을 재생성한 뒤, kb-api-augment.mjs 로
// 엑셀에 없는 소도시(남원시 등)를 KB 데이터허브 API로 추가 병합한다.
// 같은 파일이면 아무것도 하지 않는다(멱등) — 스케줄러가 매주 돌려도 안전하다.
//
// ⚠️ 인제스트는 JSON을 통째로 재생성하므로 소도시 보강도 매 갱신마다 다시 적용해야 한다.
//    (보강 없이 발행하면 프로덕션에서 소도시가 사라진다 → 보강은 발행 전 필수 단계.)
//
// 사용법:
//   node scripts/kb-update.mjs               # 확인 + 다운로드 + 인제스트
//   node scripts/kb-update.mjs --publish     # + Supabase 발행(.env.kb-publish 필요)
//   node scripts/kb-update.mjs --force       # 최신 여부 무시하고 다시 다운로드
//   node scripts/kb-update.mjs --check       # 새 파일 있는지 확인만 (다운로드 없음)
//
// 무인 실행(Windows 작업 스케줄러): docs/KB_UPDATE_RUNBOOK.md 참고.
// 엑셀 원본은 data-src/ (git 미추적)에 보관, 상태는 data-src/.state.json.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'data-src');
// 상태 파일은 git에 커밋되는 위치에 둔다 — GitHub Actions처럼 매번 새로 체크아웃하는
// 환경에서도 "마지막으로 반영한 파일"을 기억해 불필요한 재다운로드를 막는다.
const STATE_FILE = path.join(ROOT, 'public', 'data', '.kb-state.json');
const LEGACY_STATE_FILE = path.join(SRC_DIR, '.state.json');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const PUBLISH = args.includes('--publish');
const CHECK_ONLY = args.includes('--check');

const API = 'https://api.kbland.kr/land-extra/statistics/reference';
const DOWN = 'https://api.kbland.kr/land-extra/statistics/getfiledown';
const HEADERS = {
  Referer: 'https://kbland.kr/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
};

const iso = d => d.toISOString().slice(0, 10);
const log = msg => console.log(`[kb-update ${new Date().toLocaleString('sv-SE')}] ${msg}`);

// 통계 자료실 목록 조회. 주월간구분: 0=주간, 1=월간.
async function fetchReference(weekMonth) {
  const now = new Date();
  const from = new Date(now.getTime() - 45 * 86400000);
  const to = new Date(now.getTime() + 40 * 86400000);
  const qs = new URLSearchParams({
    주월간구분: String(weekMonth),
    기준년월시작일: iso(from),
    기준년월종료일: iso(to),
  });
  const res = await fetch(`${API}?${qs}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`통계 목록 조회 실패(${weekMonth}): HTTP ${res.status}`);
  const json = await res.json();
  if (json?.dataHeader?.resultCode !== '10000') {
    throw new Error(`통계 목록 응답 오류: ${json?.dataHeader?.message ?? 'unknown'}`);
  }
  return json.dataBody.data;
}

// 시계열 항목 선택 — 월간은 주택/오피스텔 두 파일이 있어 파일명으로 거른다.
function pickTimeseries(data, namePattern, label) {
  const list = data?.['시계열'] ?? [];
  const hit = list.find(e => namePattern.test(e?.원본파일명 ?? ''));
  if (!hit) throw new Error(`${label} 시계열 항목을 찾지 못했습니다 (API 구조 변화 가능).`);
  return {
    name: hit.원본파일명,
    urlpath: `${hit.파일경로}/${hit.파일명}`,
    registered: hit.등록일시,
  };
}

async function download(entry, dest) {
  const qs = new URLSearchParams({ urlpath: entry.urlpath, filename: entry.name });
  const res = await fetch(`${DOWN}?${qs}`, { headers: HEADERS });
  if (!res.ok || !res.body) throw new Error(`다운로드 실패(${entry.name}): HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const head = readFileSync(dest).subarray(0, 2).toString('latin1');
  if (head !== 'PK') throw new Error(`다운로드 파일이 xlsx 형식이 아닙니다(${entry.name}) — 응답이 오류 페이지일 수 있음.`);
}

function loadState() {
  for (const file of [STATE_FILE, LEGACY_STATE_FILE]) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      /* 다음 후보 */
    }
  }
  return {};
}

// 발행용 시크릿 로드 — 우선순위: 프로세스 환경변수(CI) → .env.kb-publish 파일(로컬, git 미추적).
function loadPublishEnv() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  }
  const file = path.join(ROOT, '.env.kb-publish');
  if (!existsSync(file)) return null;
  const env = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? env : null;
}

async function main() {
  mkdirSync(SRC_DIR, { recursive: true });
  const state = loadState();

  // 1) 최신 파일 확인
  const [weeklyData, monthlyData] = await Promise.all([fetchReference(0), fetchReference(1)]);
  const weekly = pickTimeseries(weeklyData, /주간시계열\.xlsx$/, '주간');
  const monthly = pickTimeseries(monthlyData, /월간 ?주택 ?시계열\.xlsx$/, '월간');
  log(`서버 최신 — 주간: ${weekly.name} (등록 ${weekly.registered}) · 월간: ${monthly.name} (등록 ${monthly.registered})`);
  log(`로컬 상태 — 주간: ${state.weekly ?? '(없음)'} · 월간: ${state.monthly ?? '(없음)'}`);

  const weeklyNew = FORCE || state.weekly !== weekly.name;
  const monthlyNew = FORCE || state.monthly !== monthly.name;
  if (!weeklyNew && !monthlyNew) {
    log('이미 최신입니다 — 할 일 없음.');
    return;
  }
  if (CHECK_ONLY) {
    log(`갱신 필요: ${[weeklyNew && '주간', monthlyNew && '월간'].filter(Boolean).join(', ')} (--check 모드, 다운로드 생략)`);
    process.exitCode = 2; // 스케줄러/스크립트에서 "갱신 있음" 신호로 사용 가능
    return;
  }

  // 2) 다운로드 (항상 둘 다 최신 파일 확보 — 인제스트는 두 파일을 함께 요구)
  const weeklyPath = path.join(SRC_DIR, weekly.name);
  const monthlyPath = path.join(SRC_DIR, monthly.name);
  if (weeklyNew || !existsSync(weeklyPath)) {
    log(`주간 다운로드: ${weekly.name}`);
    await download(weekly, weeklyPath);
  }
  if (monthlyNew || !existsSync(monthlyPath)) {
    log(`월간 다운로드: ${monthly.name}`);
    await download(monthly, monthlyPath);
  }

  // 3) 인제스트 (kb-ingest.mjs 가 diff 리포트·무결성 검증 포함)
  log('인제스트 실행…');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'kb-ingest.mjs'), '--weekly', weeklyPath, '--monthly', monthlyPath], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  // 3-2) 소도시 API 보강 (엑셀에 없는 시군구를 KB 데이터허브 공개 API로 add-only 병합).
  //      인제스트가 JSON을 재생성했으므로 매번 다시 적용해야 남원시 등이 유지된다.
  //      의존성 없음(node 내장 fetch/fs)이라 CI 추가 설치 불필요. 실패 시 발행/커밋 없이 중단
  //      (execFileSync 가 throw → main catch → exit 1) → 옛 번들이 유지돼 소도시 소실을 막는다.
  log('소도시 API 보강 실행…');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'kb-api-augment.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  // 4) 발행 (옵션 — .env.kb-publish 의 시크릿 필요)
  if (PUBLISH) {
    const env = loadPublishEnv();
    if (!env) {
      log('발행 건너뜀: .env.kb-publish 가 없거나 SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY 누락.');
    } else {
      log('Supabase 발행 실행…');
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'kb-publish-bundles.mjs')], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, ...env },
      });
    }
  }

  // 5) 상태 저장 (인제스트 성공 후에만)
  writeFileSync(STATE_FILE, JSON.stringify({ weekly: weekly.name, monthly: monthly.name, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  log(`완료 — 주간 ${weekly.name} / 월간 ${monthly.name} 반영.`);
}

main().catch(err => {
  console.error(`[kb-update] 실패: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
