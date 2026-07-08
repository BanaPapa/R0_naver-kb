import { TransactionProperty } from '../types';

// 국토교통부 실거래가 API — 항상 동일출처 프록시 '/molit-api'로 호출한다.
// serviceKey(공공데이터포털 인증키)는 클라이언트가 알지 못하며, dev(Vite 미들웨어)/
// prod(Vercel api/molit-proxy) 프록시가 서버측에서 주입한다 → 키가 번들에 노출되지 않는다.
const PROXY_BASE = '/molit-api/1613000';
const ENDPOINTS = {
  APT_TRADE: `${PROXY_BASE}/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade`,
  APT_RENT: `${PROXY_BASE}/RTMSDataSvcAptRent/getRTMSDataSvcAptRent`,
  OFFI_TRADE: `${PROXY_BASE}/RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade`,
  OFFI_RENT: `${PROXY_BASE}/RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent`,
  SILV_TRADE: `${PROXY_BASE}/RTMSDataSvcSilvTrade/getRTMSDataSvcSilvTrade`, // 분양권
  NRG_TRADE: `${PROXY_BASE}/RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade`,   // 상업업무용
};

const fetchWithTimeout = async (url: string, ms: number) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
};

type TransientError = Error & { transient?: boolean };

// 동일출처 프록시로만 호출. 5xx(게이트웨이·백엔드 오류)나 타임아웃은 일시 오류로 표시해 재시도 대상으로 삼는다.
const fetchViaProxy = async (path: string): Promise<Response> => {
  let sawServerError = false;
  try {
    const response = await fetchWithTimeout(path, 10000);
    if (response.ok) return response;
    if (response.status >= 500) sawServerError = true;
  } catch (e) {
    sawServerError = true;
    console.warn(`Proxy failed: ${path}`, e);
  }
  const err: TransientError = new Error('실거래 데이터 서버에 연결할 수 없습니다. (data.go.kr 응답 없음)');
  err.transient = sawServerError;
  throw err;
};

