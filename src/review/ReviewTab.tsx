import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Bot, CheckCircle2, Download, LoaderCircle, PlugZap, Search } from 'lucide-react';
import { RegionSelect } from '../components/RegionSelect';
import type { RegionSelection } from '../types';
import { detectExtension } from '../services/extensionBridge';
import { supabase } from '../services/supabase';
import { sessionCredential } from '../kb/entities/provider/api/provider.api';
import { useProviderStore } from '../kb/entities/provider/model/provider.store';
import { collectResidentReviews, type ResidentReview } from './reviewBridge';
import './review.css';

type Apartment = { id: string; name: string; address?: string; dong?: string; type: string };

const EMPTY_REGION: RegionSelection = { large: null, mid: null, small: null };

function reviewPrompt(reviews: ResidentReview[]): { system: string; user: string } {
  return {
    system: '당신은 아파트 입주민 리뷰 분석 전문가입니다. 제공된 리뷰만 근거로 분석하고, 과장하거나 확인되지 않은 사실을 만들지 마세요. 한국어로 간결하고 실무적으로 답하세요.',
    user: `다음 입주민 리뷰 ${reviews.length}건을 분석하세요.\n\n1. 전체 분위기를 긍정·중립·부정 중 하나로 판단하고 근거를 2문장으로 요약\n2. 입지, 교통, 주거환경·편의, 관리·시설, 가격·가치별 장점과 유의점을 각각 정리\n3. 반복적으로 언급되는 핵심 이슈를 빈도 감각이 드러나게 정리\n4. 거주 검토자에게 확인할 질문 3개를 제시\n\n리뷰:\n${reviews.map((r, i) => `[${i + 1}] ${r.content}`).join('\n')}`,
  };
}

