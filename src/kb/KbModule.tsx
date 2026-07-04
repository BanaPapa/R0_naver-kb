import { type FC, useEffect, useState } from 'react';
import { StoreProvider } from './app/providers';
import { RegionSelector } from './widgets/region-selector';
import { ChartDashboard } from './widgets/chart-dashboard';
import { TradeDashboard } from './widgets/weekly-trade-dashboard';
import { MonthlyRegionCascade } from './widgets/monthly-region-cascade';
import { MonthlyChartDashboard } from './widgets/monthly-chart-dashboard';
import { MonthlyTradeDashboard } from './widgets/monthly-trade-dashboard';
import { MonthlyMarketDashboard } from './widgets/monthly-market-dashboard';
import { useAppStore } from './shared/lib/store';
import { useMonthlyStore, type WeeklyTab } from './shared/lib/monthly-store';
import { AnalysisModal } from './features/analysis';
import { SlotControls } from './features/chart-slots';
import { ExportButton } from './features/data-export';
import { DataUpdateModal } from './features/data-update';
import { ViewModeControls } from './widgets/region-selector/ViewModeControls';

// KB 시계열 분석 모듈 — 통합 셸(naver-kb)의 'KB 시계열 분석' 탭에서 렌더된다.
// 원본 KB 앱의 App.tsx에서 좌측 사이드바(AppNav)와 eos-app 래퍼를 제거하고
// 콘텐츠(헤더 + 작업영역 + 분석 모달)만 호스트의 eos-main 안에 마운트한다.
// 모든 KB 스타일은 .kb-scope 로 한정(kb-shell.css)되어 매물시세 화면에 영향이 없다.

const TAB_LABEL: Record<WeeklyTab, string> = {
  price: '시세지표',
  trade: '거래지표',
  market: '시장지표',
};

// 주간 뷰: 시세지표 / 거래지표
const WeeklyView: FC = () => {
  const weeklyTab = useMonthlyStore(s => s.weeklyTab);
  return weeklyTab === 'trade' ? <TradeDashboard /> : <ChartDashboard />;
};

// 월간 뷰: 시세지표 / 거래지표 / 시장지표
const MonthlyView: FC = () => {
  const weeklyTab = useMonthlyStore(s => s.weeklyTab);
  if (weeklyTab === 'trade') return <MonthlyTradeDashboard />;
  if (weeklyTab === 'market') return <MonthlyMarketDashboard />;
  return <MonthlyChartDashboard />;
};

// 데이터 신선도 뱃지 — 주간/월간 기준일과 갱신 지연 경고.
// KB 발표 주기(주간 매주 금요일 / 월간 매월 말)보다 오래되면 경고색으로 갱신 누락을 알린다.
// (수집·변환은 수동 파이프라인 — docs/KB_UPDATE_RUNBOOK.md)
const DataFreshnessBadge: FC = () => {
  const latestWeekly = useAppStore(s => s.latestDate);
  const monthlyDates = useMonthlyStore(s => s.allDates);
  const latestMonthly = monthlyDates.length ? monthlyDates[monthlyDates.length - 1]! : null;

  // 주간: 기준일이 12일(한 주 누락 + 여유)보다 오래되면 지연.
  const weeklyStale =
    !!latestWeekly && Date.now() - new Date(latestWeekly).getTime() > 12 * 86400000;
  // 월간: 기준월이 지난달보다 오래되면(2개월 이상 차이) 지연.
  const monthlyStale = (() => {
    if (!latestMonthly) return false;
    const [y, m] = latestMonthly.split('-').map(Number);
    const now = new Date();
    return now.getFullYear() * 12 + now.getMonth() - (y! * 12 + (m! - 1)) >= 2;
  })();
  const anyStale = weeklyStale || monthlyStale;

  if (!latestWeekly && !latestMonthly) return null;
  return (
    <span
      className="eos-pill tnum"
      style={anyStale ? { color: '#d97706', borderColor: '#f59e0b' } : undefined}
      title={
        '데이터 기준일 — KB 발표 주기: 주간 매주 금요일 / 월간 매월 말.\n' +
        (anyStale
          ? '갱신이 지연되고 있습니다. 최신 엑셀을 받아 인제스트를 실행해 주세요(docs/KB_UPDATE_RUNBOOK.md).'
          : '데이터가 최신입니다.')
      }
    >
      <span className="d t" />
      {latestWeekly ? `주간 ${latestWeekly}${weeklyStale ? ' ⚠' : ''}` : ''}
      {latestWeekly && latestMonthly ? ' · ' : ''}
      {latestMonthly ? `월간 ${latestMonthly}${monthlyStale ? ' ⚠' : ''}` : ''}
    </span>
  );
};

