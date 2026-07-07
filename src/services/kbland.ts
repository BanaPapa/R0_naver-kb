import { RegionItem } from '../types';

const KB_BASE = 'https://api.kbland.kr/land-price/price/areaName';

interface KBRawItem {
  대지역명: string;
  중지역명?: string;
  소지역명?: string;
  법정동코드: string;
}

export async function getRegions(step: 1 | 2 | 3, parentCode?: string): Promise<RegionItem[]> {
  const params = new URLSearchParams();
  if (step > 1 && parentCode) {
    params.set('법정동코드', parentCode);
  }

  const url = step > 1 ? `${KB_BASE}?${params.toString()}` : KB_BASE;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mobile' },
  });

  if (!resp.ok) {
    throw new Error(`KB Land API 오류: ${resp.status}`);
  }

  const json = await resp.json();
  const items: KBRawItem[] = json?.dataBody?.data ?? [];

  const seen = new Set<string>();
  const result: RegionItem[] = [];

  for (const item of items) {
    if (step === 1) {
      const name = item.대지역명.trim();
      const code = item.법정동코드.substring(0, 2);
      if (!seen.has(code)) {
        seen.add(code);
        result.push({ code, name, level: 1 });
      }
    } else if (step === 2) {
      const name = (item.중지역명 || '').trim();
      const code = item.법정동코드.substring(0, 5);
      if (!seen.has(code)) {
        seen.add(code);
        result.push({ code, name, level: 2 });
      }
    } else if (step === 3) {
      const name = (item.소지역명 || '').trim();
      const code = item.법정동코드;
      if (!seen.has(code)) {
        seen.add(code);
        result.push({ code, name, level: 3 });
      }
    }
  }

  return result;
}

// KB 대지역(법정동코드 2자리) → applyhome 공급지역 단축명 매핑.
// 청약 데이터(applyhome)는 시/도 단위만 제공하므로 대지역만 필터에 사용한다.
const SIDO_CODE_TO_APPLYHOME: Record<string, string> = {
  '11': '서울', '26': '부산', '27': '대구', '28': '인천', '29': '광주',
  '30': '대전', '31': '울산', '36': '세종',
  '41': '경기',
  '42': '강원', '51': '강원',   // 강원특별자치도
  '43': '충북', '44': '충남',
  '45': '전북', '52': '전북',   // 전북특별자치도
  '46': '전남', '47': '경북', '48': '경남', '50': '제주',
};

export function toApplyhomeRegion(largeCode?: string | null): string | null {
  if (!largeCode) return null;
  return SIDO_CODE_TO_APPLYHOME[largeCode.substring(0, 2)] ?? null;
}
