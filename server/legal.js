/**
 * Public legal pages (QA B9, SHL-14): GET /terms (이용약관), GET /privacy (개인정보 처리방침), the business-information footer
 * injected into the landing page, and GET /pricing → landing #pricing.
 *
 * The text is the AI draft in research/relai-terms.md / relai-privacy.md with every blank filled from the business info and
 * the code (vercel.json region, NicePay, Resend, Neon, Google sign-in, Anthropic/OpenAI adapters, Jira). The "법률 검토 필요"
 * notice and reviewer memos stay in the drafts only. Facts (company, contact, 시행일, versions) come from
 * public/app/shared/legal-info.js — change them there, never here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LEGAL, koDate, legalFooterHtml } from '../public/app/shared/legal-info.js';
import { PLANS, annualView, catalogue, ANNUAL_DISCOUNT_PCT, CREDIT_PRICE_KRW, TOPUP_STEP_KRW, TOPUP_MAX_KRW, MIN_CARD_KRW, PURCHASED_VALID_YEARS } from './plans.js';
import { pricingHtml, PRICING_CSS, soonCta } from '../public/app/shared/pricing.js';
import { paymentsEnabled } from './billing/provider.js';
import { shareMeta } from './share-meta.js';
import { ga4For } from './ga4.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Inline: escape, then **bold** and [text](href). */
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, h) => `<a href="${h}">${t}</a>`);

/**
 * Tiny Markdown subset for the two documents: #/##/### headings, paragraphs, "- " lists, "1. " lists (an indented "- " line
 * nests under the previous item), and | tables | (first row = header, second = separator). Tables get a scroll box at 375px.
 */