// 브레드크럼 헤더 — 분석 모듈 경로 + 우측 액션
const ShellHeader: FC<{ onOpenAnalysis: () => void }> = ({ onOpenAnalysis }) => {
  return (
    <header className="eos-hdr">
      <div className="eos-crumb">
        <span>분석 모듈</span>
        <svg className="sep" viewBox="0 0 24 24">
          <path d="M9 6l6 6-6 6" />
        </svg>
        <b>시계열분석</b>
        <ViewModeControls compact />
      </div>

      <div className="eos-hdr-right">
        <DataFreshnessBadge />
        <SlotControls />
        <ExportButton />
        <button className="eos-btn-primary" onClick={onOpenAnalysis}>
          <svg viewBox="0 0 24 24">
            <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          분석
        </button>
      </div>
    </header>
  );
};

const KbModule: FC = () => {
  const { mode, weeklyTab, setWeeklyTab } = useMonthlyStore();
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [ctrlCollapsed, setCtrlCollapsed] = useState(false);

  useEffect(() => {
    if (mode === 'weekly' && weeklyTab === 'market') setWeeklyTab('price');
  }, [mode, weeklyTab, setWeeklyTab]);

  const displayTab = mode === 'weekly' && weeklyTab === 'market' ? 'price' : weeklyTab;
  const title = `${mode === 'monthly' ? '월간' : '주간'} ${TAB_LABEL[displayTab]}`;

  return (
    <StoreProvider>
      {/* display:contents → .kb-scope 박스를 만들지 않아 호스트 eos-main 레이아웃을
          그대로 사용하면서도 .kb-scope 한정 스타일은 정상 적용된다. */}
      <div className="kb-scope" style={{ display: 'contents' }}>
        <ShellHeader onOpenAnalysis={() => setAnalysisOpen(true)} />

        <div className={`eos-work${ctrlCollapsed ? ' ctrl-collapsed' : ''}`}>
          {/* 검색 조건 패널 — 지역 선택/컨트롤 */}
          <div className="eos-ctrl">
            <div className="eos-ctrl-head">
              <span className="ch-ic">
                <svg viewBox="0 0 24 24">
                  <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
                </svg>
              </span>
              <b>검색 조건</b>
              <button
                className="eos-ctrl-toggle"
                title="패널 접기"
                onClick={() => setCtrlCollapsed(v => !v)}
              >
                <svg viewBox="0 0 24 24">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            </div>
            <div className="eos-ctrl-body">
              {mode === 'weekly' ? <RegionSelector /> : <MonthlyRegionCascade />}
            </div>
          </div>

          {/* 뷰 — 차트/대시보드 */}
          <div className="eos-view">
            <div className="eos-mod-head">
              <h1>{title}</h1>
            </div>

            {mode === 'weekly' ? <WeeklyView /> : <MonthlyView />}
          </div>
        </div>

        <AnalysisModal open={analysisOpen} onClose={() => setAnalysisOpen(false)} />
        <DataUpdateModal />
      </div>
    </StoreProvider>
  );
};

export default KbModule;
