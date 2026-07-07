import * as cheerio from 'cheerio';
import axios from 'axios';
import logger from './logger.mjs';
import { classifySubscriptionResult } from './dataProcessor.mjs';

/**
 * Simple HTTP crawler for applyhome.co.kr.
 * The site does not block plain requests, so axios + cheerio is enough —
 * no headless browser (puppeteer) and no database/queue required.
 */
export class ApplyHomeCrawler {
  constructor() {
    this.baseUrl = 'https://www.applyhome.co.kr';
    this.pageSize = 10; // site native page size
  }

  buildPayload(startDate, endDate, region, keyword, page) {
    const params = new URLSearchParams({
      beginPd: startDate,
      endPd: endDate,
      houseDetailSecd: '01', // 민영주택
      pageIndex: page,
    });
    if (region && region !== '공급지역 전체') params.append('suplyAreaCode', region);
    if (keyword) params.append('houseNm', keyword);
    return params.toString();
  }

  async post(url, payload, attempt = 1) {
    try {
      const res = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      // The site responds in UTF-8 (not EUC-KR despite the legacy code's assumption).
      return cheerio.load(Buffer.from(res.data).toString('utf-8'));
    } catch (error) {
      // applyhome occasionally throttles rapid sequential requests — retry a few times.
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        return this.post(url, payload, attempt + 1);
      }
      throw error;
    }
  }

  async getTotalCount(startDate, endDate, region, keyword) {
    const $ = await this.post(
      `${this.baseUrl}/ai/aia/selectAPTLttotPblancListView.do`,
      this.buildPayload(startDate, endDate, region, keyword, 1)
    );
    const totalText = $('.total_txt.dis_in_imp span b').text();
    return parseInt(totalText.replace(/[^\d]/g, ''), 10) || 0;
  }

  async extractApartmentsFromPage(page, startDate, endDate, region, keyword) {
    const $ = await this.post(
      `${this.baseUrl}/ai/aia/selectAPTLttotPblancListView.do`,
      this.buildPayload(startDate, endDate, region, keyword, page)
    );

    const apartments = [];
    $('tbody tr').each((index, element) => {
      const $row = $(element);
      const houseManageNo = $row.attr('data-hmno');
      if (!houseManageNo) return; // skip empty / "no results" rows

      const td = (i) => $row.find('td').eq(i).text().replace(/\s+/g, ' ').trim();
      apartments.push({
        houseManageNo,
        pblancNo: $row.attr('data-pbno') || houseManageNo,
        region: td(0),
        houseName: $row.attr('data-honm') || td(3),
        constructor: td(4),
        noticeDate: td(6),
        subscriptionPeriod: td(7),
        announcementDate: td(8),
      });
    });
    return apartments;
  }

  async getApartmentDetails(apartment) {
    const pblancNo = apartment.pblancNo || apartment.houseManageNo;
    const $ = await this.post(
      `${this.baseUrl}/ai/aia/selectAPTCompetitionPopup.do`,
      `houseManageNo=${apartment.houseManageNo}&pblancNo=${pblancNo}` +
        `&houseNm=${encodeURIComponent(apartment.houseName)}&gvPgmId=AIA01M01`
    );

    let totalSupply = 0;
    let firstRoundApplications = 0;
    let maxCompetitionRate = 0;
    const statusCounts = {
      firstLocal: 0,
      firstOther: 0,
      secondLocal: 0,
      secondOther: 0,
      underSubscribed: 0,
      inProgress: 0,
    };

    // #compitTbl is the real competition table; other tables on the page are
    // static calculation-formula legends and must be excluded.
    const rows = $('#compitTbl tbody tr');
    rows.each((index, element) => {
      const $row = $(element);
      const tds = $row.find('td');
      // Columns: 0 주택형 | 1 공급세대수 | 2 순위 | 3 지역 | 4 접수건수 | 5 경쟁률(미달) | 6 청약결과
      const supply = parseInt(tds.eq(1).text().replace(/[^\d]/g, ''), 10) || 0;
      const priority = tds.eq(2).text().trim();
      const area = tds.eq(3).text().trim() || $row.attr('data-sem') || '';
      const applications = parseInt(tds.eq(4).text().replace(/[^\d]/g, ''), 10) || 0;
      const rateText = tds.eq(5).text().trim();
      const statusText = tds.eq(6).text().trim();
      const isLocal = area.includes('해당');

      if (priority.includes('1순위') && isLocal) {
        totalSupply += supply;
        firstRoundApplications += applications;
      }

      // '△' marks under-subscription; otherwise the cell holds a numeric rate.
      if (rateText && !rateText.includes('△')) {
        const rate = parseFloat(rateText.replace(/[^\d.]/g, ''));
        if (!isNaN(rate) && rate > maxCompetitionRate) maxCompetitionRate = rate;
      }

      if (statusText.includes('미도래')) {
        // subscription not open yet — no status bucket
      } else if (statusText.includes('접수중') || statusText.includes('접수 중')) {
        statusCounts.inProgress++;
      } else if (rateText.includes('△')) {
        statusCounts.underSubscribed++;
      } else if (priority.includes('1순위')) {
        isLocal ? statusCounts.firstLocal++ : statusCounts.firstOther++;
      } else if (priority.includes('2순위')) {
        isLocal ? statusCounts.secondLocal++ : statusCounts.secondOther++;
      }
    });

    const averageCompetitionRate = totalSupply > 0 ? firstRoundApplications / totalSupply : 0;

    return {
      totalUnits: totalSupply,
      firstRoundApplications,
      averageCompetitionRate: Math.round(averageCompetitionRate * 100) / 100,
      maxCompetitionRate: Math.round(maxCompetitionRate * 100) / 100,
      subscriptionResult: classifySubscriptionResult(statusCounts, rows.length),
    };
  }

  /**
   * Expand an HTML table body into a full rectangular grid, resolving rowspan
   * (and colspan) so every logical cell is filled. Returns:
   *   values[r][c] — cell text (rowspan continuations carry the origin's text)
   *   spans[r][c]  — rowSpan count on the ORIGIN cell, 0 on continuation cells
   * applyhome's 청약홈 tables lean heavily on rowspan; this reconstructs the grid
   * losslessly so we can re-derive the merged layout the original site shows.
   */
  _expandGrid($, $trs) {
    const values = [];
    const spans = [];
    const carry = {}; // col -> { value, left }
    $trs.each((r) => {
      const row = [];
      const span = [];
      let col = 0;
      const drainCarry = () => {
        while (carry[col] && carry[col].left > 0) {
          row[col] = carry[col].value;
          span[col] = 0; // continuation — not rendered
          carry[col].left -= 1;
          col += 1;
        }
      };
      drainCarry();
      $($trs[r]).children('td,th').each((__, td) => {
        const text = $(td).text().replace(/\s+/g, ' ').trim();
        const rs = parseInt($(td).attr('rowspan') || '1', 10) || 1;
        const cs = parseInt($(td).attr('colspan') || '1', 10) || 1;
        for (let c = 0; c < cs; c += 1) {
          row[col] = text;
          span[col] = rs;
          if (rs > 1) carry[col] = { value: text, left: rs - 1 };
          col += 1;
          drainCarry();
        }
      });
      values.push(row);
      spans.push(span);
    });
    const width = Math.max(0, ...values.map((row) => row.length));
    for (let r = 0; r < values.length; r += 1) {
      for (let c = 0; c < width; c += 1) {
        if (values[r][c] === undefined) values[r][c] = '';
        if (spans[r][c] === undefined) spans[r][c] = 1;
      }
    }
    return { values, spans, width };
  }

  /**
   * Turn an expanded grid into render cells ({ v, rowSpan, show }) using a
   * per-column merge mode:
   *   'span'  — trust the source rowspan (origin renders, continuation hidden)
   *   'equal' — merge consecutive equal values WITHIN a 주택형 group; used for
   *             columns the 경쟁률 popup repeats per-row but 청약홈 visually merges
   *             (주택형/공급세대수/순위/청약결과)
   *   'none'  — never merge
   * Groups are runs of equal first-column values (works for both tables).
   */
  _mergeCells({ values, spans }, modes) {
    const n = values.length;
    if (!n) return [];
    // 주택형 group ranges (consecutive-equal on col 0)
    const groups = [];
    for (let r = 0; r < n; ) {
      let e = r;
      while (e + 1 < n && values[e + 1][0] === values[r][0]) e += 1;
      groups.push([r, e]);
      r = e + 1;
    }
    const width = modes.length;
    const cells = values.map((row) => row.slice(0, width).map((v) => ({ v, rowSpan: 1, show: true })));
    for (let c = 0; c < width; c += 1) {
      const mode = modes[c];
      if (mode === 'none') continue;
      if (mode === 'span') {
        for (let r = 0; r < n; r += 1) {
          const s = spans[r][c];
          cells[r][c].rowSpan = s || 1;
          cells[r][c].show = s > 0;
        }
        continue;
      }
      // 'equal' — merge runs within each group
      for (const [gs, ge] of groups) {
        for (let r = gs; r <= ge; ) {
          let e = r;
          while (e + 1 <= ge && values[e + 1][c] === values[r][c]) e += 1;
          cells[r][c].rowSpan = e - r + 1;
          cells[r][c].show = true;
          for (let k = r + 1; k <= e; k += 1) cells[k][c].show = false;
          r = e + 1;
        }
      }
    }
    return cells;
  }

  /**
   * Fetch the full raw detail for a single 단지 — the official links
   * (분양 홈페이지, 모집공고문 다운로드, 청약홈 공고 상세) plus the 일반공급(1·2순위)
   * and 특별공급 청약결과 tables, rebuilt with the merged-cell layout 청약홈 shows.
   */
  async getApartmentRawDetail({ houseManageNo, pblancNo, houseName }) {
    const pbNo = pblancNo || houseManageNo;
    const detailUrl =
      `${this.baseUrl}/ai/aia/selectAPTLttotPblancDetail.do` +
      `?houseManageNo=${houseManageNo}&pblancNo=${pbNo}`;
    const popupBody =
      `houseManageNo=${houseManageNo}&pblancNo=${pbNo}` +
      `&houseNm=${encodeURIComponent(houseName || '')}&gvPgmId=AIA01M01`;

    // 1) Announcement detail page → external homepage + 모집공고문 download link.
    let homepageUrl = null;
    let noticeUrl = null;
    try {
      const res = await axios.get(`${this.baseUrl}/ai/aia/selectAPTLttotPblancDetail.do`, {
        params: { houseManageNo, pblancNo: pbNo },
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      const $d = cheerio.load(Buffer.from(res.data).toString('utf-8'));
      $d('a').each((_, el) => {
        const href = ($d(el).attr('href') || '').trim();
        const text = ($d(el).text() || '').trim();
        if (!href || href.startsWith('#') || href.startsWith('javascript')) return;
        if (href.includes('getAtchmnfl.do') || text.includes('모집공고')) {
          if (!noticeUrl) noticeUrl = href;
        } else if (href.startsWith('http') && !href.includes('applyhome.co.kr')) {
          if (!homepageUrl) homepageUrl = href;
        }
      });
    } catch (error) {
      logger.warn(`Detail page fetch failed for ${houseManageNo}: ${error.message}`);
    }

    // 2) 일반공급 (1·2순위) 경쟁률 — selectAPTCompetitionPopup.do
    const competition = await this._fetchGeneralCompetition(popupBody, houseManageNo);

    // 3) 특별공급 청약접수 현황 — selectSpsplyReqstStusPopup.do
    const specialSupply = await this._fetchSpecialSupply(popupBody, houseManageNo);

    return {
      houseManageNo,
      pblancNo: pbNo,
      houseName,
      homepageUrl,
      noticeUrl,
      detailUrl,
      competition,
      specialSupply,
    };
  }

  /**
   * 일반공급 표. The 경쟁률 popup repeats 주택형/공급세대수/순위/청약결과 on every row
   * (no rowspan) but uses rowspan=2 + `.cpNonScore` placeholder cells for 당첨가점.
   * We drop the placeholders so the expander can carry 당첨가점 rowspans, then
   * merge the repeated columns by value to reproduce 청약홈's grouped layout.
   */
  async _fetchGeneralCompetition(popupBody, houseManageNo) {
    // 주택형 | 공급세대수 | 순위 | 지역 | 접수건수 | 순위내경쟁률 | 청약결과 | 당첨가점(지역/최저/최고/평균)
    const modes = ['equal', 'equal', 'equal', 'none', 'none', 'none', 'equal', 'span', 'span', 'span', 'span'];
    let cells = [];
    try {
      const $ = await this.post(`${this.baseUrl}/ai/aia/selectAPTCompetitionPopup.do`, popupBody);
      $('#compitTbl td.cpNonScore').remove(); // rowspan-gap placeholders
      const grid = this._expandGrid($, $('#compitTbl tbody tr'));
      if (grid.values.length) cells = this._mergeCells(grid, modes);
    } catch (error) {
      logger.warn(`Competition popup fetch failed for ${houseManageNo}: ${error.message}`);
    }
    return { rows: cells };
  }

  /**
   * 특별공급 청약접수 현황. Genuinely nested rowspans (주택형 rs4: 배정세대수 + 3 지역
   * rows; 기관추천/이전기관 rs3 across 지역 rows). We expand losslessly and trust the
   * source rowspans for every structural column. Type columns (다자녀가구 …) are read
   * from the table header so we stay correct as the supply mix varies per 공고.
   */
  async _fetchSpecialSupply(popupBody, houseManageNo) {
    try {
      const $ = await this.post(`${this.baseUrl}/ai/aia/selectSpsplyReqstStusPopup.do`, popupBody);
      const $table = $('table').first();
      const $trs = $table.find('tbody tr');
      if (!$trs.length) return null;

      const grid = this._expandGrid($, $trs);
      if (!grid.values.length) return null;

      // type labels = 2nd header row (다자녀가구, 신혼부부 상세, …); fall back to count.
      let typeLabels = $table
        .find('thead tr').eq(1).find('th')
        .map((_, th) => $(th).text().replace(/\s+/g, ' ').trim())
        .get();
      const typeCount = grid.width - 4; // 주택형, 공급세대수, 지역, 청약결과
      if (typeLabels.length !== typeCount) {
        typeLabels = Array.from({ length: Math.max(0, typeCount) }, (_, i) => typeLabels[i] || `구분${i + 1}`);
      }

      // 주택형 | 공급세대수 | 지역 | (type cols…) | 청약결과 — all structural cols use source spans.
      const modes = ['span', 'span', 'none', ...typeLabels.map(() => 'span'), 'span'];
      const cells = this._mergeCells(grid, modes);
      return { typeLabels, rows: cells };
    } catch (error) {
      logger.warn(`Special-supply popup fetch failed for ${houseManageNo}: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch competition details for a slice of listings (current page only),
   * keeping detail requests proportional to what is displayed.
   *
   * @param {Array}    list        listings to enrich
   * @param {number}   concurrency bounded parallel detail fetches
   * @param {Function} [onItem]    progress hook: (index, stage, data)
   *                               stage is 'start' (worker picked it up) or
   *                               'done' (detail merged into result).
   * @param {Function} [isAborted] returns true to stop early (client closed SSE).
   */
  async enrich(list, concurrency = 4, onItem = null, isAborted = null) {
    const fallback = (apt) => ({
      ...apt,
      totalUnits: 0,
      firstRoundApplications: 0,
      averageCompetitionRate: 0,
      maxCompetitionRate: 0,
      subscriptionResult: '-',
    });

    // Detail popups are independent — fetch them with bounded concurrency to
    // cut wall-time while staying gentle enough to avoid applyhome throttling.
    const out = new Array(list.length);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        if (isAborted && isAborted()) return;
        const i = next++;
        const apt = list[i];
        if (onItem) onItem(i, 'start', apt);
        try {
          out[i] = { ...apt, ...(await this.getApartmentDetails(apt)) };
        } catch (error) {
          logger.warn(`Detail fetch failed for ${apt.houseManageNo}: ${error.message}`);
          out[i] = fallback(apt);
        }
        if (onItem) onItem(i, 'done', out[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    return out;
  }
}

export default ApplyHomeCrawler;
