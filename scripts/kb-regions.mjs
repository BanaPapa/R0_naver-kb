// KB 시계열 지역 정규화 테이블 + 계층 추적기.
// 근거: docs/KB_TIMESERIES_DATA_REPORT.md §2·§3-3 (열 순서 기반 계층, 동명 구, 명칭 세대 차이)

// 헤더 셀 → 한글 지역 라벨. 줄바꿈·영문 병기·공백 제거.
// 예: "부산광역시\n  Pusan" → "부산광역시", "강북\n14개구" → "강북14개구"
export function normalizeLabel(cell) {
  if (cell == null) return '';
  const compact = String(cell).replace(/\s+/g, '');
  const m = compact.match(/^[가-힣0-9()外/]+/);
  if (!m) return '';
  let label = m[0];
  // 영문 병기가 숫자로 시작하면 그 숫자가 라벨에 붙는다("6개광역시 6 Large…" → "6개광역시6") — 제거
  if (/^[A-Za-z]/.test(compact.slice(label.length))) {
    const dm = label.match(/^(.*[가-힣)])\d+$/);
    if (dm) label = dm[1];
  }
  return label;
}

// 명칭 세대 차이·축약·자리표시자 → 표준(canonical) 명칭.
// 월간 파일은 구명칭(전라북도), 주간 파일은 신명칭(전북특별자치도)을 쓴다 → 신명칭으로 통일.
// 클라이언트 resolveKey는 접두 매칭(전라북/전북 → '전북')이라 어느 쪽이든 해석된다.
export const CANON = {
  '전라북도': '전북특별자치도',
  '강원도': '강원특별자치도',
  '강원특별자치도도': '강원특별자치도', // 주간 2.전세증감 시트의 KB 원본 오타

  '경북': '경상북도',
  '경남': '경상남도',
  '전북': '전북특별자치도',
  '제주도': '제주특별자치도', // 주간 파일의 빈 자리표시자 열 — 실데이터 열과 병합됨
  // 월간 파일의 시(市) 접미사 누락 라벨
  '의왕': '의왕시',
  '하남': '하남시',
  '오산': '오산시',
  '안성': '안성시',
  '양주': '양주시',
  '동두천': '동두천시',
  '양산': '양산시',
  '거제': '거제시',
  '기타': '기타지방',
};

export const canon = label => CANON[label] ?? label;

// 시도 하위가 아닌 집계 지역(권역·구 묶음). 계층 추적 시 부모 컨텍스트를 바꾸지 않는다.
// 전남광주통합특별시: 2026 행정개편 대비 자리표시자 — 집계로 취급(광주 구들의 부모가 되면 안 됨).
export const AGGREGATES = new Set([
  '전국', '강북14개구', '강남11개구', '6개광역시', '5개광역시', '5개광역시(인천外)',
  '수도권', '기타지방', '전남광주통합특별시',
]);

// 시도(광역자치단체) 판별. 집계 여부를 먼저 확인한 뒤 사용할 것.
export function isSido(label) {
  return /(특별시|광역시|특별자치시|특별자치도)$/.test(label) || /(?<!개)도$/.test(label);
}

// 열 순서 기반 계층 추적기.
// 헤더를 왼쪽→오른쪽으로 훑으며 "직전 시도/시" 컨텍스트로 각 열의 소속을 판정한다.
// classify(label) → { kind: 'aggregate'|'sido'|'city'|'leaf', sido, city }
export function createTracker() {
  let sido = null; // 현재 시도 (서울특별시, 경기도 …)
  let city = null; // 현재 시 (수원시, 창원시 …) — 구가 뒤따르는 경우의 중간 계층

  return function classify(rawLabel) {
    const label = canon(rawLabel);
    if (!label) return null;
    if (AGGREGATES.has(label)) return { kind: 'aggregate', label, sido: null, city: null };
    if (isSido(label)) {
      sido = label;
      city = null;
      return { kind: 'sido', label, sido, city: null };
    }
    if (label.endsWith('시')) {
      // 시도 하위의 시 — 이후 나오는 구들의 부모가 된다
      city = label;
      return { kind: 'city', label, sido, city };
    }
    // 구·군 등 말단 — 직전 시(있으면) 아래, 없으면 시도 바로 아래
    return { kind: 'leaf', label, sido, city };
  };
}
