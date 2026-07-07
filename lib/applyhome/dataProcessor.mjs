/**
 * Data processing utilities adapted from the original VBA logic.
 * ESM port of the former src/utils/dataProcessor.js (only the helpers the
 * crawler/handlers actually use are kept).
 */

/**
 * Classify subscription result (adapted from VBA logic)
 */
export function classifySubscriptionResult(statusCounts, totalTypes) {
  const {
    firstLocal,
    firstOther,
    secondLocal,
    secondOther,
    underSubscribed,
    inProgress,
  } = statusCounts;

  if (firstLocal === totalTypes) {
    return '1순위 당해마감';
  }
  if (firstOther > 0 && secondLocal === 0 && secondOther === 0) {
    return '1순위 기타마감';
  }
  if (secondLocal > 0 && secondOther === 0) {
    return '2순위 당해마감';
  }
  if (secondOther > 0) {
    return '2순위 기타마감';
  }
  if (underSubscribed === totalTypes) {
    return '전체 미달';
  }
  if (inProgress > 0) {
    return '청약 접수중';
  }
  if (underSubscribed > 0) {
    return '일부타입 미달';
  }

  return '청약 접수일 미도래';
}

/**
 * Format number with commas (returns '-' for empty/zero).
 */
export function formatNumber(num) {
  if (!num || num === 0) return '-';
  return num.toLocaleString();
}
