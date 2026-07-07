/**
 * Request validation for the applyhome search/crawl endpoints.
 * ESM port of the former src/utils/validation.js — Joi is dropped in favour of
 * a couple of plain checks (the only rules we actually rely on are the YYYYMM
 * date format and integer page/limit defaults).
 */

const YYYYMM = /^\d{6}$/;

/**
 * Validate the search query. Returns { error, value } where value carries the
 * normalised fields (page/limit defaulted) — mirrors the old Joi contract.
 */
export function validateSearchRequest(data = {}) {
  const details = [];

  const startDate = data.startDate;
  const endDate = data.endDate;
  if (startDate != null && startDate !== '' && !YYYYMM.test(String(startDate))) {
    details.push({ message: 'startDate must be in YYYYMM format' });
  }
  if (endDate != null && endDate !== '' && !YYYYMM.test(String(endDate))) {
    details.push({ message: 'endDate must be in YYYYMM format' });
  }

  const keyword = data.keyword;
  if (keyword != null && String(keyword).length > 100) {
    details.push({ message: 'keyword must be 100 characters or fewer' });
  }

  const page = data.page != null && data.page !== '' ? parseInt(data.page, 10) : 1;
  if (Number.isNaN(page) || page < 1) {
    details.push({ message: 'page must be an integer >= 1' });
  }

  const limit = data.limit != null && data.limit !== '' ? parseInt(data.limit, 10) : 20;
  if (Number.isNaN(limit) || limit < 1 || limit > 100) {
    details.push({ message: 'limit must be an integer between 1 and 100' });
  }

  if (details.length) return { error: { details }, value: null };

  return {
    error: null,
    value: {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      region: data.region || undefined,
      keyword: keyword || undefined,
      page,
      limit,
    },
  };
}

/**
 * Validate the (legacy) crawl-trigger request. Both dates required, YYYYMM.
 */
export function validateCrawlRequest(data = {}) {
  const details = [];
  if (!data.startDate || !YYYYMM.test(String(data.startDate))) {
    details.push({ message: 'startDate is required and must be YYYYMM' });
  }
  if (!data.endDate || !YYYYMM.test(String(data.endDate))) {
    details.push({ message: 'endDate is required and must be YYYYMM' });
  }
  if (data.keyword != null && String(data.keyword).length > 100) {
    details.push({ message: 'keyword must be 100 characters or fewer' });
  }
  return details.length ? { error: { details } } : { error: null };
}
