import React from 'react';
import { useAppStore } from '../../shared/lib/store';
import { useMonthlyStore } from '../../shared/lib/monthly-store';

// 비교군 프리셋 — 전 기간 상관분석(docs/KB_TIMESERIES_DATA_REPORT.md §4)에서 확인된
// "함께 움직이는 블록"을 원클릭으로 비교함에 담는다.
// 주간·월간 스토어 모두에 적용해 모드를 오가도 같은 비교군이 유지된다.

interface Preset {
  id: string;
  label: string;
  desc: string; // 툴팁 — 왜 이 묶음인지(실측 상관 근거)
  regions: string[]; // 상위지역 키(라벨과 동일) — 주간·월간 공용
}

const PRESETS: Preset[] = [
  {
    id: 'capital',
    label: '수도권',
    desc: '서울·경기·인천 — 2~4주 시차로 강하게 동행하는 블록 (서울↔경기 r≈0.82)',
    regions: ['서울특별시', '경기도', '인천광역시'],
  },
  {
    id: 'metro',
    label: '지방 광역시',
    desc: '부산·대구·대전·울산·광주 — 수도권과 분리된 동행 블록 (부산↔대전 r≈0.82)',
    regions: ['부산광역시', '대구광역시', '대전광역시', '울산광역시', '광주광역시'],
  },
  {
    id: 'seoul-core',
    label: '서울 내부',
    desc: '전국 기준 대비 서울·강남11·강북14 — 시장 대비 서울 강도와 서울 내 격차 확인',
    regions: ['전국', '서울특별시', '강남11개구', '강북14개구'],
  },
  {
    id: 'contrast',
    label: '서울 vs 부산',
    desc: '동행성이 가장 낮은 쌍 (r≈0.29) — 수도권·지방 흐름 분화 확인용',
    regions: ['서울특별시', '부산광역시'],
  },
];

export const RegionPresets: React.FC = () => {
  // 클릭 시점에만 스토어 접근 — 구독 없음(리렌더 최소화)
  const apply = (p: Preset) => {
    const weekly = useAppStore.getState();
    const monthly = useMonthlyStore.getState();
    weekly.clearRegions();
    monthly.clearRegions();
    for (const r of p.regions) {
      weekly.addRegion(r, r);
      monthly.addRegion(r, r);
    }
  };

  return (
    <div className="mb-3">
      <p className="mb-1.5 text-[11px] font-medium text-gray-400">비교군 프리셋</p>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map(p => (
          <button
            key={p.id}
            onClick={() => apply(p)}
            title={p.desc}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 transition-colors hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
};
