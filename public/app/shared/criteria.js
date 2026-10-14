/* 성공 기준 품질 힌트 (Phase 1 US-5) — rule-based, not AI: a criterion with no number, %, date or 이내/이상/이하/미만/초과
 * is probably not measurable ("사용자 만족도 향상"). Shown as a gray hint under the item; never blocks completion. */
export const isMeasurable = (text) => /[0-9０-９%]|이내|이상|이하|미만|초과/.test(String(text || ''));
