// 단지를 이름+분양월+지역으로 식별하는 공통 매칭 키 — gap-fill 적재와 enrichment
// 스크립트가 동일 로직을 공유해야 서로 다른 곳에서 다시 어긋나지 않는다.
//
// 옛 청약홈 detail 스캔(historical.mjs, source='applyhome-detail')은 지역을 정식
// 명칭("서울특별시")으로 저장하고, 엑셀/odcloud 쪽은 청약홈 조회폼 단축명("서울")을
// 쓴다. 이 표기 차이를 흡수하지 않으면 같은 단지가 다른 지역값 때문에 매칭에
// 실패해 중복이 생긴다(실제로 gap-fill 1차 적재에서 이 버그로 중복이 발생함).
const REGION_ALIAS = {
  '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구',
  '인천광역시': '인천', '광주광역시': '광주', '대전광역시': '대전',
  '울산광역시': '울산', '세종특별자치시': '세종', '경기도': '경기',
  '강원도': '강원', '강원특별자치도': '강원', '충청북도': '충북',
  '충청남도': '충남', '전라북도': '전북', '전북특별자치도': '전북',
  '전라남도': '전남', '경상북도': '경북', '경상남도': '경남',
  '제주도': '제주', '제주특별자치도': '제주',
};

// NFKC 정규화로 전각(全角) 문자(２,Ａ,（,）…)를 반각으로 통일 — 옛 청약홈 detail
// 스캔은 원본 HTML에 전각 문자가 섞여 있어(예: "화성 봉담２차"), 정규화 없이는
// 엑셀의 반각 표기("화성봉담2차")와 문자열이 달라 매칭에 실패한다.
export const normName = (s) => String(s || '').normalize('NFKC').replace(/[\s()（）]/g, '');

export const normRegion = (s) => {
  const t = String(s || '').trim();
  return REGION_ALIAS[t] || t;
};

export const matchKey = (houseName, noticeMonth, region) =>
  `${normName(houseName)}|${noticeMonth || ''}|${normRegion(region)}`;
