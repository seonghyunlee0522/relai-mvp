/**
 * Business and legal facts — the ONE place they live. Used by the server (/terms, /privacy, landing footer, signup consent
 * check) and by the app (login/signup footer, consent checkboxes). Plain data + string builders only: no DOM, no imports,
 * so `server/` can import this file as is.
 *
 * Values marked TODO_ are founder-only blanks (research/relai-business-info.md "Still needed"); set them here before release.
 * The founder's birth date is deliberately not recorded anywhere.
 */
export const LEGAL = {
  company: '릴레이(RELAI)',
  ceo: '이성현',
  bizNo: '551-25-02019',
  address: '경기도 성남시 수정구 위례동로 135, 8층 801-a-6호(창곡동, 신성위캐슬타워)',
  mailOrderNo: '신고 준비 중',          // 통신판매업 신고번호 — replace with the issued number
  contactEmail: 'TODO_EMAIL',           // 고객 문의 + 개인정보 보호책임자 연락처
  contactPhone: '',                     // optional; shown only when set
  privacyOfficer: { name: '이성현', title: '대표' },
  effectiveDate: '2026-10-15',          // 시행일 of both documents (YYYY-MM-DD)
  /** Version recorded with each signup consent. Bump when the text of /terms or /privacy changes. */
  termsVersion: '2026-10-15',
  privacyVersion: '2026-10-15',
  dbLocation: 'TODO_DB_REGION',         // 국외 이전 표: Neon 프로젝트 리전의 국가 (Neon console → Project settings → Region). Vercel functions run in sin1 (vercel.json)
  courtSeat:'수원지방법원 성남지원',     // 관할: 회사 소재지(성남시 수정구) 관할 법원
};

/** '2026-10-15' → '2026년 10월 15일' */
export const koDate = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return `${y}년 ${m}월 ${d}일`; };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 전자상거래법 business-information lines (상호 · 대표 · 사업자등록번호 · 주소 · 통신판매업 신고번호 · 문의). HTML string. */
export function bizInfoHtml(L = LEGAL) {
  const items = [['상호', L.company], ['대표', L.ceo], ['사업자등록번호', L.bizNo], ['통신판매업 신고번호', L.mailOrderNo], ['주소', L.address],
    ['문의', `<a href="mailto:${esc(L.contactEmail)}">${esc(L.contactEmail)}</a>`, true], ...(L.contactPhone ? [['전화', L.contactPhone]] : [])];
  return items.map(([k, v, rawV]) => `<span class="legal-biz__i"><span class="legal-biz__k">${k}</span> ${rawV ? v : esc(v)}</span>`).join('');
}

/** Footer used on every public page (landing, pricing, login, signup, terms, privacy). Styles: .legal-foot in each page's CSS. */
export function legalFooterHtml(L = LEGAL) {
  return `<footer class="legal-foot"><nav class="legal-foot__links"><a href="/terms">이용약관</a><a href="/privacy"><b>개인정보처리방침</b></a><a href="/#pricing">요금 안내</a></nav>
<p class="legal-biz">${bizInfoHtml(L)}</p><p class="legal-foot__c">© ${new Date().getFullYear()} RELAI</p></footer>`;
}

/** 개인정보 수집·이용 동의 (PIPA 제15조 제2항: 항목 · 목적 · 보유기간 · 거부권과 불이익). Shown at signup. */
export const CONSENT_PRIVACY_ROWS = [
  ['수집 항목', '이름, 이메일 주소, 비밀번호(암호화 저장). Google로 가입하면 Google 계정 식별자와 이메일 인증 여부'],
  ['수집·이용 목적', '회원 식별과 가입 의사 확인, 서비스 제공, 계정 보안, 공지·고객 문의 응대'],
  ['보유·이용 기간', '회원 탈퇴 시까지. 다만 법령에 따라 보관하는 정보는 해당 기간(접속 기록 3개월, 결제 기록 5년 등)'],
  ['동의 거부', '동의를 거부할 수 있으나, 거부하면 회원가입과 서비스 이용이 불가합니다.'],
];
