import { Property } from '../types';
import { RawArticleInfo, NewLandArticle } from './naverApi';

// "3억 2,000" → 320_000_000원, "4,000" → 40_000_000원, "70" (만원단위) → 700_000원
function parseKoreanPrice(s: string): number {
  if (!s) return 0;
  const clean = s.replace(/,/g, '').trim();
  const eokMatch = clean.match(/^(\d+)억(?:\s*(\d+))?$/);
  if (eokMatch) {
    return parseInt(eokMatch[1], 10) * 100_000_000 + parseInt(eokMatch[2] ?? '0', 10) * 10_000;
  }
  const manMatch = clean.match(/^(\d+)$/);
  if (manMatch) return parseInt(manMatch[1], 10) * 10_000;
  return 0;
}

export function normalizeArticleInfo(
  info: RawArticleInfo,
  complexNumber: number,
  realtorCount = 1,
  complexName?: string,
): Property {
  const sp = info.spaceInfo ?? {};
  const bi = info.buildingInfo ?? {};
  const vi = info.verificationInfo ?? {};
  const br = info.brokerInfo ?? {};
  const ad = info.articleDetail ?? {};
  const addr = info.address ?? {};
  const pi = info.priceInfo ?? {};

  const addressStr = [addr.city, addr.division, addr.sector].filter(Boolean).join(' ');

  // Number() 강제 변환: API가 숫자를 문자열로 반환하는 경우 대비.
  // NaN 방지를 위해 || 0 패턴 사용.
  const num = (v: unknown): number => Number(v) || 0;

  // fin.land /complex/article/list: dealPrice는 원 단위, premiumPrice/optionPrice는 만원 단위
  const dealWon    = num(pi.dealPrice);
  const premiumWon = num(pi.premiumPrice) * 10_000;
  const optionWon  = num(pi.optionPrice)  * 10_000;
  // 분양권: isalePrice = 매매가 - 프리미엄 - 옵션비용 (fin.land list에 isalePrice 필드 없음)
  const retype = String(info.realEstateType ?? '');
  const isPresale  = retype === 'ABYG' || retype === 'OBYG';
  const isaleWon   = isPresale && dealWon > 0 ? Math.max(0, dealWon - premiumWon - optionWon) : 0;

  return {
    midName: '',
    smallName: '',
    complexNumber: num(complexNumber),
    complexName: String(complexName ?? info.complexName ?? ''),
    dongName: String(info.dongName ?? ''),
    articleNumber: String(info.articleNumber ?? ''),
    realEstateType: retype,
    tradeType: String(info.tradeType ?? ''),
    dealPrice: dealWon,
    warrantyPrice: num(pi.warrantyPrice),
    rentPrice: num(pi.rentPrice),
    managementFee: num(pi.managementFeeAmount),
    priceChangeStatus: num(pi.priceChangeStatus),
    priceChangeHistories: pi.priceChangeHistories,
    isalePrice: isaleWon,
    premiumPrice: premiumWon,
    optionPrice: optionWon,
    supplySpace: num(sp.supplySpace),
    exclusiveSpace: num(sp.exclusiveSpace),
    contractSpace: num(sp.contractSpace),
    supplySpaceName: String(sp.supplySpaceName ?? ''),
    exclusiveSpaceName: String(sp.exclusiveSpaceName ?? ''),
    direction: String(ad.direction ?? ''),
    floorInfo: String(ad.floorInfo ?? ''),
    targetFloor: String(ad.floorDetailInfo?.targetFloor ?? ''),
    totalFloor: String(ad.floorDetailInfo?.totalFloor ?? ''),
    address: addressStr,
    lat: num(addr.coordinates?.yCoordinate),
    lng: num(addr.coordinates?.xCoordinate),
    articleFeature: String(ad.articleFeatureDescription ?? ''),
    brokerageName: String(br.brokerageName ?? ''),
    brokerName: String(br.brokerName ?? ''),
    confirmDate: String(vi.articleConfirmDate ?? ''),
    buildDate: String(bi.buildingConjunctionDate ?? ''),
    realtorCount: num(realtorCount),
    verificationType: String(vi.verificationType ?? ''),
  };
}

export function normalizeNewLandArticle(article: NewLandArticle): Property {
  const [targetFloor = '', totalFloor = ''] = (article.floorInfo ?? '').split('/');

  // 매매: dealOrWarrantPrc = 매매가, 전세: = 보증금, 월세: = 보증금 / rentPrc = 월세
  const warrantyOrDeal = parseKoreanPrice(article.dealOrWarrantPrc);
  const rent = parseKoreanPrice(article.rentPrc ?? '');
  const tc = article.tradeTypeCode ?? '';
  const dealPrice      = tc === 'A1' ? warrantyOrDeal : 0;
  const warrantyPrice  = tc === 'B1' || tc === 'B2' ? warrantyOrDeal : 0;
  const rentPrice      = tc === 'B2' ? rent : 0;

  const priceChangeStatus = article.priceChangeState === 'INCREASE' ? 1
    : article.priceChangeState === 'DECREASE' ? -1 : 0;

  return {
    midName: '',
    smallName: '',
    complexNumber: 0,
    complexName: article.articleName ?? '',
    dongName: article.buildingName ?? '',
    articleNumber: article.articleNo ?? '',
    realEstateType: article.realEstateTypeCode ?? '',
    tradeType: article.tradeTypeCode ?? '',
    dealPrice,
    warrantyPrice,
    rentPrice,
    managementFee: 0,
    priceChangeStatus,
    isalePrice: 0,
    premiumPrice: 0,
    optionPrice: 0,
    supplySpace: article.area1 ?? 0,
    exclusiveSpace: article.area2 ?? 0,
    contractSpace: 0, // new.land /api/articles 에는 계약면적 없음
    supplySpaceName: article.areaName ?? '',
    exclusiveSpaceName: '',
    direction: article.direction ?? '',
    floorInfo: article.floorInfo ?? '',
    targetFloor,
    totalFloor,
    address: '',
    lat: parseFloat(article.latitude ?? '0') || 0,
    lng: parseFloat(article.longitude ?? '0') || 0,
    articleFeature: article.articleFeatureDesc ?? '',
    brokerageName: article.cpName ?? '',
    brokerName: article.realtorName ?? '',
    confirmDate: article.articleConfirmYmd ?? '',
    buildDate: '',
    realtorCount: article.sameAddrCnt ?? 1,
    verificationType: article.verificationTypeCode ?? '',
  };
}

