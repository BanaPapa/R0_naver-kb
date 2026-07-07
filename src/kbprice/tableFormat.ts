// 결과 테이블/내보내기 공용 포맷터 (표시 일관성 유지)
import { ProcessedData } from './types';
import { type PriceUnit, convertPrice, PYEONG_PER_SQM } from './units';

// 입주년월("2016.04")에서 연도 추출. 없거나 형식 오류면 0.
export function 입주연도(입주년월?: string): number {
  if (!입주년월) return 0;
  const year = parseInt(입주년월.slice(0, 4), 10);
  return Number.isFinite(year) ? year : 0;
}

// "N년차 ( 2016.04 )" 형식. 입주 그해=1년차, 매년 1월 기준 +1.
export function format입주연차(입주년월?: string): string {
  const year = 입주연도(입주년월);
  if (year === 0) return '-';
  const 연차 = new Date().getFullYear() - year + 1;
  if (연차 < 1) return `입주예정 ( ${입주년월} )`;
  return `${연차}년차 ( ${입주년월} )`;
}

// 1평당 시세(만원). 공급면적 우선, 없으면 전용면적 기준.
export function 평당가만원(item: ProcessedData, priceManwon: number): number {
  const sqm = item.공급면적 > 0 ? item.공급면적 : item.전용면적;
  const pyeong = sqm * PYEONG_PER_SQM;
  return pyeong > 0 ? priceManwon / pyeong : 0;
}

// 평당가를 선택 가격 단위로 변환한 표시 문자열.
export function format평당가(item: ProcessedData, priceManwon: number, unit: PriceUnit): string {
  if (priceManwon <= 0) return '-';
  const value = 평당가만원(item, priceManwon);
  if (value <= 0) return '-';
  return Math.round(convertPrice(value, unit)).toLocaleString();
}
