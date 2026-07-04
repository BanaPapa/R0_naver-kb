// KB 시계열 데이터 번들 발행 스크립트.
// public/data/*.json 을 gzip 압축해 Supabase Storage 버킷(kb-data)에 업로드하고,
// 버전 매니페스트(versions.json)를 갱신한다. 주간 1회 / 월간 1회 업데이트 시 실행.
//
// 버전은 파일 내용 해시라 데이터가 실제로 바뀐 데이터셋만 버전이 변한다 →
// 클라이언트는 바뀐 번들만 새로 받는다(나머지는 IndexedDB 캐시 사용).
//
// 사용법:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/kb-publish-bundles.mjs
// (service_role 키는 절대 클라이언트/깃에 노출 금지. 로컬 셸 또는 CI 시크릿으로만 주입.)

import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import crypto from 'node:crypto';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.VITE_KB_DATA_BUCKET || 'kb-data';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('환경변수 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.');
  process.exit(1);
}

// 데이터셋 키 → 정적 파일 / Storage 오브젝트(.gz). 클라이언트 config.ts 와 동일 규칙.
const DATASETS = [
  { key: 'weekly', file: 'public/data/kb-weekly.json', object: 'weekly.json.gz' },
  { key: 'weekly-trade', file: 'public/data/kb-weekly-trade.json', object: 'weekly-trade.json.gz' },
  { key: 'monthly', file: 'public/data/kb-monthly.json', object: 'monthly.json.gz' },
  { key: 'monthly-trade', file: 'public/data/kb-monthly-trade.json', object: 'monthly-trade.json.gz' },
  { key: 'monthly-forecast', file: 'public/data/kb-monthly-forecast.json', object: 'monthly-forecast.json.gz' },
];

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// 버킷은 공개(public)로 유지 — KB 시계열은 공개 통계라 비밀이 아니고,
// 공개 버킷이어야 익명(anon) 클라이언트가 정책 없이도 번들을 읽을 수 있다.
async function ensureBucket() {
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (data) {
    if (!data.public) {
      const { error } = await supabase.storage.updateBucket(BUCKET, { public: true });
      if (error) throw error;
      console.log(`버킷 공개 전환: ${BUCKET}`);
    }
    return;
  }
  const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
  if (error && !/already exists/i.test(error.message)) throw error;
  console.log(`버킷 생성(공개): ${BUCKET}`);
}

async function publish() {
  await ensureBucket();
  const versions = {};

  for (const ds of DATASETS) {
    const raw = await readFile(path.resolve(ds.file));
    const version = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
    const gz = gzipSync(raw, { level: 9 });

    const { error } = await supabase.storage.from(BUCKET).upload(ds.object, gz, {
      contentType: 'application/gzip',
      upsert: true,
      cacheControl: '3600',
    });
    if (error) throw new Error(`${ds.object} 업로드 실패: ${error.message}`);

    versions[ds.key] = version;
    console.log(
      `✓ ${ds.object}  ${(raw.length / 1048576).toFixed(2)}MB → gz ${(gz.length / 1048576).toFixed(2)}MB  v=${version}`,
    );
  }

  const manifest = Buffer.from(JSON.stringify(versions, null, 2), 'utf8');
  const { error: mErr } = await supabase.storage.from(BUCKET).upload('versions.json', manifest, {
    contentType: 'application/json',
    upsert: true,
    cacheControl: '0',
  });
  if (mErr) throw new Error(`versions.json 업로드 실패: ${mErr.message}`);

  console.log('✓ versions.json 갱신 완료');
  console.log(JSON.stringify(versions, null, 2));
}

publish().catch((err) => {
  console.error('발행 실패:', err);
  process.exit(1);
});