export function renderDoc(md) {
  const out = []; const lines = md.split('\n'); let i = 0; let n = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{1,3}) (.*?)(?: \{#([a-z][\w-]*)\})?$/.exec(l))) {   // "## 제목 {#anchor}" → id="anchor" (links like /terms#refund)
      const lv = m[1].length; const id = m[3] || (lv === 2 ? `s${n + 1}` : '');
      if (lv === 2) n++;
      out.push(`<h${lv}${id ? ` id="${id}"` : ''}>${inline(m[2])}</h${lv}>`); i++; continue;
    }
    if (l.startsWith('|')) {
      const rows = []; while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const [head, , ...body] = rows;
      out.push(`<div class="doc__tbl"><table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^(\d+\.|-) /.test(l)) {
      const ordered = /^\d+\. /.test(l); const items = [];
      while (i < lines.length && (/^(\d+\.|-) /.test(lines[i]) || /^\s+- /.test(lines[i]))) {
        const x = lines[i++];
        if (/^\s+- /.test(x)) { const last = items[items.length - 1]; if (last) last.sub.push(x.replace(/^\s+- /, '')); }
        else items.push({ t: x.replace(/^(\d+\.|-) /, ''), sub: [] });
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it.t)}${it.sub.length ? `<ul>${it.sub.map((s) => `<li>${inline(s)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#{1,3} |\||(\d+\.|-) )/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}


/**
 * 이용약관 v3 (pricing v3, legal-review.md §8 · §10). Every number comes from server/plans.js (catalogue), so the terms and the
 * screens never drift. 유료서비스·환불, AI 크레딧 이용 정책, 정기결제 및 자동 갱신 안내 are chapters/sections of this one document
 * with anchors (#billing, #credits, #recurring, #refund) — legal-review §10 allows "별첨 또는 분리".
 * Items marked Legal Review Required in legal-review.md §9 are written with the recommended defaults (decisions.md D3–D7) and are
 * listed in the release note, not decided silently.
 */
export function termsMarkdown(L = LEGAL) {
  const P = PLANS.PRO; const T = PLANS.TEAM; const F = PLANS.FREE;
  const n = (v) => Number(v).toLocaleString('ko-KR');
  const av = (p) => annualView(p.price.MONTHLY, p.price.ANNUAL);
  const step = TOPUP_STEP_KRW; const per = CREDIT_PRICE_KRW;
  return `## 제1장 총칙

### 제1조 (목적)
이 약관은 ${L.company}(이하 "회사")이 제공하는 프로젝트 가이드 서비스 RELAI 및 관련 제반 서비스(이하 "서비스")의 이용과 관련하여 회사와 이용자의 권리, 의무, 책임사항 및 기타 필요한 사항을 정합니다.

### 제2조 (용어의 정의)
1. "이용자"란 이 약관에 따라 회사가 제공하는 서비스를 이용하는 회원을 말합니다.
2. "회원"이란 이 약관에 동의하고 계정을 생성한 자를 말합니다.
3. "워크스페이스"란 회원이 서비스 안에서 프로젝트와 데이터를 관리하는 단위 공간을 말하며, 워크스페이스를 만든 회원 또는 그로부터 소유자 권한을 받은 회원을 "소유자(OWNER)"라 합니다. 요금제, 결제, 사용자·프로젝트 한도와 AI 크레딧은 모두 워크스페이스 단위로 계약·관리되며, 한 회원이나 프로젝트가 여러 워크스페이스에 속하면 워크스페이스마다 따로 계산합니다.
4. "고객"이란 워크스페이스의 유료 요금제를 신청하고 이용요금을 결제하는 소유자 또는 그가 대표하는 법인·단체를 말합니다.
5. "사용자 수"란 워크스페이스에 소속된 활성 회원의 수(소유자 포함)를 말합니다. 같은 회원이 그 워크스페이스의 여러 프로젝트에 참여해도 1명으로 계산하고, 초대를 보내 수락을 기다리는 인원은 초대한 때부터 사용자 한도의 자리를 차지합니다. 비활성화되거나 워크스페이스에서 제외된 회원은 계산하지 않습니다.
6. "활성 프로젝트"란 상태가 준비·진행·보류인 프로젝트를 말합니다. 완료 또는 보관된 프로젝트는 활성 프로젝트 한도에 포함하지 않습니다.
7. "추가 이용"이란 요금제의 기본 한도 외에 고객이 구매하는 추가 사용자와 추가 프로젝트를 말합니다.
8. "정기결제"란 고객이 등록한 결제수단으로 이용기간(1개월 또는 12개월)마다 이용요금이 자동 결제되는 방식을 말합니다. 유료 요금제는 정기결제로만 제공하며, 이용기간을 한 번만 결제하는 이용권은 판매하지 않습니다.
9. "크레딧"이란 AI 기능 이용 시 차감되는 서비스 내 이용 단위를 말하며, 1 크레딧은 ${n(per)}원(부가가치세 포함)에 해당합니다. 크레딧은 다음과 같이 나눕니다.
   - 기본 크레딧: 유료 요금제에 포함되어 지급 주기(월)마다 지급되고 그 주기가 끝나면 소멸하는 크레딧
   - 가입 크레딧: 새 Free 워크스페이스에 한 번 지급하는 크레딧과 회사가 프로모션으로 무상 지급한 크레딧
   - 유상 크레딧: 고객이 결제하여 충전한 크레딧

### 제3조 (약관의 게시와 개정)
1. 회사는 이 약관의 내용과 상호, 대표자 성명, 영업소 소재지 주소, 사업자등록번호, 통신판매업 신고번호, 연락처 등을 이용자가 쉽게 알 수 있도록 서비스 초기 화면 또는 연결 화면에 게시합니다.
2. 회사는 「약관의 규제에 관한 법률」, 「전자상거래 등에서의 소비자보호에 관한 법률」(이하 "전자상거래법"), 「정보통신망 이용촉진 및 정보보호 등에 관한 법률」 등 관련 법령을 위반하지 않는 범위에서 이 약관을 개정할 수 있습니다.
3. 회사가 약관을 개정하는 경우 적용일자와 개정 사유를 명시하여 적용일자 7일 전부터 공지합니다. 다만 이용자에게 불리하거나 중대한 변경은 30일 전부터 공지하고 개정 전후 비교표를 함께 게시하며, 등록된 이메일로 개별 통지합니다.
4. 이용자가 개정 약관의 적용일까지 거부 의사를 표시하지 않고 서비스를 계속 이용하면 개정 약관에 동의한 것으로 봅니다. 이 경우 회사는 제3항의 공지·통지 시 이 효과를 분명히 알립니다. 동의하지 않는 이용자는 이용계약을 해지할 수 있습니다.
5. 제4항은 이용요금의 증액, 무료 또는 할인 이용에서 유료로의 전환에는 적용하지 않습니다. 이 경우 회사는 제10조에 따라 고객의 별도의 명시적 동의를 받습니다.

### 제4조 (약관 외 준칙)
이 약관에 정하지 않은 사항은 관련 법령, 회사가 정한 개별 운영정책 및 일반 상관례에 따릅니다. 고객과 회사가 별도 계약(Enterprise 계약 등)을 체결한 경우 그 계약이 이 약관보다 우선합니다.

## 제2장 이용계약

### 제5조 (이용계약의 성립)
1. 이용계약은 가입 신청자가 이 약관과 개인정보 수집·이용에 동의하고 이메일·비밀번호 또는 Google 계정으로 가입을 신청한 후, 회사가 이를 승낙함으로써 성립합니다.
2. 회원은 만 14세 이상이어야 합니다. 서비스는 업무용 서비스입니다.
3. 회사는 다음 각 호에 해당하는 신청을 승낙하지 않거나 사후에 이용계약을 해지할 수 있습니다.
   - 타인의 이메일 등 정보를 도용하거나 허위 정보를 기재한 경우
   - 이전에 이 약관 위반으로 이용이 제한된 경우
   - 그 밖에 관련 법령을 위반하거나 부정한 목적으로 신청한 경우

### 제6조 (계정 및 워크스페이스 관리)
1. 회원은 자신의 계정 정보를 안전하게 관리해야 하며, 제3자가 이용하게 해서는 안 됩니다.
2. 워크스페이스 소유자와 관리자(ADMIN)는 구성원 초대, 권한 변경, 내보내기를 할 수 있으며, 워크스페이스 내 구성원의 이용에 대해 고객으로서 책임을 집니다. 요금제 변경, 추가 이용 구매, 크레딧 충전, 해지는 소유자가 합니다.
3. 회원은 계정의 도용이나 무단 사용을 알게 된 경우 즉시 회사에 알려야 합니다.

## 제3장 요금제와 결제 {#billing}

### 제7조 (요금제)
1. 서비스의 요금제는 다음과 같습니다. 모든 금액은 부가가치세 10%를 포함한 금액이며, 실제로 결제되는 카드 결제 금액입니다. 세부 내용은 [요금 안내](/#pricing)에 게시하며, 결제 화면에는 결제 전에 최종 금액을 표시합니다.

| 요금제 | 월간 결제 | 연간 결제(12개월분 한 번에) | 활성 프로젝트 | 기본 사용자 | AI 크레딧 | 크레딧 충전 |
|---|---|---|---|---|---|---|
| Free | 무료 | 무료 | ${n(F.included.projects)}개 | ${n(F.included.users)}명 | 최초 ${n(F.credits.once)} 크레딧(1회) | 불가 |
| Pro | 월 ${n(P.price.MONTHLY)}원 | 연 ${n(P.price.ANNUAL)}원(월 ${n(av(P).monthly_equivalent)}원 환산, ${av(P).discount_pct}% 할인) | ${n(P.included.projects)}개 | ${n(P.included.users)}명 | 매월 ${n(P.credits.monthly)} 크레딧 | 가능 |
| Team | 월 ${n(T.price.MONTHLY)}원 | 연 ${n(T.price.ANNUAL)}원(월 ${n(av(T).monthly_equivalent)}원 환산, ${av(T).discount_pct}% 할인) | ${n(T.included.projects)}개 | ${n(T.included.users)}명 | 매월 ${n(T.credits.monthly)} 크레딧 | 가능 |
| Enterprise | 별도 견적 | 별도 견적 | 계약으로 정함 | 계약으로 정함 | 계약으로 정함 | 계약에 따름 |

2. 연간 결제는 12개월분 이용요금을 한 번에 결제하며, 월간 결제 금액의 12배에서 ${ANNUAL_DISCOUNT_PCT}%를 할인한 금액입니다. 연간 결제에도 기본 크레딧은 매월 지급합니다.
3. 새로 만든 워크스페이스는 Free 요금제로 시작합니다. Free 요금제는 결제 정보 없이 이용하며, 기간이 지나도 유료 요금제로 자동 전환되거나 결제되지 않습니다.
4. 회사는 그 밖의 프로모션을 제공할 수 있으며, 그 조건과 기간은 프로모션 안내에 따릅니다.

### 제7조의2 (추가 이용)
1. Pro와 Team 고객은 워크스페이스 단위로 다음 추가 이용을 구매할 수 있습니다(부가가치세 포함).

| 항목 | 월간 결제 | 연간 결제(월 환산) |
|---|---|---|
| 추가 사용자 1명(Pro·Team) | 월 ${n(P.addons.user.MONTHLY)}원 | 연 ${n(P.addons.user.ANNUAL)}원(월 ${n(Math.floor(P.addons.user.ANNUAL / 12))}원) |
| 추가 프로젝트 1개(Pro) | 월 ${n(P.addons.project.MONTHLY)}원 | 연 ${n(P.addons.project.ANNUAL)}원(월 ${n(Math.floor(P.addons.project.ANNUAL / 12))}원) |
| 추가 프로젝트 1개(Team) | 월 ${n(T.addons.project.MONTHLY)}원 | 연 ${n(T.addons.project.ANNUAL)}원(월 ${n(Math.floor(T.addons.project.ANNUAL / 12))}원) |

2. 이용기간 중에 추가 이용을 구매하면 현재 이용기간의 남은 일수에 대한 금액만 결제합니다. 금액 = 단가(현재 결제 주기 기준) × 수량 × 남은 일수 ÷ 이용기간 일수이며, 남은 일수는 구매일을 포함하고 이용기간 종료일을 포함하지 않습니다(한국 시간 기준).
3. 고객에게 받는 금액은 원 미만을 버리고, 고객에게 돌려주는 금액은 원 미만을 올립니다. 계산 결과가 ${n(MIN_CARD_KRW)}원 미만이면 결제 없이 다음 갱신일까지 무상으로 제공합니다.
4. 결제 전에 결제 금액, 계산 근거와 다음 갱신 시 결제 예정 금액을 화면에 표시합니다. 추가 한도는 결제가 승인된 뒤에 늘어나며, 같은 주문으로 두 번 결제되거나 한도가 두 번 늘어나지 않습니다.
5. 추가 이용의 감소·해지는 다음 갱신일부터 적용되며, 현재 이용기간의 금액은 환불하지 않습니다. 다만 구매일부터 7일 이내에는 제12조에 따라 철회할 수 있습니다. 현재 사용량이 줄어든 한도를 넘으면 먼저 사용자를 줄이거나 프로젝트를 완료·보관해야 합니다.

### 제7조의3 (한도의 적용)
1. 워크스페이스의 한도는 요금제의 기본 한도에 고객이 구매한 추가 이용을 더한 것입니다. 사용자 한도는 활성 사용자와 수락을 기다리는 초대 인원을 합하여 적용하고, 프로젝트 한도는 활성 프로젝트에 적용합니다.
2. 완료 또는 보관된 프로젝트는 조회와 내보내기를 할 수 있으나 수정은 제한됩니다. 완료·보관된 프로젝트를 다시 활성화할 때는 활성 프로젝트 한도를 확인합니다.
3. 한도에 이르면 새 프로젝트 생성, 초대 등 한도를 늘리는 작업만 제한됩니다.
4. 요금제 변경, 이용기간 만료, 해지 등으로 사용량이 한도를 넘게 되면 데이터는 삭제하지 않으며, 워크스페이스는 계속 조회할 수 있습니다. 이 경우 생성일이 가장 최근인 활성 프로젝트부터 변경된 요금제의 활성 프로젝트 한도만큼만 수정할 수 있고, 나머지 활성 프로젝트는 자동으로 조회 전용이 됩니다(고객이 수정할 프로젝트를 고르지 않습니다). 조회 전용 프로젝트는 수정·삭제·AI를 통한 데이터 변경·가져오기·외부 연동 반영이 제한되며, 조회, 내보내기와 보관은 할 수 있습니다. 한도 안으로 정리될 때까지 새 프로젝트·초대가 제한되며, 다시 구독하거나 요금제를 올리면 새 한도만큼 최근 프로젝트부터 수정 권한이 돌아옵니다. 회사는 예정된 변경 7일 전에 이 사실을 알립니다.

### 제8조 (Free 요금제)
1. Free 요금제는 무료로 제공되며, 한도를 넘는 이용은 유료 요금제로 변경해야 할 수 있습니다.
2. 새 Free 워크스페이스에는 가입 크레딧 ${n(F.credits.once)} 크레딧을 한 번 지급합니다. 같은 회원이 워크스페이스를 다시 만들거나, 탈퇴 후 다시 가입하거나, 요금제를 바꾸어도 다시 지급하지 않습니다. Free 요금제에서는 매월 크레딧을 지급하지 않으며 크레딧을 충전할 수 없습니다.
3. 회사는 Free 요금제의 기능과 한도를 변경할 수 있으며, 이 경우 30일 전에 공지합니다.
4. Free 요금제는 유료 서비스가 아니므로 제18조의 서비스 장애 보상 규정이 적용되지 않습니다.

### 제8조의2 (AI 크레딧 이용 정책) {#credits}
1. 크레딧은 워크스페이스 공용으로 관리합니다. 크레딧의 소유·충전·차감 주체는 워크스페이스이며, 사용 내역은 사용자·프로젝트·기능별로 기록되어 워크스페이스 구성원이 서비스 화면에서 확인할 수 있습니다.
2. AI 기능은 실행할 때마다 기능별로 정해진 크레딧을 차감합니다. 기능별 크레딧은 [요금 안내](/#pricing)와 서비스 화면에 게시하며 실행 전에 표시합니다. 실패한 요청은 차감하지 않으며, 실행을 위해 예약한 크레딧은 반환합니다. 여러 요청이 동시에 들어와도 잔액이 0 아래로 내려가지 않습니다.
3. 기본 크레딧(Pro 매월 ${n(P.credits.monthly)}, Team 매월 ${n(T.credits.monthly)})은 각 지급 주기(월) 시작일에 지급되고, 그 주기가 끝나면 남은 수량이 소멸하며 다음 달로 이월되거나 환불되지 않습니다. 연간 결제도 매월 지급합니다.
4. 크레딧은 기본 크레딧, 가입 크레딧, 유상 크레딧의 순서로 차감하며, 유상 크레딧은 먼저 충전한 것부터 차감합니다.
5. 크레딧 충전은 Pro 이상 요금제의 워크스페이스 소유자만 할 수 있습니다. 충전 금액은 ${n(step)}원 단위로 1회 ${n(step)}원부터 ${n(TOPUP_MAX_KRW)}원까지이며, ${n(step)}원당 ${n(step / per)} 크레딧이 충전됩니다. 충전은 한 번 결제하는 방식이며 자동으로 결제되지 않습니다. 결제가 승인되고 검증된 뒤에만 적립되며, 결제가 실패하면 적립하지 않습니다. Enterprise 고객의 충전은 계약에 따릅니다.
6. 유상 크레딧은 충전일부터 ${PURCHASED_VALID_YEARS}년간 사용할 수 있습니다. 구독이 끝나 Free 요금제로 바뀌어도 남은 유상 크레딧과 가입 크레딧은 계속 사용할 수 있습니다. 기본 크레딧은 구독이 끝날 때 소멸합니다.
7. 크레딧은 현금으로 교환하거나 다른 워크스페이스·회원에게 양도할 수 없습니다. 유상 크레딧의 환불은 제13조 제5항에 따릅니다.
8. 크레딧 잔액이 회사가 정한 기준 아래로 내려가면 회사는 소유자에게 이메일로 알립니다. 크레딧이 모두 소진되면 AI 기능을 실행할 수 없습니다.

### 제9조 (결제)
1. 유료 요금제, 추가 이용과 크레딧 충전은 결제대행사(나이스페이먼츠 주식회사, 이하 "NicePay")를 통해 신용카드 등 회사가 정한 수단으로 결제합니다. 회사는 카드번호, 유효기간, CVC 등 결제수단 정보를 저장하지 않으며, 결제 승인 결과와 거래 식별자, 정기결제를 이용하는 경우 NicePay가 발급한 정기결제용 식별값(빌링키, 암호화 보관)만 보관합니다.
2. 회사는 결제 전에 요금제명, 결제 금액(부가가치세 포함), 결제 주기, 최초 결제일, 다음 결제 예정일과 예정 금액, 자동 갱신 여부, 해지 방법과 환불 기준을 화면에 표시하며, 고객의 결제 동의 기록(일시, 표시한 내용, 금액)을 보관합니다. 결제 화면의 동의 항목과 추가 이용 옵션은 미리 선택되어 있지 않습니다.
3. 결제 금액은 서버가 계산하며, 결제 승인 금액이 주문 금액과 다르면 결제를 반영하지 않고 취소합니다.
4. 유료 요금제의 결제는 결제대행사의 정기결제 승인을 받은 뒤에 시작합니다. 그 전까지 요금제 화면의 결제 버튼에는 "정기결제 준비 중"을 표시하며 결제를 받지 않습니다.
5. 신용카드 결제분은 신용카드 매출전표로 세금계산서를 갈음하며, 같은 거래에 세금계산서를 따로 발행하지 않습니다. 계좌이체로 결제하는 Enterprise 고객에게는 전자세금계산서를 발행합니다.

### 제9조의2 (정기결제 및 자동 갱신 안내) {#recurring}
1. 유료 요금제는 고객이 결제 화면에서 정기결제에 별도로 동의한 때에만 시작합니다. 동의 체크박스는 미리 선택되어 있지 않으며, 동의하지 않으면 결제되지 않고 Free 요금제를 계속 이용합니다.
2. 정기결제에 동의한 고객은 최초 결제일을 기준으로 이용기간마다 같은 날짜에 이용요금이 자동 결제됩니다. 해당 날짜가 없는 달에는 그 달의 말일에 결제됩니다. 갱신 금액은 요금제 금액에 그때 유지 중인 추가 이용 금액을 더한 금액이며, 결제 전 화면과 설정 › 플랜 · 결제 화면에 표시합니다.
3. 연간 정기결제는 갱신일 30일 전과 7일 전에 갱신 금액과 해지 방법을 이메일로 알립니다.
4. 정기결제가 실패하면 회사는 고객에게 알리고 실패일부터 7일 동안 최대 3회 다시 결제를 시도합니다. 이 기간에는 기존 요금제를 그대로 이용할 수 있으며, 이 기간에도 결제되지 않으면 Free 요금제로 전환되고 제7조의3 제4항이 적용됩니다.
5. 고객은 월간·연간 모두 설정 › 플랜 · 결제에서 결제와 같은 단계 이내로 언제든지 정기결제를 해지할 수 있습니다. 해지하면 자동 갱신이 즉시 중단되어 다음 결제일에 결제되지 않으며, 회사는 빌링키를 NicePay에서 삭제합니다.

### 제10조 (요금 변경)
1. 회사는 이용요금을 변경할 수 있으며, 인상하는 경우 시행 30일 전에 변경 전후 금액, 적용일과 해지 방법을 공지하고 이메일로 개별 통지합니다. 인상된 요금은 통지 이후 처음 도래하는 갱신일부터 적용됩니다.
2. 정기결제 금액이 늘어나는 경우(가격 인상, 할인 종료 등) 회사는 갱신일 전 30일 이내에 고객의 별도의 명시적 동의를 받으며, 동의하지 않거나 응답하지 않으면 늘어난 금액으로 결제하지 않습니다. 이 경우 회사는 공지 때 미리 정한 바에 따라 종전 금액으로 결제하거나 정기결제를 해지하고 이용기간 종료로 처리합니다. 동의 창을 닫는 것은 동의로 보지 않습니다.
3. 고객이 직접 결제하여 생긴 변경(상위 요금제 변경, 추가 이용 구매, 월간에서 연간으로 변경)은 결제 시 받은 동의에 따릅니다.
4. 회사는 무료 또는 할인 이용 기간이 끝난 뒤 유료로 자동 전환하지 않습니다. Free 워크스페이스가 유료 요금제를 이용하려면 고객이 직접 결제해야 합니다.

### 제10조의2 (요금제 변경)
1. 상위 요금제로의 변경(예: Pro → Team)은 즉시 적용되며, 현재 이용기간의 남은 일수에 대한 차액을 제7조의2 제2항·제3항의 방법으로 결제합니다. 변경한 지급 주기에는 차이만큼의 기본 크레딧을 추가로 지급합니다.
2. 하위 요금제로의 변경, 연간에서 월간으로의 변경, 월간에서 연간으로의 변경은 현재 이용기간이 끝나는 날에 적용되며, 이미 결제한 기간에 대해 중복으로 청구하지 않습니다. 예약한 변경은 적용 전까지 설정 화면에서 취소할 수 있습니다.

### 제11조 (해지)
1. 고객은 월간·연간 요금제 모두 설정 › 플랜 · 결제 화면에서 언제든지 해지할 수 있으며, 이메일(${L.contactEmail})로도 요청할 수 있습니다. 해지하면 자동 갱신은 즉시 중단됩니다. 회사는 해지를 막기 위한 반복 안내나 설문을 요구하지 않으며, 위약금을 받지 않습니다.
2. 고객은 해지할 때 다음 중 하나를 선택합니다.
   - 기간 만료 시 종료: 이미 결제한 이용기간이 끝날 때까지 유료 요금제를 이용한 뒤 Free 요금제로 전환됩니다.
   - 즉시 종료: 해지일에 이용을 끝내고 사용하지 않은 기간의 요금을 제13조에 따라 일할 계산하여 환불받습니다. 즉시 Free 요금제로 전환되고 기본 크레딧은 소멸합니다.
3. 해지나 전환만으로 프로젝트 데이터는 삭제되지 않습니다. 워크스페이스의 모든 프로젝트 데이터는 계속 조회하고 내보낼 수 있으며, Free 요금제의 한도를 넘는 프로젝트는 제7조의3 제4항에 따라 조회 전용으로 유지합니다. 워크스페이스 삭제는 해지와 별도로 처리합니다.

### 제12조 (청약철회)
1. 고객은 유료 요금제, 추가 이용 또는 크레딧 충전의 결제일부터 7일 이내에 청약을 철회할 수 있습니다. 서비스는 기간에 따라 나눌 수 있는 용역이므로, 이미 이용한 일수에 해당하는 금액(결제 금액 × 이용 일수 ÷ 이용기간 일수, 원 미만 버림)만 공제하고 나머지를 환불하며 위약금은 없습니다(전자상거래법 제17조 제2항 제5호 단서, 제18조).
2. 크레딧 충전의 청약철회는 제13조 제5항 제1호에 따릅니다.
3. 회사는 청약철회 요청을 받은 날부터 3영업일 이내에 결제 취소 또는 환불 절차를 진행합니다.
4. 이 조는 회원이 사업자인지와 관계없이 서비스 화면에서 결제한 모든 고객에게 적용합니다. 다만 Enterprise 개별 계약은 그 계약에 따릅니다.

### 제13조 (환불) {#refund}
1. 법정 청약철회권(제12조)을 먼저 적용하며, 결제 취소와 환불은 관련 법령에 따라 처리합니다.
2. 구독 환불(월간·연간 공통): 즉시 종료를 선택하면 사용하지 않은 기간에 대해 일할 계산하여 환불하며, 위약금이나 수수료를 공제하지 않습니다. 환불액 = 결제 금액 × 남은 일수 ÷ 이용기간 일수(한국 시간 기준)입니다. 연간 결제도 실제로 결제한 금액을 기준으로 계산하며 월간 정상가로 다시 계산하지 않습니다. 예: Pro 연간 ${n(P.price.ANNUAL)}원을 결제하고 365일 중 100일 이용 후 해지하면 환불액은 ${n(Math.ceil(P.price.ANNUAL * 265 / 365))}원입니다.
3. 요금제를 즉시 종료하면 추가 이용도 같은 방법으로 일할 계산하여 환불합니다. 추가 이용만 줄이는 경우는 제7조의2 제5항에 따릅니다.
4. 결제 오류·중복 결제: 회사 또는 결제 시스템의 오류로 이중 결제되거나 정해진 금액보다 많이 결제된 경우, 회사는 확인 즉시(늦어도 3영업일 이내) 초과 결제분 전액을 결제 취소로 환불하며 수수료를 공제하지 않습니다. 결제가 승인되었는데 요금제나 크레딧이 반영되지 않은 경우에도 같습니다.
5. 유상 크레딧:
   - 충전일부터 7일 이내: 사용하지 않은 유상 크레딧에 해당하는 금액(1 크레딧 = ${n(per)}원) 전액을 환불합니다. 일부를 사용한 경우에도 같습니다.
   - 7일이 지난 뒤에도 유효기간(충전일부터 ${PURCHASED_VALID_YEARS}년) 안에서는 사용하지 않은 유상 크레딧에 해당하는 금액 전액을 공제 없이 환불합니다.
   - 워크스페이스 삭제·탈퇴 전에는 남은 유상 크레딧과 환불 방법을 안내합니다.
   - 기본 크레딧, 가입 크레딧, 프로모션 등 무상으로 지급한 크레딧과 이미 사용한 크레딧은 환불하지 않습니다.
6. 회사의 귀책으로 서비스를 정상적으로 이용하지 못한 경우에는 제18조에 따라 보상하거나 해당 기간 요금을 환불합니다.
7. 환불 금액의 원 미만은 올리며, 환불액은 결제 금액을 넘지 않습니다. 환불은 원래의 결제수단(카드 전체 또는 부분 취소)으로 하며, 카드 취소 기간(결제일부터 1년)이 지났거나 결제수단 사정으로 불가능한 경우 고객이 지정한 계좌로 송금합니다.

## 제4장 서비스 이용

### 제14조 (서비스의 제공과 변경)
1. 서비스는 연중무휴 24시간 제공을 원칙으로 합니다. 다만 시스템 점검, 증설, 장애, 외부 서비스(클라우드·결제·이메일 등)의 문제가 있는 경우 일시 중단될 수 있습니다.
2. 계획된 점검은 7일 전에 공지하며, 긴급 점검은 사후에 공지할 수 있습니다.
3. 회사는 운영상·기술상 필요에 따라 서비스의 기능을 추가·변경·중단할 수 있습니다. 유료 요금제의 핵심 기능을 중단하는 경우 30일 전에 공지하고, 고객이 이용을 원하지 않으면 남은 이용기간에 해당하는 요금과 남은 유상 크레딧을 공제 없이 환불합니다.
4. AI 기능의 결과물은 이용자가 입력한 데이터를 바탕으로 자동 생성되며 정확성을 보장하지 않습니다. 이용자는 AI 결과물을 검토한 후 사용해야 합니다.

### 제15조 (이용자의 의무)
이용자는 다음 행위를 해서는 안 됩니다.
1. 타인의 계정 도용, 허위 정보 등록
2. 서비스를 이용하여 법령 또는 제3자의 권리(저작권, 영업비밀, 개인정보 등)를 침해하는 행위
3. 서비스의 취약점 공격, 비정상적 대량 요청, 역설계 등 서비스 운영을 방해하는 행위
4. 회사의 사전 동의 없이 서비스를 재판매하거나 영리 목적으로 제3자에게 제공하는 행위
5. 개인정보를 정당한 권한 없이 입력하거나, 주민등록번호 등 고유식별정보, 민감정보를 서비스에 입력하는 행위
6. 가입 크레딧을 다시 받기 위해 계정이나 워크스페이스를 반복하여 만드는 행위

### 제16조 (고객 데이터)
1. 고객 데이터의 권리는 고객에게 있습니다. 회사는 서비스 제공, 장애 대응, 고객 요청 처리에 필요한 범위에서만 고객 데이터에 접근하며, 고객의 동의 없이 제3자에게 제공하지 않습니다.
2. 고객 데이터에 이해관계자 정보 등 개인정보가 포함되는 경우, 고객은 그 개인정보의 처리자로서 적법한 근거를 갖추어야 하며, 회사는 고객의 위탁을 받아 처리하는 수탁자의 지위에 있습니다. 세부사항은 [개인정보 처리방침](/privacy)과 고객이 요청하는 경우 체결하는 개인정보 처리위탁 계약에 따릅니다.
3. 고객은 언제든지 엑셀 내보내기 기능 등으로 고객 데이터를 내려받을 수 있습니다.
4. 요금제 변경, 이용기간 만료, 해지, 결제 실패로 데이터를 삭제하지 않습니다(제7조의3 제4항).
5. 워크스페이스가 삭제되면 회사는 30일 동안 데이터를 보관한 후 복구할 수 없도록 삭제합니다. 다만 법령에 따라 보관해야 하는 정보(결제 기록 등)는 해당 기간 동안 보관합니다.
6. 회사는 고객 데이터를 식별할 수 없도록 통계 처리한 정보를 서비스 개선에 이용할 수 있습니다. 회사는 고객 데이터를 AI 모델 학습에 이용하지 않습니다.

### 제17조 (이용제한)
회사는 이용자가 제15조를 위반하거나 서비스의 정상 운영을 방해한 경우 사전 통지 후 경고, 일시 정지, 이용계약 해지를 할 수 있습니다. 다만 긴급한 보안 위협이 있는 경우 먼저 조치하고 사후에 통지할 수 있습니다. 이용자는 이에 대해 이의를 신청할 수 있습니다.

## 제5장 책임과 분쟁

### 제18조 (서비스 장애 보상)
1. 회사의 귀책으로 유료 요금제 고객이 사전 고지 없이 유료 기능을 이용하지 못한 경우, 회사는 그 시간의 3배에 해당하는 이용기간을 무상으로 연장합니다. 장애 시간은 고객이 회사에 알리거나 회사가 인지한 때부터 계산합니다.
2. 장애가 1개월 동안 누적 72시간을 넘으면 고객은 이용계약을 해지할 수 있으며, 회사는 남은 기간의 이용요금을 환불하고 손해를 배상합니다. 다만 회사가 고의 또는 과실이 없음을 증명한 경우에는 배상하지 않습니다.
3. 24시간 전에 공지한 정기 점검은 월 24시간까지 장애 시간에 포함하지 않습니다.
4. 실패한 AI 요청에는 크레딧을 차감하지 않으며, 예약된 크레딧은 반환합니다.

### 제19조 (책임의 제한)
1. 회사는 천재지변, 전쟁, 통신망·클라우드 사업자의 장애 등 불가항력으로 서비스를 제공할 수 없는 경우 책임을 지지 않습니다.
2. 회사는 이용자의 귀책사유(계정 관리 소홀, 잘못된 데이터 입력 등)로 생긴 손해에 대해 책임을 지지 않습니다.
3. 회사는 이용자가 서비스(AI 결과물 포함)를 이용하여 내린 업무상 판단과 그 결과에 대해 책임을 지지 않습니다.
4. 회사의 고의 또는 중대한 과실이 없는 한, 회사가 고객에게 지는 손해배상 책임은 손해 발생 직전 12개월 동안 고객이 회사에 지급한 이용요금 총액을 한도로 합니다.
5. 제4항은 전자상거래법상 소비자인 회원에게는 관련 법령이 허용하는 범위에서만 적용됩니다.

### 제20조 (통지)
회사의 이용자에 대한 통지는 이용자가 등록한 이메일로 하며, 불특정 다수 이용자에 대한 통지는 서비스 내 공지로 갈음할 수 있습니다.

### 제21조 (분쟁 해결과 관할)
1. 회사와 이용자 간 분쟁은 상호 협의로 해결합니다.
2. 협의가 되지 않아 소송이 제기되는 경우 대한민국 법을 적용하며, 관할 법원은 ${L.courtSeat}으로 합니다. 다만 소비자인 회원에게는 「민사소송법」상 관할 법원 규정을 따릅니다.

## 부칙
1. 이 약관은 ${koDate(L.termsEffectiveDate || L.effectiveDate)}부터 시행합니다.
2. (경과조치) 이 약관 시행 전에 결제한 이용기간은 그 기간이 끝날 때까지 결제 당시의 조건(요금제, 사용자 수, 한도)을 유지합니다. 그 이후 이 약관의 요금으로 갱신하려면 제10조의 동의를 받습니다.
3. (경과조치) 이 약관 시행 전에 지급되거나 충전된 크레딧 잔액은 줄어들지 않으며, 무상 지급분은 가입 크레딧으로, 충전분은 유상 크레딧으로 계속 사용할 수 있습니다. 이전 약관에 따라 무료 크레딧을 받은 워크스페이스에는 가입 크레딧을 다시 지급하지 않습니다.
4. (경과조치) 이 약관 시행 전에 회사가 약속한 무료 이용 기간이나 혜택은 약속한 기간이 끝날 때까지 유지합니다.
`;
}

/** 개인정보 처리방침. Items follow server/schema.sql; vendors follow the code (see file header). */
export function privacyMarkdown(L = LEGAL) {
  return `${L.company}(이하 "회사")은 「개인정보 보호법」(이하 "법") 제30조에 따라 정보주체의 개인정보를 보호하고 관련 고충을 신속하고 원활하게 처리하기 위해 다음과 같이 개인정보 처리방침을 수립·공개합니다.

## 제1조 (처리하는 개인정보 항목과 수집 방법)

| 구분 | 항목 | 수집 방법 |
|---|---|---|
| 회원가입(이메일) | 필수: 이메일 주소, 이름, 비밀번호(복원할 수 없는 방식으로 암호화하여 저장) | 가입 화면 |
| 회원가입(Google 로그인) | 필수: 이메일 주소, 이름, Google 계정 고유 식별자, 이메일 인증 여부 | Google로부터 제공 |
| 약관 동의 | 이용약관·개인정보 수집·이용 동의 일시와 동의한 문서의 버전 | 가입 화면 |
| 구성원 초대 | 필수: 초대받는 사람의 이메일 주소. 선택: 이름 | 초대한 회원이 입력 |
| 유료 결제·추가 이용·크레딧 충전 | 결제 승인 정보(결제일시, 금액, 주문번호, 거래 식별자, 영수증 주소), 요금제·결제 주기·추가 사용자·추가 프로젝트 구매 내역, 크레딧 충전·차감·환불 내역, 카드사명과 카드번호 끝 4자리, NicePay가 발급한 정기결제 식별값(빌링키, 암호화 저장, 정기결제 해지 시 NicePay에서 삭제). 정기결제 카드 등록 시 입력하는 카드번호·유효기간·생년월일(또는 사업자등록번호)·비밀번호 앞 2자리는 회사가 저장하지 않고 암호화하여 NicePay로만 전달합니다. Enterprise 계좌이체 고객의 세금계산서 발행 요청 시: 상호, 사업자등록번호, 대표자명, 담당자 이메일 | 결제 화면, NicePay 결제창 |
| 결제·정기결제 동의 기록 | 동의한 회원, 동의 일시, 동의 종류(결제·정기결제·가격 변경·충전 조건), 동의 당시 표시한 약관 버전과 고지 내용의 해시값, 금액, 결제 주기, 다음 결제 예정일, IP 주소의 해시값, 브라우저 정보. 가격 변경 안내의 발송·동의·거부 일시 | 결제 화면, 가격 변경 안내 화면 |
| 가입 크레딧 중복 지급 방지 | 가입 크레딧을 받은 워크스페이스의 소유자 식별자, 소유자 이메일 주소의 해시값(원래 주소로 되돌릴 수 없는 값), 지급 일시 | 워크스페이스 생성 시 |
| 외부 서비스 연동(선택) | Jira 계정 표시명, 계정 식별자, 사이트 주소, 접근 토큰(암호화 저장) | 연동 시 Atlassian으로부터 제공 |
| 자동 수집 | 로그인 기록(접속 일시, IP 주소, 브라우저 정보), 서비스 이용 기록(작업 이력, AI 기능 사용 기록: 기능, 실행한 회원, 프로젝트, 차감 크레딧), 서비스 이용 통계(사용한 화면·기능, 접속 일자 — 회원·워크스페이스·프로젝트 식별자만 기록), 세션 쿠키, 서버 접속 로그, 이메일 발송 기록 | 서비스 이용 과정 |
| 랜딩 페이지 광고 측정 | 쿠키, 광고 식별자, 방문 기록 | Google 광고 태그(gtag) |
| 공개 페이지 유입 분석 | 쿠키, 방문 페이지, 유입 경로(검색·광고·UTM 등), 기기·브라우저 정보 | Google 애널리틱스(랜딩·가입·로그인·약관 페이지에서만) |

**고객이 입력하는 데이터의 개인정보.** 고객은 프로젝트 정의(이해관계자의 이름, 조직, 부서, 역할), 요구사항, 이슈, 주간보고 등에 제3자의 개인정보를 입력할 수 있습니다. 이 정보에 대해서는 고객이 개인정보처리자이고, 회사는 고객의 위탁을 받아 처리하는 수탁자입니다(제5조 제3항). 회사는 주민등록번호 등 고유식별정보와 민감정보를 수집하지 않으며, 이용자는 이를 서비스에 입력해서는 안 됩니다.

## 제2조 (개인정보의 처리 목적)
1. 회원 관리: 가입 의사 확인, 본인 식별·인증, 계정 보안(부정 이용 방지, 비정상 로그인 차단), 회원 자격 유지·관리, 고지·통지
2. 서비스 제공: 워크스페이스와 프로젝트 기능 제공, 구성원 초대 이메일 발송, 주간보고 생성, AI 기능 제공, 외부 서비스 연동
3. 요금 결제와 정산: 유료 요금제·추가 이용 결제, 정기결제와 결제 전 고지·동의 기록 보관, 크레딧 충전·차감·잔액 알림과 사용 내역 제공, 환불, 세금계산서 발행
8. 부정 이용 방지: 가입 크레딧(최초 1회)이 재가입이나 워크스페이스 재생성으로 중복 지급되지 않도록 확인
4. 고객 지원: 문의 처리, 분쟁 조정을 위한 기록 보존
5. 서비스 개선과 마케팅(랜딩 페이지 광고 측정): 광고 효과 측정, 이용 통계 분석(개인을 식별할 수 없는 형태)
6. 서비스 개선을 위한 이용 분석(로그인 후 서비스 화면): 가입·기능 사용·재방문 통계. 회사가 직접 운영하는 데이터베이스에서만 분석하며, 외부 분석 도구로 보내거나 별도 쿠키를 쓰지 않습니다.
7. 유입 분석(공개 페이지): 방문자가 어떤 경로로 RELAI를 알게 되었는지 파악(Google 애널리틱스, 개인을 식별할 수 없는 통계 형태)

## 제3조 (개인정보의 보유와 이용 기간)
1. 회사는 회원 탈퇴 시 또는 처리 목적이 달성된 때 지체 없이 개인정보를 파기합니다. 다만 다음의 경우에는 명시한 기간 동안 보관합니다.

| 근거 | 항목 | 기간 |
|---|---|---|
| 전자상거래법 | 계약 또는 청약철회 등에 관한 기록 | 5년 |
| 전자상거래법 | 대금결제와 재화 등의 공급에 관한 기록 | 5년 |
| 전자상거래법 | 소비자의 불만 또는 분쟁처리에 관한 기록 | 3년 |
| 국세기본법 | 세금계산서 등 거래에 관한 장부와 증빙 서류 | 법정 신고기한부터 5년 |
| 통신비밀보호법 | 로그인 기록(접속 일시, IP 주소) | 3개월 |
| 개인정보의 안전성 확보조치 기준 | 운영자(개인정보취급자)의 개인정보처리시스템 접속 기록(계정, 접속 일시, 접속지, 조회·처리한 화면과 대상) | 2년 |

2. 회원이 탈퇴하면 회원 계정 정보(이름·이메일·비밀번호·로그인 수단·약관 동의 기록이 담긴 계정 자체)를 즉시 삭제합니다. 로그인 세션, 알림·안내 설정, 이용 분석 기록, 이메일 발송 기록, 보낸 초대 중 아직 수락되지 않은 초대도 함께 삭제합니다. 다른 회원과 함께 쓰는 워크스페이스에 남긴 업무 기록(요구사항, WBS, 댓글, 변경 이력 등)은 그 워크스페이스의 자료이므로 남지만, 작성자는 '탈퇴한 사용자'로만 표시되며 탈퇴한 회원과 연결되지 않습니다. 법령에 따라 보관하는 다음 기록은 탈퇴한 회원의 계정과 연결을 끊고 가명 처리한 상태로, 정해진 기간이 지나면 자동으로 파기합니다.

| 보관하는 기록 | 보관 항목 | 기간 |
|---|---|---|
| 계약·동의 기록 | 가입 일시, 동의한 이용약관·개인정보 처리방침의 버전과 동의 일시 | 탈퇴일로부터 5년 |
| 결제·정기결제 동의 기록 | 제1조의 결제·정기결제 동의 기록 | 동의일로부터 5년 |
| 가입 크레딧 지급 기록 | 소유자 이메일 주소의 해시값, 지급 일시 | 지급일로부터 3년(탈퇴 후에도 중복 지급 방지를 위해 이 기간 동안 보관) |
| 대금결제·주문·환불 기록 | 주문 번호, 상품, 금액, 결제·환불 일시, 구매자 이름과 이메일 | 거래가 있었던 해의 다음 해 1월 1일부터 6년(국세기본법의 법정 신고기한부터 5년이 지난 후) |
| 불만·분쟁 처리 기록 | 회원이 남긴 의견·문의 내용과 처리 내역 | 접수일로부터 3년 |
| 로그인 기록 | 접속 일시, IP 주소, 브라우저 정보 | 접속일로부터 3개월 |

관리자 조치 기록에는 이름과 이메일을 지운 형태로만 남습니다.
3. 워크스페이스가 삭제되면 그 워크스페이스의 데이터(초대 정보 포함)는 30일 동안 보관한 후 파기합니다(이용약관 제16조).
4. 탈퇴하지 않은 회원의 기록도 다음 기간이 지나면 자동으로 파기합니다. 결제 기록과 결제·정기결제 동의 기록은 제1항·제2항의 기간을 따르되, 회원 자격이 유지되는 동안의 결제 기록은 계약 관계가 끝날 때까지 보관합니다.

| 기록 | 항목 | 기간 |
|---|---|---|
| 서비스 이용 통계 | 사용한 화면·기능, 접속 일자 | 기록일로부터 1년 |
| AI 기능 사용 기록 | 기능, 실행한 회원, 프로젝트, 차감 크레딧, 처리 결과 | 실행일로부터 1년(크레딧 충전·차감 내역은 워크스페이스의 결제 기록으로 보관) |
| 이메일 발송 기록 | 수신자 이메일 주소, 메일 종류, 발송 결과 | 발송일로부터 1년 |
| 초대 정보 | 초대받은 사람의 이메일 주소와 이름 | 수락되지 않은 초대는 만료·취소일로부터 30일. 수락된 초대는 회원 계정 정보와 같이 처리 |
| 가입 크레딧 지급 기록 | 소유자 이메일 주소의 해시값, 지급 일시 | 지급일로부터 3년 |
| 불만·분쟁 처리 기록 | 회원이 남긴 의견·문의 내용과 처리 내역 | 접수일로부터 3년 |

5. (장기 미이용 계정) 1년 동안 로그인하거나 서비스를 이용한 기록이 없는 계정은 삭제합니다. 삭제 30일 전에 회원의 이메일로 삭제 예정일과 삭제되는 정보를 알리며, 그 전에 로그인하면 삭제하지 않습니다. 삭제는 회원 탈퇴와 같은 방법으로 하며(제2항), 혼자 쓰는 워크스페이스는 제3항에 따라 처리합니다. 다만 유료 구독이 진행 중이거나 다른 회원과 함께 쓰는 워크스페이스의 유일한 소유자인 계정은 계약 관계와 다른 회원의 이용을 위해 삭제하지 않습니다.
6. Google 애널리틱스로 수집한 유입 분석 정보는 Google 애널리틱스의 데이터 보관 기간 설정(2개월)에 따라 보관된 후 자동 삭제되며, 그 이후에는 개인을 식별할 수 없는 집계 통계만 남습니다.

## 제4조 (개인정보의 제3자 제공)
회사는 정보주체의 동의, 법률의 특별한 규정 등 법 제17조와 제18조에 해당하는 경우에만 개인정보를 제3자에게 제공합니다. 현재 회사는 개인정보를 제3자에게 제공하지 않습니다.

## 제5조 (개인정보 처리의 위탁)
1. 회사는 원활한 서비스 제공을 위해 다음과 같이 개인정보 처리 업무를 위탁합니다.

| 수탁자 | 위탁 업무 |
|---|---|
| Vercel Inc. | 웹 애플리케이션 호스팅, 서버 접속 로그 처리 |
| Neon(Databricks, Inc.) | 데이터베이스 운영과 저장 |
| 나이스페이먼츠 주식회사 | 결제 처리, 결제 취소·부분 취소(환불), 정기결제(빌링키 발급·관리·삭제) |
| Resend(Plus Five Five, Inc.) | 서비스 이메일(가입 인증, 비밀번호 재설정, 초대, 결제·크레딧 안내) 발송 |
| Google LLC | 공개 페이지 유입 분석(Google 애널리틱스) |
| OpenAI, L.L.C.(AI 기능을 사용하는 경우) | AI 기능 처리(요구사항 추출, WBS 생성, 변경 영향 분석, 프로젝트 질의응답) |

2. 회사는 위탁계약 체결 시 법 제26조에 따라 위탁 업무 수행 목적 외 처리 금지, 기술적·관리적 보호조치, 재위탁 제한, 수탁자 관리·감독, 손해배상 등을 계약서 등 문서에 명시하고, 수탁자가 개인정보를 안전하게 처리하는지 감독합니다.
3. 고객이 서비스에 입력한 개인정보(제1조 하단)에 대해 회사는 고객의 수탁자로서 고객의 지시에 따라 서비스 제공 목적으로만 처리하며, 고객이 요청하면 개인정보 처리위탁 계약을 체결합니다.

## 제6조 (개인정보의 국외 이전)
회사는 서비스 제공을 위해 다음과 같이 개인정보를 국외로 이전(처리위탁·보관)합니다. 이는 법 제28조의8 제1항 제3호에 따라 정보주체와의 계약 이행을 위해 필요한 처리위탁·보관으로서, 이 처리방침에 공개하는 방법으로 알립니다.

| 이전받는 자(연락처) | 이전 국가 | 이전 일시와 방법 | 이전 항목 | 이용 목적과 보유 기간 |
|---|---|---|---|---|
| Vercel Inc. (privacy@vercel.com) | 싱가포르(서버 리전), 미국 | 서비스 이용 시 네트워크를 통해 수시 전송 | 제1조의 모든 항목(접속 기록 포함) | 호스팅. 회원 탈퇴 또는 위탁계약 종료 시까지 |
| Neon(Databricks, Inc.) (privacy@neon.tech) | ${L.dbLocation} | 서비스 이용 시 네트워크를 통해 수시 전송 | 제1조의 모든 항목과 고객 데이터 | 데이터 저장. 회원 탈퇴 또는 위탁계약 종료 시까지 |
| Resend(Plus Five Five, Inc.) (privacy@resend.com) | 미국 | 이메일 발송 시 네트워크를 통해 전송 | 수신자 이메일 주소, 이름, 이메일 본문 | 이메일 발송. Resend의 발송 기록 보관 정책에 따름 |
| Google LLC (support.google.com/policies) | 미국 | Google 로그인 시, 공개 페이지(랜딩·가입·로그인·약관) 방문 시 네트워크를 통해 전송 | 로그인 인증 정보, 쿠키, 방문 페이지, 유입 경로, 기기·브라우저 정보 | 로그인 인증, 광고 효과 측정, 유입 분석. 유입 분석 정보는 제3조 제6항의 기간, 그 밖에는 Google 정책에 따름 |
| OpenAI, L.L.C. (privacy@openai.com) | 미국 | AI 기능 실행 시 네트워크를 통해 전송 | AI 기능 사용 시 입력한 프로젝트 내용(요구사항·WBS·변경·이슈 등, 이해관계자 정보 등 개인정보가 포함될 수 있음) | AI 생성(요구사항 추출, WBS 초안, 변경 영향 분석, 프로젝트 질의응답). 보유 기간은 OpenAI의 API 데이터 정책에 따르며, OpenAI는 API로 받은 데이터를 모델 학습에 이용하지 않습니다 |
| Atlassian(Jira 연동 시) | 미국 등 | 연동 동기화 시 | 연동된 프로젝트 데이터, Jira 계정 식별자 | 고객이 요청한 연동 제공. 연동 해제 시까지 |

AI 제공사를 다른 사업자(예: Anthropic, PBC)로 바꾸는 경우 회사는 위 표와 제5조의 표를 고치고 시행 7일 전부터 알립니다.

정보주체는 국외 이전을 거부할 수 있습니다. 다만 호스팅·데이터 저장·이메일 발송을 위한 국외 이전은 서비스 제공에 필수이므로, 거부하는 경우 서비스를 이용할 수 없습니다. AI 기능, Google 로그인, Jira 연동은 선택 기능이며, 이용하지 않으면 해당 국외 이전은 발생하지 않습니다. Google 애널리틱스로의 이전은 제10조 제3항의 방법으로 거부할 수 있습니다. 거부 방법: 개인정보 보호책임자 이메일(${L.contactEmail})로 요청.

## 제7조 (개인정보의 파기 절차와 방법)
1. 회사는 보유 기간이 끝나거나 처리 목적이 달성된 개인정보를 지체 없이(5일 이내) 파기합니다.
2. 전자적 파일 형태의 정보는 복구할 수 없는 방법으로 삭제하며, 종이 문서는 분쇄하거나 소각합니다.
3. 회원 탈퇴 시 회원 계정 정보는 탈퇴 즉시 데이터베이스에서 삭제하며, 별도로 보관하지 않습니다.
4. 법령에 따라 보존하는 정보(제3조)는 회원 계정과 연결을 끊고 가명 처리하여 다른 정보와 분리해 보관하며, 보존 목적 외에는 이용하지 않습니다. 회사는 매일 보존 기간이 지난 기록을 확인해 지체 없이 파기합니다.

## 제8조 (정보주체와 법정대리인의 권리·의무와 행사 방법)
1. 정보주체는 회사에 대해 언제든지 개인정보 열람, 정정·삭제, 처리정지, 동의 철회를 요구할 수 있습니다.
2. 권리 행사는 서비스 설정 화면(프로필 수정, 계정 삭제) 또는 개인정보 보호책임자에게 서면, 이메일로 할 수 있으며, 회사는 10일 이내에 조치합니다.
3. 정보주체는 자동화된 결정에 대해 거부하거나 설명을 요구할 수 있습니다. 다만 회사는 정보주체의 권리에 중대한 영향을 미치는 자동화된 결정을 하지 않습니다.
4. 고객이 입력한 데이터에 포함된 제3자의 개인정보에 대한 권리 행사는 해당 고객(개인정보처리자)에게 해야 하며, 회사는 고객의 요청에 협조합니다.
5. 회사는 만 14세 미만 아동의 가입을 받지 않습니다.

## 제9조 (개인정보의 안전성 확보 조치)
1. 관리적 조치: 내부관리계획 수립·시행, 개인정보 취급자 최소화와 교육
2. 기술적 조치:
   - 비밀번호는 단방향 암호화(scrypt)하여 저장
   - 세션 토큰, 초대 토큰, 인증 링크 토큰은 해시값으로만 저장
   - 외부 서비스 연동 토큰과 정기결제 빌링키는 암호화(AES-GCM)하여 저장
   - 모든 통신에 HTTPS(TLS) 적용, HSTS 사용
   - 워크스페이스 단위 접근 통제, 관리자 조치 기록(감사 로그) 보관
   - 로그인 시도 횟수 제한
3. 물리적 조치: 클라우드 사업자(Vercel, Neon)의 인증된 데이터센터를 이용

## 제10조 (개인정보 자동 수집 장치의 설치·운영과 거부)
1. 회사는 로그인 상태 유지를 위해 필수 쿠키(세션 쿠키)를 사용합니다. 이 쿠키를 거부하면 로그인이 필요한 서비스를 이용할 수 없습니다.
2. 회사는 랜딩 페이지에서 광고 효과 측정을 위해 Google 광고 태그를 사용합니다. 이용자는 웹 브라우저 설정(예: Chrome → 설정 → 개인정보 및 보안 → 서드파티 쿠키)에서 쿠키 저장을 거부하거나 Google 광고 설정 페이지에서 맞춤 광고를 해제할 수 있습니다.
3. 회사는 공개 페이지(랜딩·회원가입·로그인·이용약관·개인정보 처리방침)에서 유입 분석을 위해 Google 애널리틱스를 사용하며, 이 과정에서 쿠키가 저장되고 방문 페이지, 유입 경로, 기기·브라우저 정보가 미국의 Google LLC로 전송됩니다(제6조). IP 주소는 익명 처리되며 이름, 이메일 등 회원을 식별하는 정보는 보내지 않고, 로그인 후 서비스 화면에서는 사용하지 않습니다. 이용자는 웹 브라우저의 쿠키 설정에서 저장을 거부하거나 Google 애널리틱스 차단 브라우저 부가기능(tools.google.com/dlpage/gaoptout)을 설치하여 수집을 거부할 수 있으며, 거부하더라도 서비스 이용에는 제한이 없습니다.

## 제11조 (개인정보 보호책임자)
회사는 개인정보 처리에 관한 업무를 총괄하여 책임지고, 정보주체의 불만 처리와 피해 구제를 위해 다음과 같이 개인정보 보호책임자를 지정합니다.
- 개인정보 보호책임자: ${L.privacyOfficer.name} / ${L.privacyOfficer.title} / ${L.contactEmail}${L.contactPhone ? ` / ${L.contactPhone}` : ''}

## 제12조 (권익침해 구제 방법)
정보주체는 개인정보 침해로 인한 구제를 받기 위해 다음 기관에 분쟁 해결이나 상담을 신청할 수 있습니다.
- 개인정보분쟁조정위원회: (국번없이) 1833-6972 (www.kopico.go.kr)
- 개인정보침해신고센터: (국번없이) 118 (privacy.kisa.or.kr)
- 대검찰청: (국번없이) 1301 (www.spo.go.kr)
- 경찰청: (국번없이) 182 (ecrm.police.go.kr)

## 제13조 (처리방침의 변경)
이 개인정보 처리방침은 ${koDate(L.effectiveDate)}부터 적용됩니다. 내용이 변경되는 경우 시행 7일 전부터(중요한 변경은 30일 전부터) 서비스 공지사항으로 알립니다.
`;
}

/** Styles for the public legal pages and the shared .legal-foot block (landing uses its own copy of the footer rules). */
const PAGE_CSS = `:root{--blue:#2E51C4;--navy:#101828;--text:#101828;--text-2:#475467;--muted:#667085;--border:#E4EAF2;--border-soft:#EEF2F7;--bg-alt:#F8FAFD}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:#fff;color:var(--text);font-family:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;font-size:16px;line-height:1.75;word-break:keep-all;overflow-wrap:anywhere}
a{color:var(--blue)}
.top{border-bottom:1px solid var(--border);background:#fff}
.top__in,.doc,.legal-foot{max-width:820px;margin:0 auto;padding:0 16px}
.top__in{display:flex;align-items:center;gap:20px;height:60px}
.logo{font-weight:800;font-size:20px;letter-spacing:-.03em;color:var(--navy);text-decoration:none}
.top__nav{margin-left:auto;display:flex;gap:16px;font-size:14px}.top__nav a{color:var(--text-2);text-decoration:none}.top__nav a[aria-current]{color:var(--navy);font-weight:700}
.doc{padding-top:40px;padding-bottom:56px}
.doc h1{font-size:30px;line-height:1.3;letter-spacing:-.03em;margin:0 0 8px;color:var(--navy)}
.doc__meta{color:var(--muted);font-size:14px;margin:0 0 32px}
.doc h2{font-size:21px;margin:40px 0 12px;color:var(--navy);letter-spacing:-.02em;scroll-margin-top:16px}
.doc h3{font-size:17px;margin:28px 0 8px;color:var(--navy)}
.doc p,.doc li{color:#344054}.doc ol,.doc ul{padding-left:1.4em;margin:8px 0 12px}.doc li{margin:4px 0}
.doc__tbl{overflow-x:auto;margin:12px 0 16px;border:1px solid var(--border);border-radius:8px}
.doc table{border-collapse:collapse;width:100%;min-width:560px;font-size:14px;line-height:1.6;overflow-wrap:normal}
.doc td:first-child{min-width:7.5em}
.doc th,.doc td{padding:10px 12px;border-bottom:1px solid var(--border-soft);text-align:left;vertical-align:top}
.doc th{background:var(--bg-alt);color:var(--navy);font-weight:700;white-space:nowrap}.doc tr:last-child td{border-bottom:0}
${LEGAL_FOOT_CSS()}
@media (max-width:640px){.doc{padding-top:28px}.doc h1{font-size:25px}.doc h2{font-size:19px}.top__nav{gap:12px;font-size:13px}}`;

/** Footer rules shared by the legal pages (inline here) — public/index.html and app.css carry the same rules. */
export function LEGAL_FOOT_CSS() {
  return `.legal-foot{border-top:1px solid var(--border);padding-top:24px;padding-bottom:32px;font-size:13px;line-height:1.7;color:var(--muted)}
.legal-foot__links{display:flex;flex-wrap:wrap;gap:6px 18px;margin-bottom:10px}.legal-foot__links a{color:var(--text-2);text-decoration:none}.legal-foot__links a:hover{text-decoration:underline}
.legal-biz{margin:0;display:flex;flex-wrap:wrap;gap:2px 14px}.legal-biz__k{color:var(--text-2)}.legal-biz a{color:inherit}
.legal-foot__c{margin:8px 0 0}`;
}

const PAGES = {
  terms: { title: '이용약관', md: termsMarkdown },
  privacy: { title: '개인정보 처리방침', md: (L) => privacyMarkdown(L) },
};

export function legalPage(kind, { plans } = {}, L = LEGAL) {
  const p = PAGES[kind];
  const body = renderDoc(p.md(L, plans));
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${p.title} — RELAI</title><meta name="description" content="RELAI ${p.title}">
<!--SHARE_META-->
<link rel="stylesheet" as="style" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>${PAGE_CSS}</style></head>
<body><header class="top"><div class="top__in"><a class="logo" href="/">RELAI</a><nav class="top__nav"><a href="/terms"${kind === 'terms' ? ' aria-current="page"' : ''}>이용약관</a><a href="/privacy"${kind === 'privacy' ? ' aria-current="page"' : ''}>개인정보처리방침</a></nav></div></header>
<main class="doc"><h1>RELAI ${p.title}</h1><p class="doc__meta">시행일 ${koDate(kind === 'terms' ? (L.termsEffectiveDate || L.effectiveDate) : L.effectiveDate)} · 버전 ${esc(kind === 'terms' ? L.termsVersion : L.privacyVersion)}</p>
${body}</main>
${legalFooterHtml(L)}
</body></html>`;
}

/** Landing #pricing (pricing v3): the shared plan cards from the server catalogue + their CSS. No price is typed in index.html. */
export function landingPricingHtml(cat = catalogue(), { open = paymentsEnabled() && process.env.NICEPAY_RECURRING_ENABLED === 'true' } = {}) {
  const cta = (p) => (p.contact_sales
    ? '<a href="mailto:__CONTACT_EMAIL__?subject=RELAI%20Enterprise%20%EB%AC%B8%EC%9D%98" class="btn btn--secondary btn--block" data-loc="pricing_enterprise">도입 문의</a>'
    : p.key === 'FREE' ? '<a href="/signup" class="btn btn--secondary btn--block" data-auth="start" data-loc="pricing_free">무료로 시작하기</a>'
      : !open ? soonCta(p, '')
      : `<a href="/signup" class="btn ${p.key === 'PRO' ? 'btn--primary' : 'btn--secondary'} btn--block" data-auth="start" data-loc="pricing_${p.key.toLowerCase()}">무료로 시작하고 ${esc(p.label)} 선택</a>`);
  return `<style>${PRICING_CSS}</style>${pricingHtml(cat, { cta })}`;
}

/** Mounts /terms, /privacy, /pricing and the landing page (with the footer filled in). Call before express.static. */
export function mountLegal(app, { pub, plans, onLanding = null, landingPromo = null }) {
  const cache = {};
  const page = (kind) => (cache[kind] ||= legalPage(kind, { plans }));
  for (const kind of Object.keys(PAGES)) {
    app.get([`/${kind}`, `/${kind}.html`], (req, res) => { res.set('Cache-Control', 'public, max-age=300'); res.type('html').send(page(kind).replace('<!--SHARE_META-->', shareMeta(req, { title: `${PAGES[kind].title} — RELAI`, description: `RELAI ${PAGES[kind].title}`, path: `/${kind}` }) + ga4For(req))); });
  }
  app.get('/pricing', (req, res) => res.redirect(302, '/#pricing'));
  let landing = null;
  app.get(['/', '/index.html'], async (req, res) => {
    if (onLanding) await onLanding(req);
    landing ||= readFileSync(resolve(pub, 'index.html'), 'utf8').replace('<!--LEGAL_FOOTER-->', legalFooterHtml()).replace('<!--PRICING:landing-->', landingPricingHtml()).replaceAll('__CONTACT_EMAIL__', esc(LEGAL.contactEmail));
    const promo = landingPromo ? await landingPromo() : '';   // 관리자 › 프로모션 (placement landing), rendered per request
    res.type('html').send(landing.replace('<!--SHARE_META-->', shareMeta(req) + ga4For(req)).replace('<!--PROMO:landing-->', promo));
  });
}

/* ---------- signup consent (B9) ---------- */
const yes = (v) => v === true || v === 'true' || v === 'on' || v === '1' || v === 1;
/** { termsVersion, privacyVersion } when both required consents are given, else null. Versions come from the server, never the body. */
export function consentFromBody(body, L = LEGAL) {
  return yes(body?.agree_terms) && yes(body?.agree_privacy) ? { termsVersion: L.termsVersion, privacyVersion: L.privacyVersion } : null;
}
export const CONSENT_ERROR = {
  message: '이용약관과 개인정보 수집·이용에 동의해 주세요.',
  fields: (body) => ({ ...(yes(body?.agree_terms) ? {} : { agree_terms: '이용약관에 동의해 주세요.' }), ...(yes(body?.agree_privacy) ? {} : { agree_privacy: '개인정보 수집·이용에 동의해 주세요.' }) }),
};
export const currentConsent = (L = LEGAL) => ({ termsVersion: L.termsVersion, privacyVersion: L.privacyVersion });
