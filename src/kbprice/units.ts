// 면적/가격 표시 단위 변환 유틸 (KB시세 모듈)
// - 면적: 내부 저장은 항상 ㎡(제곱미터), 화면 표시만 ㎡ ↔ 평 전환
// - 가격: KB 원본값은 항상 만원 단위, 화면 표시만 만원 ↔ 천원 전환

export type AreaUnit = 'sqm' | 'pyeong';
export type PriceUnit = 'manwon' | 'cheonwon';

export const PYEONG_PER_SQM = 0.3025; // 1㎡ = 0.3025평

export const sqmToPyeong = (sqm: number): number => sqm * PYEONG_PER_SQM;
export const pyeongToSqm = (pyeong: number): number => pyeong / PYEONG_PER_SQM;

export const AREA_UNIT_LABEL: Record<AreaUnit, string> = {
  sqm: '㎡',
  pyeong: '평',
};

export const PRICE_UNIT_LABEL: Record<PriceUnit, string> = {
  manwon: '만원',
  cheonwon: '천원',
};

/** 면적값(㎡ 기준)을 선택된 단위 문자열로 변환. 0 이하이면 '-' 반환. */
export function formatArea(sqm: number, unit: AreaUnit, decimals = 2): string {
  if (sqm <= 0) return '-';
  const value = unit === 'pyeong' ? sqmToPyeong(sqm) : sqm;
  return `${value.toFixed(decimals)}${AREA_UNIT_LABEL[unit]}`;
}

/** 가격값(만원 기준)을 선택된 단위 숫자로 변환. (천원 = 만원 × 10) */
export function convertPrice(manwon: number, unit: PriceUnit): number {
  return unit === 'cheonwon' ? manwon * 10 : manwon;
}
