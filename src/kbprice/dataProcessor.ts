import {
  ComplexPriceData,
  ComplexMainData,
  TypeInfoData,
  DealData,
  ProcessedData,
  KbSearchParams,
  KB_SPACE_OPTIONS,
} from './types';

export class DataProcessor {
  static processSearchResults(
    priceData: ComplexPriceData[],
    mainData: Map<number, ComplexMainData>,
    typeData: Map<number, TypeInfoData[]>,
    searchParams: KbSearchParams,
    동명Map: Map<number, string> = new Map(),
  ): ProcessedData[] {
    const results: ProcessedData[] = [];
    let counter = 1;

    priceData.forEach((complex) => {
      const complexId = complex.단지기본일련번호;
      const dealTypeData = complex[searchParams.dealType];

      if (!dealTypeData || dealTypeData.length === 0) return;

      dealTypeData.forEach((deal) => {
        if (!this.passesAreaFilter(deal, searchParams)) return;

        const processedItem: ProcessedData = {
          id: `${complexId}-${deal.주택형타입내용}-${counter++}`,
          단지기본일련번호: complexId,
          동: 동명Map.get(complexId) ?? '',
          단지명: complex.단지명,
          전용면적: deal.전용면적,
          공급면적: deal.공급면적 || 0,
          계약면적: deal.계약면적 || 0,
          타입: deal.주택형타입내용,
          탑층여부: deal.연결구분명 || '',
          상위평균: deal.상위평균 || 0,
          일반평균: deal.일반평균 || 0,
          하위평균: deal.하위평균 || 0,
        };

        const mainInfo = mainData.get(complexId);
        if (mainInfo) {
          processedItem.입주년월 = mainInfo.입주년월;
          processedItem.총세대수 = mainInfo.총세대수;
        }

        const typeInfo = typeData.get(complexId);
        if (typeInfo) {
          const matchingType = typeInfo.find(
            (t) =>
              Math.abs(t.전용면적 - deal.전용면적) < 0.1 &&
              t.주택형타입내용 === deal.주택형타입내용,
          );
          if (matchingType) {
            processedItem.세대수 = matchingType.세대수;
          }
        }

        results.push(processedItem);
      });
    });

    return results;
  }

  private static passesAreaFilter(deal: DealData, params: KbSearchParams): boolean {
    if (params.propertyType === 1 && params.areaMode === 'preset') {
      // 아파트 타입 프리셋: 전용면적 기준 (59타입/84타입 등은 통상 전용면적)
      const area = deal.전용면적;
      const opt = KB_SPACE_OPTIONS[params.spaceIndex] ?? KB_SPACE_OPTIONS[0];
      if (opt.min > 0 && area < opt.min) return false;
      if (opt.max > 0 && area >= opt.max) return false;
    } else {
      // 직접설정 기준 면적:
      // - 오피스텔(유형2): 전용면적 기준 (공급면적 없음)
      // - 아파트(유형1): 공급면적 기준 (공급면적 없으면 전용면적으로 대체)
      const basis =
        params.propertyType === 2
          ? deal.전용면적
          : deal.공급면적 && deal.공급면적 > 0
            ? deal.공급면적
            : deal.전용면적;
      if (params.areaMin > 0 && basis < params.areaMin) return false;
      if (params.areaMax > 0 && basis > params.areaMax) return false;
    }

    return true;
  }

  static getPrimaryPrice(item: ProcessedData, priceTypes: KbSearchParams['priceTypes']): number {
    if (priceTypes.includes('일반') && item.일반평균 > 0) return item.일반평균;
    if (priceTypes.includes('상위') && item.상위평균 > 0) return item.상위평균;
    if (priceTypes.includes('하위') && item.하위평균 > 0) return item.하위평균;
    return 0;
  }

  static filterRepresentativeTypes(data: ProcessedData[]): ProcessedData[] {
    if (data.length <= 1) return data;

    const groups = new Map<string, ProcessedData[]>();

    data.forEach((item) => {
      const areaGroup = Math.floor(item.전용면적);
      const key = `${item.단지기본일련번호}-${item.단지명}-${areaGroup}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    });

    const filtered: ProcessedData[] = [];
    groups.forEach((group) => {
      if (group.length === 1) {
        filtered.push(group[0]);
      } else {
        const representative = group.reduce((max, cur) =>
          (cur.세대수 || 0) > (max.세대수 || 0) ? cur : max,
        );
        filtered.push(representative);
      }
    });

    return filtered;
  }

  static filterTopFloor(data: ProcessedData[], excludeTopFloor: boolean): ProcessedData[] {
    if (!excludeTopFloor) return data;
    return data.filter((item) => item.탑층여부 !== '탑층');
  }
}
