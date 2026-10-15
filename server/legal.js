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
import { CREDIT_PRICE_KRW, CREDIT_PACKS, REFUND_FULL_DAYS, REFUND_FEE_PCT, PURCHASED_VALID_YEARS, EARLY_ACCESS } from './plans.js';
import { aiConfig } from './ai/config.js';

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
    if ((m = /^(#{1,3}) (.*)$/.exec(l))) { const lv = m[1].length + 0; out.push(lv === 2 ? `<h2 id="s${++n}">${inline(m[2])}</h2>` : `<h${lv}>${inline(m[2])}</h${lv}>`); i++; continue; }
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

const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;

/** 이용약관. Prices follow server/plans.js (pricing v2 + AI-credits-only billing: early access, starter credits, credit packs). */
export function termsMarkdown(L = LEGAL, plans) {
  const T = plans?.TEAM || { base_monthly: 20000, included_users: 1, extra_user_monthly: 5000 };
  const F = plans?.FREE?.limits || { projects: 1, members: 3, requirements: 50, wbs: 100, weekly_reports: 8 };
  const starter = aiConfig().trialCredits;
  const packs = CREDIT_PACKS.map((p) => `${won(p.amount)}(${p.credits.toLocaleString('ko-KR')} 크레딧)`).join(', ');
  return `## 제1장 총칙

### 제1조 (목적)
이 약관은 ${L.company}(이하 "회사")이 제공하는 프로젝트 가이드 서비스 RELAI 및 관련 제반 서비스(이하 "서비스")의 이용과 관련하여 회사와 이용자의 권리, 의무, 책임사항 및 기타 필요한 사항을 정합니다.

### 제2조 (용어의 정의)
1. "이용자"란 이 약관에 따라 회사가 제공하는 서비스를 이용하는 회원을 말합니다.
2. "회원"이란 이 약관에 동의하고 계정을 생성한 자를 말합니다.
3. "워크스페이스"란 회원이 서비스 안에서 프로젝트와 데이터를 관리하는 단위 공간을 말하며, 워크스페이스를 만든 회원 또는 그로부터 소유자 권한을 받은 회원을 "소유자(OWNER)"라 합니다.
4. "고객"이란 유료 요금제를 신청하고 이용요금을 결제하는 워크스페이스의 소유자 또는 그가 대표하는 법인·단체를 말합니다.
5. "사용자 수"란 유료 요금제에서 워크스페이스에 소속되어 서비스를 이용할 수 있는 회원의 수(소유자 포함)를 말합니다.
6. "고객 데이터"란 이용자가 서비스에 입력하거나 업로드한 프로젝트 정보, 요구사항, WBS, 테스트, 변경 요청, 이슈·리스크, 주간보고, 첨부·가져오기 파일 등 일체의 정보를 말합니다.
7. "정기결제"란 고객이 등록한 결제수단으로 이용기간마다 이용요금이 자동으로 청구·결제되는 방식을 말합니다.
8. "크레딧"이란 AI 기능 이용 시 차감되는 서비스 내 이용 단위를 말하며, 1 크레딧은 ${won(CREDIT_PRICE_KRW)}(부가가치세 포함)에 해당합니다. 회사가 무상으로 지급한 크레딧을 "무료 크레딧", 고객이 결제하여 충전한 크레딧을 "구매 크레딧"이라 합니다.
9. "얼리 액세스"란 회사가 정한 기간 동안 워크스페이스에 요금 없이 Team 요금제와 같은 한도를 제공하는 프로모션을 말합니다.

### 제3조 (약관의 게시와 개정)
1. 회사는 이 약관의 내용과 상호, 대표자 성명, 영업소 소재지 주소, 사업자등록번호, 통신판매업 신고번호, 연락처 등을 이용자가 쉽게 알 수 있도록 서비스 초기 화면 또는 연결 화면에 게시합니다.
2. 회사는 「약관의 규제에 관한 법률」, 「전자상거래 등에서의 소비자보호에 관한 법률」(이하 "전자상거래법"), 「정보통신망 이용촉진 및 정보보호 등에 관한 법률」 등 관련 법령을 위반하지 않는 범위에서 이 약관을 개정할 수 있습니다.
3. 회사가 약관을 개정하는 경우 적용일자와 개정 사유를 명시하여 적용일자 7일 전부터 공지합니다. 다만 이용자에게 불리하거나 중대한 변경(요금 인상 포함)은 30일 전부터 공지하고, 등록된 이메일로 개별 통지합니다.
4. 이용자가 개정 약관의 적용일까지 거부 의사를 표시하지 않고 서비스를 계속 이용하면 개정 약관에 동의한 것으로 봅니다. 이 경우 회사는 제3항의 공지·통지 시 이 효과를 분명히 알립니다. 동의하지 않는 이용자는 이용계약을 해지할 수 있습니다.

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
2. 워크스페이스 소유자와 관리자(ADMIN)는 구성원 초대, 권한 변경, 내보내기를 할 수 있으며, 워크스페이스 내 구성원의 이용에 대해 고객으로서 책임을 집니다.
3. 회원은 계정의 도용이나 무단 사용을 알게 된 경우 즉시 회사에 알려야 합니다.

## 제3장 요금제와 결제

### 제7조 (요금제)
1. 서비스의 요금제는 다음과 같습니다. 세부 기능과 한도는 [요금 안내](/#pricing)에 게시하며, 게시된 내용이 이 조항과 다를 경우 결제 시점에 게시된 내용을 따릅니다.

| 요금제 | 이용요금(부가가치세 별도) | 주요 한도 |
|---|---|---|
| 얼리 액세스 | 무료(${EARLY_ACCESS.months}개월, 제7조 제3항) | Team 요금제와 같음(프로젝트·멤버·요구사항·WBS·주간보고 무제한) |
| Free | 무료 | 워크스페이스당 진행 중 프로젝트 ${F.projects}개, 멤버 ${F.members}명, 요구사항 ${F.requirements}건, WBS ${F.wbs}건, 주간보고 월 ${F.weekly_reports}건 |
| Team | 워크스페이스당 월 ${won(T.base_monthly)}(소유자 ${T.included_users}명 포함) + 사용자 추가 1명당 월 ${won(T.extra_user_monthly)}. 1개월 또는 연간(12개월) 선결제 | 프로젝트·멤버·요구사항·WBS·주간보고 무제한(멤버는 구매한 사용자 수까지) |
| Enterprise | 별도 계약 | 별도 계약으로 정함 |

2. 요금제 이용요금에는 부가가치세가 포함되어 있지 않으며, 결제 시 부가가치세 10%가 더해집니다. 크레딧 충전 금액은 부가가치세를 포함한 금액입니다. 결제 금액은 결제 전에 화면에 표시됩니다.
3. 얼리 액세스: 회사가 정한 기간에 만든 워크스페이스는 만든 날(서비스 출시일 이전에 만든 워크스페이스는 출시일)부터 ${EARLY_ACCESS.months}개월 동안 요금 없이 Team 요금제와 같은 한도로 서비스를 이용할 수 있습니다. 얼리 액세스 기간에도 AI 기능은 제7조의2에 따라 크레딧을 차감합니다. 얼리 액세스가 끝나면 Team 요금제를 결제하지 않은 워크스페이스에는 Free 요금제의 한도가 적용되며, 한도를 초과하는 기존 데이터는 삭제되지 않고 새 항목 추가만 제한됩니다. 회사는 얼리 액세스 종료 30일 전과 7일 전에 소유자에게 이메일로 알립니다.
4. 회사는 그 밖의 프로모션을 제공할 수 있으며, 그 조건과 기간은 프로모션 안내에 따릅니다.

### 제7조의2 (AI 크레딧)
1. AI 기능(요구사항 추출, WBS 초안, 변경 영향 분석, 프로젝트 질의응답 등)은 실행할 때마다 기능별로 정해진 크레딧을 워크스페이스의 크레딧 잔액에서 차감합니다. 기능별 크레딧은 [요금 안내](/#pricing)와 서비스 화면(설정 › AI 크레딧)에 게시하며, 실행 전에 예상 크레딧과 금액을 화면에 표시합니다. 실패한 요청은 차감하지 않습니다.
2. 회사는 워크스페이스마다 무료 크레딧 ${starter.toLocaleString('ko-KR')} 크레딧(${won(starter * CREDIT_PRICE_KRW)} 상당)을 한 번 지급합니다.
3. 워크스페이스 소유자는 다음 상품으로 크레딧을 충전할 수 있습니다: ${packs}. 충전은 한 번 결제하는 방식이며 자동으로 결제되지 않습니다.
4. 크레딧은 무료 크레딧을 먼저 차감하고, 구매 크레딧은 먼저 충전한 것부터 차감합니다. 구매 크레딧의 유효기간은 충전일부터 ${PURCHASED_VALID_YEARS}년입니다.
5. 크레딧은 워크스페이스에 귀속되며, 현금으로 교환하거나 다른 워크스페이스·회원에게 양도할 수 없습니다. 구매 크레딧의 환불은 제12조와 제13조 제5항에 따릅니다.
6. 크레딧 잔액이 회사가 정한 기준 아래로 내려가면 회사는 소유자에게 이메일로 알리며, 크레딧 사용 내역은 워크스페이스 구성원 모두가 서비스 화면에서 확인할 수 있습니다.

### 제8조 (무료 요금제)
1. Free 요금제는 무료로 제공되며, 한도를 초과하는 기능은 유료 요금제로 전환해야 이용할 수 있습니다.
2. 회사는 Free 요금제의 기능과 한도를 변경할 수 있으며, 이 경우 30일 전에 공지합니다.
3. Free 요금제는 유료 서비스가 아니므로 제18조의 서비스 장애 보상 규정이 적용되지 않습니다.

### 제9조 (결제와 정기결제)
1. 유료 요금제의 이용요금과 크레딧 충전 금액은 결제대행사(나이스페이먼츠 주식회사, 이하 "NicePay")를 통해 신용카드 등 회사가 정한 수단으로 결제합니다. 회사는 카드번호 등 결제수단 정보를 저장하지 않으며, NicePay가 발급한 정기결제용 식별값(빌링키)만 암호화하여 보관합니다.
2. 고객은 이용기간(1개월 또는 12개월)을 한 번 결제하는 방식(이용기간이 끝나도 자동으로 연장·결제되지 않음)과 정기결제 중에서 선택할 수 있습니다.
3. 정기결제에 동의한 고객은 최초 결제일을 기준으로 이용기간마다 같은 날짜에 이용요금이 자동 결제됩니다. 해당 날짜가 없는 달에는 그 달의 말일에 결제됩니다.
4. 한 번 결제하는 방식의 고객에게는 이용기간 종료 7일 전에 연장 안내를 이메일로 보냅니다. 정기결제 금액이 늘어나는 경우 회사는 30일 전에 변경 내용과 해지 방법을 이메일로 알립니다.
5. 정기결제가 실패하면 회사는 고객에게 알리고 7일 동안 매일 다시 결제를 시도합니다. 이 기간에도 결제되지 않으면 워크스페이스에 Free 요금제의 한도가 적용되며, 한도를 초과하는 데이터는 삭제되지 않습니다.
6. 사용자 수를 늘리려면 설정 화면에서 추가 구매를 하며, 추가 결제 금액은 결제 전에 표시됩니다.
7. 회사는 세금계산서 발행을 요청한 사업자 고객에게 결제 금액에 대한 전자세금계산서를 발행합니다.

### 제10조 (요금 변경)
회사는 이용요금을 변경할 수 있으며, 인상 시에는 시행 30일 전에 공지하고 이메일로 개별 통지합니다. 변경된 요금은 통지 이후 처음 도래하는 결제일(연간 요금제는 다음 갱신일)부터 적용되며, 고객은 그 전에 해지할 수 있습니다.

### 제11조 (해지와 정기결제 중단)
1. 고객은 언제든지 설정 화면 또는 이메일(${L.contactEmail})로 정기결제를 해지할 수 있습니다.
2. 해지 시 이미 결제한 이용기간이 끝날 때까지 유료 기능을 이용할 수 있으며, 이후 Free 요금제로 전환됩니다.

### 제12조 (청약철회)
1. 회원이 전자상거래법상 소비자에 해당하는 경우, 유료 요금제 결제일 또는 크레딧 충전일로부터 7일 이내에 청약을 철회할 수 있으며, 회사는 결제 금액 전액을 환불합니다. 다만 이 기간에 유료 기능을 사용한 경우 전자상거래법 제17조 제2항에 따라 사용분에 해당하는 금액을 공제할 수 있으며, 회사는 결제 전에 이 사실을 고지합니다.
2. 고객이 사업자로서 업무 목적으로 서비스를 구매한 경우에는 제1항이 적용되지 않을 수 있으며, 이 경우 제13조의 환불 기준을 따릅니다.
3. 청약철회 요청이 접수되면 회사는 3영업일 이내에 결제 취소 또는 환불 절차를 진행합니다.

### 제13조 (환불)
1. 1개월 요금제: 해지 시 남은 기간에 대한 일할 환불은 하지 않으며, 이용기간 종료 시까지 이용할 수 있습니다.
2. 연간 요금제: 청약철회 기간이 지난 뒤 해지를 요청하면, 결제 금액에서 이미 이용한 개월 수에 같은 사용자 수의 1개월 요금(할인 전 정상가)을 곱한 금액과 위약금(잔여 금액의 10%)을 공제한 나머지를 환불합니다.
3. 회사의 귀책으로 서비스를 정상적으로 이용하지 못한 경우에는 제18조에 따라 보상하거나 해당 기간 요금을 환불합니다.
4. 환불은 원래의 결제수단으로 하며, 결제수단 사정으로 불가능한 경우 고객이 지정한 계좌로 송금합니다.
5. 구매 크레딧: 소유자는 설정 › AI 크레딧의 환불 요청 또는 이메일(${L.contactEmail})로 사용하지 않은 구매 크레딧의 환불을 요청할 수 있습니다. 충전일로부터 ${REFUND_FULL_DAYS}일 이내이고 그 충전분을 전혀 사용하지 않은 경우 결제 금액 전액을, 그 밖의 경우 사용하지 않은 구매 크레딧에 해당하는 금액(1 크레딧 = ${won(CREDIT_PRICE_KRW)})에서 수수료 ${REFUND_FEE_PCT}%를 공제한 금액을 환불합니다. 무료 크레딧과 이미 사용한 크레딧은 환불하지 않습니다. 회사는 요청을 확인한 후 결제한 카드의 부분 취소로 환불하며, 카드 취소 기간이 지난 경우 고객이 지정한 계좌로 송금합니다.

## 제4장 서비스 이용

### 제14조 (서비스의 제공과 변경)
1. 서비스는 연중무휴 24시간 제공을 원칙으로 합니다. 다만 시스템 점검, 증설, 장애, 외부 서비스(클라우드·결제·이메일 등)의 문제가 있는 경우 일시 중단될 수 있습니다.
2. 계획된 점검은 7일 전에 공지하며, 긴급 점검은 사후에 공지할 수 있습니다.
3. 회사는 운영상·기술상 필요에 따라 서비스의 기능을 추가·변경·중단할 수 있습니다. 유료 요금제의 핵심 기능을 중단하는 경우 30일 전에 공지하고, 고객이 이용을 원하지 않으면 남은 이용기간에 해당하는 요금을 환불합니다.
4. AI 기능의 결과물은 이용자가 입력한 데이터를 바탕으로 자동 생성되며 정확성을 보장하지 않습니다. 이용자는 AI 결과물을 검토한 후 사용해야 합니다.

### 제15조 (이용자의 의무)
이용자는 다음 행위를 해서는 안 됩니다.
1. 타인의 계정 도용, 허위 정보 등록
2. 서비스를 이용하여 법령 또는 제3자의 권리(저작권, 영업비밀, 개인정보 등)를 침해하는 행위
3. 서비스의 취약점 공격, 비정상적 대량 요청, 역설계 등 서비스 운영을 방해하는 행위
4. 회사의 사전 동의 없이 서비스를 재판매하거나 영리 목적으로 제3자에게 제공하는 행위
5. 개인정보를 정당한 권한 없이 입력하거나, 주민등록번호 등 고유식별정보, 민감정보를 서비스에 입력하는 행위

### 제16조 (고객 데이터)
1. 고객 데이터의 권리는 고객에게 있습니다. 회사는 서비스 제공, 장애 대응, 고객 요청 처리에 필요한 범위에서만 고객 데이터에 접근하며, 고객의 동의 없이 제3자에게 제공하지 않습니다.
2. 고객 데이터에 이해관계자 정보 등 개인정보가 포함되는 경우, 고객은 그 개인정보의 처리자로서 적법한 근거를 갖추어야 하며, 회사는 고객의 위탁을 받아 처리하는 수탁자의 지위에 있습니다. 세부사항은 [개인정보 처리방침](/privacy)과 고객이 요청하는 경우 체결하는 개인정보 처리위탁 계약에 따릅니다.
3. 고객은 언제든지 엑셀 내보내기 기능 등으로 고객 데이터를 내려받을 수 있습니다.
4. 워크스페이스가 삭제되면 회사는 30일 동안 데이터를 보관한 후 복구할 수 없도록 삭제합니다. 다만 법령에 따라 보관해야 하는 정보(결제 기록 등)는 해당 기간 동안 보관합니다.
5. 회사는 고객 데이터를 식별할 수 없도록 통계 처리한 정보를 서비스 개선에 이용할 수 있습니다. 회사는 고객 데이터를 AI 모델 학습에 이용하지 않습니다.

### 제17조 (이용제한)
회사는 이용자가 제15조를 위반하거나 서비스의 정상 운영을 방해한 경우 사전 통지 후 경고, 일시 정지, 이용계약 해지를 할 수 있습니다. 다만 긴급한 보안 위협이 있는 경우 먼저 조치하고 사후에 통지할 수 있습니다. 이용자는 이에 대해 이의를 신청할 수 있습니다.

## 제5장 책임과 분쟁

### 제18조 (서비스 장애 보상)
유료 요금제 고객이 회사의 귀책으로 연속 4시간 이상 서비스를 이용하지 못한 경우, 회사는 해당 장애 시간의 3배에 해당하는 이용기간을 무상으로 연장합니다. 장애 시간은 고객이 회사에 알리거나 회사가 인지한 때부터 계산합니다.

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
이 약관은 ${koDate(L.effectiveDate)}부터 시행합니다.
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
| 유료 결제·크레딧 충전 | 결제 승인 정보(결제일시, 금액, 주문번호, 거래 식별자, 영수증 주소), 크레딧 충전·환불 내역, 카드사명과 카드번호 끝 4자리, NicePay가 발급한 정기결제 식별값(빌링키, 암호화 저장). 정기결제 카드 등록 시 입력하는 카드번호·유효기간·생년월일(또는 사업자등록번호)·비밀번호 앞 2자리는 회사가 저장하지 않고 암호화하여 NicePay로만 전달합니다. 세금계산서 발행 요청 시: 상호, 사업자등록번호, 대표자명, 담당자 이메일 | 결제 화면, NicePay 결제창 |
| 외부 서비스 연동(선택) | Jira 계정 표시명, 계정 식별자, 사이트 주소, 접근 토큰(암호화 저장) | 연동 시 Atlassian으로부터 제공 |
| 자동 수집 | 로그인 기록(접속 일시, IP 주소, 브라우저 정보), 서비스 이용 기록(작업 이력, AI 기능 사용 기록: 기능, 실행한 회원, 프로젝트, 차감 크레딧), 세션 쿠키, 서버 접속 로그, 이메일 발송 기록 | 서비스 이용 과정 |
| 랜딩 페이지 광고 측정 | 쿠키, 광고 식별자, 방문 기록 | Google 광고 태그(gtag) |

**고객이 입력하는 데이터의 개인정보.** 고객은 프로젝트 정의(이해관계자의 이름, 조직, 부서, 역할), 요구사항, 이슈, 주간보고 등에 제3자의 개인정보를 입력할 수 있습니다. 이 정보에 대해서는 고객이 개인정보처리자이고, 회사는 고객의 위탁을 받아 처리하는 수탁자입니다(제5조 제3항). 회사는 주민등록번호 등 고유식별정보와 민감정보를 수집하지 않으며, 이용자는 이를 서비스에 입력해서는 안 됩니다.

## 제2조 (개인정보의 처리 목적)
1. 회원 관리: 가입 의사 확인, 본인 식별·인증, 계정 보안(부정 이용 방지, 비정상 로그인 차단), 회원 자격 유지·관리, 고지·통지
2. 서비스 제공: 워크스페이스와 프로젝트 기능 제공, 구성원 초대 이메일 발송, 주간보고 생성, AI 기능 제공, 외부 서비스 연동
3. 요금 결제와 정산: 유료 요금제 결제, 정기결제, 크레딧 충전·차감·잔액 알림과 사용 내역 제공, 환불, 세금계산서 발행
4. 고객 지원: 문의 처리, 분쟁 조정을 위한 기록 보존
5. 서비스 개선과 마케팅(랜딩 페이지 광고 측정): 광고 효과 측정, 이용 통계 분석(개인을 식별할 수 없는 형태)

## 제3조 (개인정보의 보유와 이용 기간)
1. 회사는 회원 탈퇴 시 또는 처리 목적이 달성된 때 지체 없이 개인정보를 파기합니다. 다만 다음의 경우에는 명시한 기간 동안 보관합니다.

| 근거 | 항목 | 기간 |
|---|---|---|
| 전자상거래법 | 계약 또는 청약철회 등에 관한 기록 | 5년 |
| 전자상거래법 | 대금결제와 재화 등의 공급에 관한 기록 | 5년 |
| 전자상거래법 | 소비자의 불만 또는 분쟁처리에 관한 기록 | 3년 |
| 국세기본법 | 세금계산서 등 거래에 관한 장부와 증빙 서류 | 5년 |
| 통신비밀보호법 | 로그인 기록(접속 일시, IP 주소) | 3개월 |

2. 회원이 탈퇴하면 이름·이메일·비밀번호와 로그인 수단은 즉시 삭제되며, 다른 워크스페이스에 남은 업무 기록에는 '탈퇴한 사용자'로만 표시됩니다. 관리자 조치 기록에서는 이름과 이메일을 지운 형태로 남습니다.
3. 워크스페이스가 삭제되면 그 워크스페이스의 데이터(초대 정보 포함)는 30일 동안 보관한 후 파기합니다(이용약관 제16조).

## 제4조 (개인정보의 제3자 제공)
회사는 정보주체의 동의, 법률의 특별한 규정 등 법 제17조와 제18조에 해당하는 경우에만 개인정보를 제3자에게 제공합니다. 현재 회사는 개인정보를 제3자에게 제공하지 않습니다.

## 제5조 (개인정보 처리의 위탁)
1. 회사는 원활한 서비스 제공을 위해 다음과 같이 개인정보 처리 업무를 위탁합니다.

| 수탁자 | 위탁 업무 |
|---|---|
| Vercel Inc. | 웹 애플리케이션 호스팅, 서버 접속 로그 처리 |
| Neon(Databricks, Inc.) | 데이터베이스 운영과 저장 |
| 나이스페이먼츠 주식회사 | 결제 처리, 정기결제(빌링키 발급·관리) |
| Resend(Plus Five Five, Inc.) | 서비스 이메일(가입 인증, 비밀번호 재설정, 초대, 결제·크레딧 안내) 발송 |
| Anthropic, PBC 또는 OpenAI, L.L.C.(AI 기능을 사용하는 경우, 회사가 이용하는 사업자) | AI 기능 처리(요구사항 추출, WBS 생성, 변경 영향 분석, 프로젝트 질의응답) |

2. 회사는 위탁계약 체결 시 법 제26조에 따라 위탁 업무 수행 목적 외 처리 금지, 기술적·관리적 보호조치, 재위탁 제한, 수탁자 관리·감독, 손해배상 등을 계약서 등 문서에 명시하고, 수탁자가 개인정보를 안전하게 처리하는지 감독합니다.
3. 고객이 서비스에 입력한 개인정보(제1조 하단)에 대해 회사는 고객의 수탁자로서 고객의 지시에 따라 서비스 제공 목적으로만 처리하며, 고객이 요청하면 개인정보 처리위탁 계약을 체결합니다.

## 제6조 (개인정보의 국외 이전)
회사는 서비스 제공을 위해 다음과 같이 개인정보를 국외로 이전(처리위탁·보관)합니다. 이는 법 제28조의8 제1항 제3호에 따라 정보주체와의 계약 이행을 위해 필요한 처리위탁·보관으로서, 이 처리방침에 공개하는 방법으로 알립니다.

| 이전받는 자(연락처) | 이전 국가 | 이전 일시와 방법 | 이전 항목 | 이용 목적과 보유 기간 |
|---|---|---|---|---|
| Vercel Inc. (privacy@vercel.com) | 싱가포르(서버 리전), 미국 | 서비스 이용 시 네트워크를 통해 수시 전송 | 제1조의 모든 항목(접속 기록 포함) | 호스팅. 회원 탈퇴 또는 위탁계약 종료 시까지 |
| Neon(Databricks, Inc.) (privacy@neon.tech) | ${L.dbLocation} | 서비스 이용 시 네트워크를 통해 수시 전송 | 제1조의 모든 항목과 고객 데이터 | 데이터 저장. 회원 탈퇴 또는 위탁계약 종료 시까지 |
| Resend(Plus Five Five, Inc.) (privacy@resend.com) | 미국 | 이메일 발송 시 네트워크를 통해 전송 | 수신자 이메일 주소, 이름, 이메일 본문 | 이메일 발송. Resend의 발송 기록 보관 정책에 따름 |
| Google LLC (support.google.com/policies) | 미국 | Google 로그인 시, 랜딩 페이지 방문 시 | 로그인 인증 정보, 쿠키와 방문 기록 | 로그인 인증, 광고 효과 측정. Google 정책에 따름 |
| Anthropic, PBC (privacy@anthropic.com) 또는 OpenAI, L.L.C. (privacy@openai.com) | 미국 | AI 기능 실행 시 네트워크를 통해 전송 | AI 기능 요청에 포함된 프로젝트 데이터(이해관계자 정보 등 개인정보가 포함될 수 있음) | AI 결과 생성. 제공사의 API 데이터 보관 정책에 따르며, 제공사는 이 데이터를 모델 학습에 이용하지 않습니다 |
| Atlassian(Jira 연동 시) | 미국 등 | 연동 동기화 시 | 연동된 프로젝트 데이터, Jira 계정 식별자 | 고객이 요청한 연동 제공. 연동 해제 시까지 |

정보주체는 국외 이전을 거부할 수 있습니다. 다만 호스팅·데이터 저장·이메일 발송을 위한 국외 이전은 서비스 제공에 필수이므로, 거부하는 경우 서비스를 이용할 수 없습니다. AI 기능, Google 로그인, Jira 연동은 선택 기능이며, 이용하지 않으면 해당 국외 이전은 발생하지 않습니다. 거부 방법: 개인정보 보호책임자 이메일(${L.contactEmail})로 요청.

## 제7조 (개인정보의 파기 절차와 방법)
1. 회사는 보유 기간이 끝나거나 처리 목적이 달성된 개인정보를 지체 없이(5일 이내) 파기합니다.
2. 전자적 파일 형태의 정보는 복구할 수 없는 방법으로 삭제하며, 종이 문서는 분쇄하거나 소각합니다.
3. 법령에 따라 보존하는 정보는 별도 데이터베이스로 옮기거나 저장 장소를 분리하여 보관합니다.

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
<link rel="stylesheet" as="style" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>${PAGE_CSS}</style></head>
<body><header class="top"><div class="top__in"><a class="logo" href="/">RELAI</a><nav class="top__nav"><a href="/terms"${kind === 'terms' ? ' aria-current="page"' : ''}>이용약관</a><a href="/privacy"${kind === 'privacy' ? ' aria-current="page"' : ''}>개인정보처리방침</a></nav></div></header>
<main class="doc"><h1>RELAI ${p.title}</h1><p class="doc__meta">시행일 ${koDate(L.effectiveDate)} · 버전 ${esc(kind === 'terms' ? L.termsVersion : L.privacyVersion)}</p>
${body}</main>
${legalFooterHtml(L)}
</body></html>`;
}

/** Mounts /terms, /privacy, /pricing and the landing page (with the footer filled in). Call before express.static. */
export function mountLegal(app, { pub, plans }) {
  const cache = {};
  const page = (kind) => (cache[kind] ||= legalPage(kind, { plans }));
  for (const kind of Object.keys(PAGES)) {
    app.get([`/${kind}`, `/${kind}.html`], (req, res) => { res.set('Cache-Control', 'public, max-age=300'); res.type('html').send(page(kind)); });
  }
  app.get('/pricing', (req, res) => res.redirect(302, '/#pricing'));
  let landing = null;
  app.get(['/', '/index.html'], (req, res) => {
    landing ||= readFileSync(resolve(pub, 'index.html'), 'utf8').replace('<!--LEGAL_FOOTER-->', legalFooterHtml()).replaceAll('__CONTACT_EMAIL__', esc(LEGAL.contactEmail));
    res.type('html').send(landing);
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