const parseXML = (text: string) => {
  const parser = new DOMParser();
  return parser.parseFromString(text, 'text/xml');
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface FilterCriteria {
  product: 'APT' | 'OFFICETEL' | 'BUNYANGWON' | 'COMMERCIAL';
  type: 'TRADE' | 'JEONSE' | 'WOLSE';
  areaMin?: number; // 전용면적 하한(㎡)
  areaMax?: number; // 전용면적 상한(㎡)
  months: string[]; // YYYYMM format
  regionCode: string; // 5 digit code (Sigungu)
  regionName: string; // Region Name for display (e.g., 종로구)
  dongName?: string; // Optional filtering by dong
}

export class TransactionService {
  private logCallback: (msg: string, type: 'info' | 'error') => void;
  private statusCallback: (status: any) => void;
  private shouldStop: boolean = false;

  constructor(
    logCallback: (msg: string, type: 'info' | 'error') => void,
    statusCallback: (status: any) => void
  ) {
    this.logCallback = logCallback;
    this.statusCallback = statusCallback;
  }

  stop() {
    this.shouldStop = true;
  }

  async run(criteria: FilterCriteria): Promise<TransactionProperty[]> {
    this.shouldStop = false;
    let allData: TransactionProperty[] = [];

    // Determine API Endpoint
    let endpoint = '';
    if (criteria.product === 'APT') {
      endpoint = criteria.type === 'TRADE' ? ENDPOINTS.APT_TRADE : ENDPOINTS.APT_RENT;
    } else if (criteria.product === 'OFFICETEL') {
      endpoint = criteria.type === 'TRADE' ? ENDPOINTS.OFFI_TRADE : ENDPOINTS.OFFI_RENT;
    } else if (criteria.product === 'BUNYANGWON') {
      endpoint = ENDPOINTS.SILV_TRADE; // 분양권은 매매만 존재
    } else if (criteria.product === 'COMMERCIAL') {
      endpoint = ENDPOINTS.NRG_TRADE; // 상업업무용은 매매만 존재
    }

    let totalMonths = criteria.months.length;

    try {
      this.statusCallback({ isRunning: true, progress: 0, step: '준비 중...' });

      for (let i = 0; i < totalMonths; i++) {
        if (this.shouldStop) break;
        const month = criteria.months[i];

        this.logCallback(`데이터 수집 중: ${month}`, 'info');
        this.statusCallback({
          progress: Math.floor((i / totalMonths) * 100),
          step: `${month} 데이터 조회 중...`,
          propertiesFound: allData.length
        });

        const monthData = await this.fetchMonthData(endpoint, criteria.regionCode, month, criteria);
        allData = [...allData, ...monthData];

        await delay(300); // Politeness delay
      }

      this.statusCallback({ isRunning: false, progress: 100, step: '완료', propertiesFound: allData.length });
      return allData;

    } catch (e: any) {
      this.logCallback(`오류: ${e.message}`, 'error');
      this.statusCallback({ isRunning: false, step: '오류 발생' });
      throw e;
    }
  }

  // 일시 서버 오류(5xx/타임아웃 등)면 짧은 백오프 후 자동 재시도
  private async fetchWithRetry(url: string, retries = 1): Promise<Response> {
    let lastErr: TransientError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fetchViaProxy(url);
      } catch (e: any) {
        lastErr = e;
        if (!e?.transient || attempt === retries) break;
        this.logCallback(`서버 응답 없음 — 자동 재시도 ${attempt + 1}/${retries}...`, 'info');
        this.statusCallback({ step: `서버 재시도 중 (${attempt + 1}/${retries})...` });
        await delay(1500 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  private async fetchMonthData(endpoint: string, regionCode: string, yyyymm: string, criteria: FilterCriteria): Promise<TransactionProperty[]> {
    let results: TransactionProperty[] = [];

    // serviceKey는 프록시가 서버측에서 주입한다 → 여기서는 붙이지 않는다.
    const firstUrl = `${endpoint}?LAWD_CD=${regionCode}&DEAL_YMD=${yyyymm}&pageNo=1&numOfRows=100`;

    try {
      const res = await this.fetchWithRetry(firstUrl);
      const text = await res.text();
      const xml = parseXML(text);

      const headerCode = xml.querySelector('header resultCode')?.textContent?.trim();
      const headerMsg = xml.querySelector('header resultMsg')?.textContent;

      // Accept '00' or '000' as success
      if (!['00', '000'].includes(headerCode || '')) {
        if (headerMsg) this.logCallback(`API Error (${yyyymm}): ${headerMsg} (Code: ${headerCode})`, 'error');

        // Critical errors that stop the process
        if (headerMsg?.includes('SERVICE KEY') || headerMsg?.includes('LIMITED') || headerMsg?.includes('DEADLINE')) {
          throw new Error(`API 키 오류 또는 만료: ${headerMsg}`);
        }
        return [];
      }

      const totalCount = parseInt(xml.querySelector('body totalCount')?.textContent || '0', 10);
      if (totalCount === 0) return [];

      const numOfRows = 100;
      const totalPages = Math.ceil(totalCount / numOfRows);

      // Process First Page
      results = [...results, ...this.parseItems(xml, criteria)];

      // Process Remaining Pages
      for (let page = 2; page <= totalPages; page++) {
        if (this.shouldStop) break;
        const pageUrl = `${endpoint}?LAWD_CD=${regionCode}&DEAL_YMD=${yyyymm}&pageNo=${page}&numOfRows=${numOfRows}`;
        const pRes = await this.fetchWithRetry(pageUrl);
        const pText = await pRes.text();
        const pXml = parseXML(pText);
        results = [...results, ...this.parseItems(pXml, criteria)];
        await delay(150);
      }

    } catch (e: any) {
      // 자동 재시도까지 실패한 일시 서버 오류 → UI가 안내 모달을 띄우도록 신호
      if (e?.transient) throw new Error('SERVER_UNAVAILABLE');
      console.warn(`Month fetch failed: ${yyyymm}`, e);
      if (e.message?.includes('API 키')) throw e;
    }

    return results;
  }

  private parseItems(xml: Document, criteria: FilterCriteria): TransactionProperty[] {
    const items = xml.querySelectorAll('item');
    const parsed: TransactionProperty[] = [];

    items.forEach(item => {
      // 1. Filter by Dong (if selected)
      const umdNm = item.querySelector('umdNm')?.textContent?.trim() || '';
      const dong = item.querySelector('dong')?.textContent?.trim() || umdNm;

      if (criteria.dongName && criteria.dongName !== 'All' && !dong.includes(criteria.dongName)) return;

      // 2. Filter by Transaction Type (Jeonse vs Wolse for Rent API)
      const monthlyRentStr = item.querySelector('monthlyRent')?.textContent?.replace(/,/g, '') || '0';
      const monthlyRent = parseInt(monthlyRentStr, 10);
      if (criteria.type === 'JEONSE' && monthlyRent !== 0) return;
      if (criteria.type === 'WOLSE' && monthlyRent === 0) return;

      // 3. Filter by Area (Dynamic Range)
      // Commercial uses 'buildingAr', others use 'excluUseAr'
      let area = 0;
      if (criteria.product === 'COMMERCIAL') {
        area = parseFloat(item.querySelector('buildingAr')?.textContent || '0');
      } else {
        area = parseFloat(item.querySelector('excluUseAr')?.textContent || '0');
      }

      // Check min/max only if they are provided (not undefined)
      if (criteria.areaMin !== undefined && area < criteria.areaMin) return;
      if (criteria.areaMax !== undefined && area >= criteria.areaMax) return;

      // Parse Data
      const priceStr = item.querySelector('dealAmount')?.textContent || item.querySelector('deposit')?.textContent || '0';

      // Date Formatting (YY.MM.DD)
      const year = item.querySelector('dealYear')?.textContent || '';
      const month = item.querySelector('dealMonth')?.textContent || '';
      const day = item.querySelector('dealDay')?.textContent || '';

      let date = '';
      if (year && month && day) {
        const shortYear = year.length === 4 ? year.substring(2) : year;
        const padMonth = month.padStart(2, '0');
        const padDay = day.padStart(2, '0');
        date = `${shortYear}.${padMonth}.${padDay}`;
      }

      // Cancel Deal Date
      const cdealDay = item.querySelector('cdealDay')?.textContent?.trim() ||
        item.querySelector('cancelDealDay')?.textContent?.trim() || '';

      // Determine Type & Name based on Product
      let typeLabel = '';
      let name = '';

      if (criteria.product === 'COMMERCIAL') {
        const bType = item.querySelector('buildingType')?.textContent || '';
        const bUse = item.querySelector('buildingUse')?.textContent || '';
        name = `${bUse} (${bType})`;
        typeLabel = item.querySelector('dealingGbn')?.textContent || '';
      } else {
        name = item.querySelector('aptNm')?.textContent || item.querySelector('offiNm')?.textContent || '';
        if (criteria.type === 'TRADE') {
          typeLabel = item.querySelector('dealingGbn')?.textContent || '';
        } else {
          const cType = item.querySelector('contractType')?.textContent || '';
          const useRR = item.querySelector('useRRRight')?.textContent || '';
          typeLabel = `${cType}${useRR ? '(' + useRR + ')' : ''}`;
        }
      }

      parsed.push({
        no: 0, // Assigned later
        region: criteria.regionName,
        dong: dong,
        name: name,
        area: area.toFixed(2),
        floor: item.querySelector('floor')?.textContent || '',
        price: priceStr.trim(),
        monthlyRent: monthlyRent > 0 ? monthlyRent.toLocaleString() : '',
        date: date,
        type: typeLabel,
        cancelDate: cdealDay,
        buildYear: item.querySelector('buildYear')?.textContent || '',
      });
    });

    return parsed;
  }
}