export function ReviewTab() {
  const [region, setRegion] = useState<RegionSelection>(EMPTY_REGION);
  const [type, setType] = useState<'apt-all' | 'ot-all'>('apt-all');
  const [apartments, setApartments] = useState<Apartment[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviews, setReviews] = useState<Record<string, { name: string; items: ResidentReview[] }>>({});
  const [loading, setLoading] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [extensionReady, setExtensionReady] = useState(false);
  const [maxReviews, setMaxReviews] = useState(50);
  const [analysis, setAnalysis] = useState('');
  const [analyzing, setAnalyzing] = useState(false);

  const provider = useProviderStore(s => s.selectedProviderId);
  const model = useProviderStore(s => s.selectedModelId);
  const statuses = useProviderStore(s => s.statuses);
  const refreshProviders = useProviderStore(s => s.refreshProviders);

  useEffect(() => {
    void detectExtension().then(setExtensionReady);
    void refreshProviders().catch(() => undefined);
  }, [refreshProviders]);

  const allReviews = useMemo(() => Object.values(reviews).flatMap(group => group.items), [reviews]);

  async function searchApartments() {
    if (!region.small?.code) { setError('읍/면/동까지 지역을 선택해 주세요.'); return; }
    setLoading(true); setError(''); setApartments([]); setSelected(new Set()); setReviews({}); setAnalysis('');
    try {
      const res = await fetch('/api/reviews/apartments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ legalCode: region.small.code, listType: type }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? body.message ?? '단지 목록을 불러오지 못했습니다.');
      setApartments(body);
      if (!body.length) setError('선택한 지역에 조회 가능한 단지가 없습니다.');
    } catch (err) { setError(err instanceof Error ? err.message : '단지 조회 중 오류가 발생했습니다.'); }
    finally { setLoading(false); }
  }

  async function collect() {
    if (!selected.size) { setError('리뷰를 수집할 단지를 선택해 주세요.'); return; }
    const ready = extensionReady || await detectExtension();
    setExtensionReady(ready);
    if (!ready) { setError('Estate-OS 연결기 확장을 설치·활성화한 뒤 새로고침해 주세요.'); return; }
    setCollecting(true); setError(''); setAnalysis('');
    const targets = apartments.filter(a => selected.has(a.id));
    const received: Record<string, { name: string; items: ResidentReview[] }> = {};
    for (let i = 0; i < targets.length; i += 1) {
      const apt = targets[i];
      setProgress(`${i + 1}/${targets.length} · ${apt.name} 리뷰 수집 중`);
      const result = await collectResidentReviews(apt.id, maxReviews, count => setProgress(`${i + 1}/${targets.length} · ${apt.name} ${count}건 수집`));
      if (!result.ok && result.error === 'NOT_LOGGED_IN') { setError('호갱노노에 로그인한 Chrome 프로필에서 다시 시도해 주세요.'); break; }
      if (result.reviews.length) received[apt.id] = { name: apt.name, items: result.reviews };
    }
    setReviews(received); setProgress(''); setCollecting(false);
  }

  async function analyze() {
    if (!allReviews.length) { setError('먼저 리뷰를 수집해 주세요.'); return; }
    if (!model || !provider || !statuses[provider]?.connected) { setError('설정에서 AI 제공자와 모델을 연결·선택해 주세요.'); return; }
    setAnalyzing(true); setError('');
    try {
      const credential = sessionCredential(provider);
      const accessToken = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
      const messages = reviewPrompt(allReviews);
      const res = await fetch('/api/kb-analysis', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify({ action: 'chat', provider, model, system: messages.system, user: messages.user, ...(credential ? { credential } : {}) }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'AI 분석에 실패했습니다.');
      setAnalysis(body.result ?? '분석 결과가 비어 있습니다.');
    } catch (err) { setError(err instanceof Error ? err.message : 'AI 분석 중 오류가 발생했습니다.'); }
    finally { setAnalyzing(false); }
  }

  function exportReviews() {
    const text = allReviews.map((r, i) => `${i + 1}. ${r.content}${r.date ? ` (${r.date})` : ''}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'resident-reviews.txt'; a.click(); URL.revokeObjectURL(url);
  }

  return <main className="review-scope">
    <section className="review-intro"><div><span className="review-eyebrow">RESIDENT INTELLIGENCE</span><h1>입주민 리뷰</h1><p>호갱노노에 로그인된 브라우저의 리뷰를 수집해, 현재 연결된 AI로 분석합니다.</p></div><div className={`review-extension ${extensionReady ? 'ready' : ''}`}><PlugZap size={18} /> {extensionReady ? '연결기 준비됨' : '연결기 확인 필요'}</div></section>
    <section className="review-grid">
      <aside className="review-controls">
        <RegionSelect value={region} onChange={setRegion} disabled={loading || collecting} />
        <label>주택 유형<select value={type} onChange={e => setType(e.target.value as typeof type)}><option value="apt-all">아파트</option><option value="ot-all">오피스텔</option></select></label>
        <button className="review-primary" onClick={() => void searchApartments()} disabled={loading}><Search size={17} />{loading ? '조회 중…' : '단지 조회'}</button>
        <label>단지별 수집 수<select value={maxReviews} onChange={e => setMaxReviews(Number(e.target.value))}><option value={30}>30건</option><option value={50}>50건</option><option value={100}>100건</option></select></label>
        <button className="review-primary" onClick={() => void collect()} disabled={collecting || !apartments.length}><Download size={17} />{collecting ? '수집 중…' : '선택 리뷰 수집'}</button>
        <div className="review-ai-status"><Bot size={16} /><span>AI: {model ? `${provider} / ${model}` : '설정에서 모델 선택 필요'}</span></div>
      </aside>
      <section className="review-workspace">
        {error && <div className="review-message error"><AlertCircle size={17} />{error}</div>}
        {progress && <div className="review-message"><LoaderCircle className="spin" size={17} />{progress}</div>}
        <div className="review-card"><header><div><h2>단지 선택</h2><p>{apartments.length ? `${apartments.length}개 단지` : '지역을 선택해 단지를 조회하세요.'}</p></div>{apartments.length > 0 && <button className="review-text-button" onClick={() => setSelected(selected.size === apartments.length ? new Set() : new Set(apartments.map(a => a.id)))}>전체 선택</button>}</header>
          <div className="review-apartment-list">{apartments.map(apt => <label className="review-apt" key={apt.id}><input type="checkbox" checked={selected.has(apt.id)} onChange={() => setSelected(prev => { const next = new Set(prev); next.has(apt.id) ? next.delete(apt.id) : next.add(apt.id); return next; })} /><span><b>{apt.name}</b><small>{apt.address || apt.dong || '주소 정보 없음'}</small></span>{reviews[apt.id] && <em>{reviews[apt.id].items.length}건</em>}</label>)}</div>
        </div>
        <div className="review-card review-results"><header><div><h2>수집된 리뷰</h2><p>{allReviews.length ? `${allReviews.length}건 · ${Object.keys(reviews).length}개 단지` : '수집 결과가 여기에 표시됩니다.'}</p></div>{allReviews.length > 0 && <button className="review-text-button" onClick={exportReviews}>텍스트 내보내기</button>}</header>
          <div className="review-review-list">{Object.values(reviews).flatMap(group => group.items.map((item, i) => <article key={`${group.name}-${i}`}><b>{group.name}</b><p>{item.content}</p>{item.date && <time>{new Date(item.date).toLocaleDateString('ko-KR')}</time>}</article>))}</div>
          {allReviews.length > 0 && <button className="review-primary review-analyze" onClick={() => void analyze()} disabled={analyzing}>{analyzing ? <LoaderCircle className="spin" size={17} /> : <Bot size={17} />}{analyzing ? '분석 중…' : 'AI 리뷰 분석'}</button>}
        </div>
        {analysis && <div className="review-card review-analysis"><header><div><h2><CheckCircle2 size={19} /> AI 분석 결과</h2><p>{provider} · {model}</p></div></header><div>{analysis}</div></div>}
      </section>
    </section>
  </main>;
}
