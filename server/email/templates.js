/** E-mail bodies (HTML + text). Plain, brand-light, no tracking. Invite links are absolute (APP_BASE_URL). */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shell = (title, inner, support) => `<!doctype html><html lang="ko"><body style="margin:0;background:#F4F6FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:#101828">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border:1px solid #E4E8EF;border-radius:12px" cellspacing="0" cellpadding="0">
<tr><td style="padding:28px 32px 8px;font-size:18px;font-weight:800;letter-spacing:-.02em;color:#1B4FD8">RELAI</td></tr>
<tr><td style="padding:4px 32px 24px;font-size:15px;line-height:1.6"><h1 style="margin:0 0 12px;font-size:20px;letter-spacing:-.02em">${esc(title)}</h1>${inner}</td></tr>
<tr><td style="padding:16px 32px 24px;border-top:1px solid #EEF1F6;font-size:12px;color:#667085;line-height:1.5">이 메일은 RELAI에서 발송되었습니다. 본인이 요청하지 않았다면 무시하셔도 됩니다.${support ? ` 문의: ${esc(support)}` : ''}</td></tr>
</table></td></tr></table></body></html>`;
const button = (href, label) => `<p style="margin:20px 0"><a href="${esc(href)}" style="display:inline-block;background:#1B4FD8;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">${esc(label)}</a></p><p style="font-size:12px;color:#667085;word-break:break-all">버튼이 열리지 않으면 링크를 복사해 브라우저에 붙여넣으세요:<br>${esc(href)}</p>`;

export function platformInviteEmail({ workspaceName, inviteeName, link, expiresAt, support }) {
  const subject = `[RELAI] ${workspaceName} 워크스페이스 생성 초대`;
  const until = new Date(expiresAt).toLocaleDateString('ko-KR');
  const html = shell('RELAI 사용을 시작하도록 초대되었습니다', `<p>${inviteeName ? `${esc(inviteeName)}님, ` : ''}<b>${esc(workspaceName)}</b> 워크스페이스를 RELAI에서 생성하고 프로젝트 관리를 시작하세요.</p>
    <p>아래 버튼을 눌러 Google 계정 또는 이메일로 가입하면 <b>${esc(workspaceName)}</b> 워크스페이스가 만들어지고 회원님이 소유자가 됩니다.</p>${button(link, '초대 확인하고 시작하기')}<p style="font-size:13px;color:#667085">이 초대는 ${until}까지 유효하며, 초대받은 이메일 계정으로만 수락할 수 있습니다.</p>`, support);
  const text = `RELAI 사용을 시작하도록 초대되었습니다.\n\n워크스페이스: ${workspaceName}\n\n아래 링크에서 가입 또는 로그인 후 초대를 수락하세요 (${until}까지 유효):\n${link}\n`;
  return { subject, html, text };
}
export function memberInviteEmail({ workspaceName, inviterName, roleLabel, link, expiresAt, support }) {
  const subject = `[RELAI] ${workspaceName} 워크스페이스에 초대되었습니다`;
  const until = new Date(expiresAt).toLocaleDateString('ko-KR');
  const html = shell(`${workspaceName} 워크스페이스에 초대되었습니다`, `<p><b>${esc(inviterName || '워크스페이스 관리자')}</b>님이 <b>${esc(workspaceName)}</b> 워크스페이스에 초대했습니다.</p>
    <p>역할: <b>${esc(roleLabel)}</b></p>${button(link, '초대 확인')}<p style="font-size:13px;color:#667085">이 초대는 ${until}까지 유효하며, 초대받은 이메일 계정으로 가입하거나 로그인해야 수락할 수 있습니다.</p>`, support);
  const text = `${inviterName || '워크스페이스 관리자'}님이 ${workspaceName} 워크스페이스에 초대했습니다.\n역할: ${roleLabel}\n\n초대 확인 (${until}까지 유효):\n${link}\n`;
  return { subject, html, text };
}
export function passwordResetEmail({ link, minutes, support }) {
  const subject = '[RELAI] 비밀번호 재설정';
  const html = shell('비밀번호 재설정', `<p>RELAI 계정의 비밀번호 재설정이 요청되었습니다. 아래 버튼을 눌러 새 비밀번호를 설정하세요.</p>${button(link, '새 비밀번호 설정')}
    <p style="font-size:13px;color:#667085">이 링크는 ${minutes}분 동안 한 번만 사용할 수 있습니다. 비밀번호를 바꾸면 모든 기기에서 로그아웃됩니다. 본인이 요청하지 않았다면 이 메일을 무시하세요 — 비밀번호는 바뀌지 않습니다.</p>`, support);
  const text = `RELAI 비밀번호 재설정\n\n아래 링크에서 새 비밀번호를 설정하세요 (${minutes}분 동안 한 번만 사용 가능):\n${link}\n\n본인이 요청하지 않았다면 이 메일을 무시하세요.\n`;
  return { subject, html, text };
}
export function verifyEmailEmail({ name, link, hours, support }) {
  const subject = '[RELAI] 이메일 주소를 인증해 주세요';
  const html = shell('이메일 주소 인증', `<p>${name ? `${esc(name)}님, ` : ''}RELAI 가입을 환영합니다. 아래 버튼을 눌러 이메일 주소를 인증해 주세요.</p>${button(link, '이메일 인증하기')}
    <p style="font-size:13px;color:#667085">인증 전에는 팀원 초대와 결제를 할 수 없습니다. 이 링크는 ${hours}시간 동안 유효합니다.</p>`, support);
  const text = `RELAI 이메일 주소 인증\n\n아래 링크에서 이메일 주소를 인증해 주세요 (${hours}시간 동안 유효):\n${link}\n\n인증 전에는 팀원 초대와 결제를 할 수 없습니다.\n`;
  return { subject, html, text };
}
/** One-time (일반결제) Team purchases do not renew: sent to OWNERs 7 days before current_period_end. */
export function renewalReminderEmail({ workspaceName, periodEnd, seats, link, support }) {
  const until = new Date(periodEnd).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
  const subject = `[RELAI] ${workspaceName} Team 플랜 이용 기간이 ${until}에 끝납니다`;
  const html = shell('Team 플랜 이용 기간이 곧 끝납니다', `<p><b>${esc(workspaceName)}</b> 워크스페이스의 Team 플랜${seats ? `(사용자 ${esc(seats)}명)` : ''} 이용 기간이 <b>${esc(until)}</b>에 끝납니다.</p>
    <p>자동 결제되지 않는 상품이라 연장하지 않으면 기간 종료 후 Free 플랜 한도가 적용됩니다. 데이터는 삭제되지 않으며 새 항목 추가만 제한됩니다.</p>${link ? button(link, '이용 기간 연장하기') : ''}
    <p style="font-size:13px;color:#667085">연장은 워크스페이스 소유자가 설정 › 플랜 · 결제에서 할 수 있습니다. 남은 기간은 그대로 이어집니다.</p>`, support);
  const text = `${workspaceName} 워크스페이스의 Team 플랜 이용 기간이 ${until}에 끝납니다.\n연장하지 않으면 기간 종료 후 Free 플랜 한도가 적용됩니다(데이터는 유지).\n${link ? `\n연장하기: ${link}\n` : ''}`;
  return { subject, html, text };
}

/* ---------- AI-credits-only billing ---------- */
const krw = (n) => `₩${Number(n).toLocaleString('ko-KR')}`;
const credits = (n) => `${Number(n).toLocaleString('ko-KR')} 크레딧`;

export function lowBalanceEmail({ workspaceName, balance, threshold, link, support }) {
  const subject = `[RELAI] ${workspaceName} AI 크레딧 잔액이 ${credits(threshold)} 아래로 내려갔습니다`;
  const html = shell('AI 크레딧 잔액이 얼마 남지 않았습니다', `<p><b>${esc(workspaceName)}</b> 워크스페이스의 AI 크레딧 잔액이 <b>${esc(credits(balance))} (${esc(krw(balance * 10))})</b>입니다.</p>
    <p>잔액이 0이 되면 AI 기능(요구사항 추출, WBS 초안, 영향 분석, 질문)을 쓸 수 없습니다. 다른 기능은 그대로 쓸 수 있습니다.</p>${link ? button(link, '크레딧 충전하기') : ''}
    <p style="font-size:13px;color:#667085">충전은 워크스페이스 소유자가 설정 › AI 크레딧에서 할 수 있습니다. 이 안내는 충전 후 다시 ${esc(credits(threshold))} 아래로 내려갈 때만 다시 보내 드립니다.</p>`, support);
  const text = `${workspaceName} 워크스페이스의 AI 크레딧 잔액이 ${credits(balance)} (${krw(balance * 10)})입니다.\n잔액이 0이 되면 AI 기능을 쓸 수 없습니다.\n${link ? `\n충전하기: ${link}\n` : ''}`;
  return { subject, html, text };
}

export function creditRefundRequestEmail({ workspaceName, workspaceId, requester, refundable, note }) {
  const subject = `[RELAI] AI 크레딧 환불 요청 — ${workspaceName}`;
  const html = shell('AI 크레딧 환불 요청', `<p>워크스페이스 <b>${esc(workspaceName)}</b> (${esc(workspaceId)})</p><p>요청자: ${esc(requester)}</p>
    <p>환불 가능한 미사용 구매 크레딧: <b>${esc(credits(refundable))}</b></p>${note ? `<p>메모: ${esc(note)}</p>` : ''}
    <p style="font-size:13px;color:#667085">관리자 콘솔 › 워크스페이스 › AI 크레딧 환불에서 처리합니다.</p>`, '');
  const text = `워크스페이스 ${workspaceName} (${workspaceId})\n요청자: ${requester}\n환불 가능: ${credits(refundable)}\n${note ? `메모: ${note}\n` : ''}`;
  return { subject, html, text };
}

/* ---------- pricing v3 subscription lifecycle (T3) ---------- */
const wonKr = (n) => `${Number(n || 0).toLocaleString('ko-KR')}원`;
const kDate = (d) => new Date(d).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });

/** A renewal charge was declined. `attempt` of `max`; `final` = no more automatic attempts. */
export function paymentFailedEmail({ workspaceName, planLabel, amount, attempt, max, nextAttemptAt, graceEnd, final, link, support }) {
  const subject = `[RELAI] ${workspaceName} ${planLabel} 플랜 자동 결제에 실패했습니다`;
  const next = final ? `더 이상 자동으로 결제를 시도하지 않습니다. ${graceEnd ? `${kDate(graceEnd)}까지` : '유예 기간 동안'} 결제 수단을 바꿔 다시 구독하지 않으면 Free 플랜 한도가 적용됩니다.`
    : `${nextAttemptAt ? `${kDate(nextAttemptAt)}에` : '곧'} 다시 결제를 시도합니다(${attempt}/${max + 1}회째 실패). 그동안 플랜은 그대로 이용할 수 있습니다.`;
  const html = shell('자동 결제에 실패했습니다', `<p><b>${esc(workspaceName)}</b> 워크스페이스의 ${esc(planLabel)} 플랜 갱신 결제 <b>${esc(wonKr(amount))}</b>(VAT 포함)가 승인되지 않았습니다.</p>
    <p>${esc(next)}</p><p>데이터는 삭제되지 않습니다.</p>${link ? button(link, '결제 정보 확인하기') : ''}`, support);
  const text = `${workspaceName} 워크스페이스의 ${planLabel} 플랜 갱신 결제 ${wonKr(amount)}(VAT 포함)가 승인되지 않았습니다.\n${next}\n${link ? `\n확인하기: ${link}\n` : ''}`;
  return { subject, html, text };
}

/** 증액 사전 고지 (전자상거래법 §13⑥): the renewal amount rises; the owner must consent or auto-renewal stops. */
export function priceIncreaseEmail({ workspaceName, planLabel, oldAmount, newAmount, effectiveAt, link, support }) {
  const subject = `[RELAI] ${workspaceName} ${planLabel} 플랜 갱신 금액 변경 안내 — 동의가 필요합니다`;
  const html = shell('갱신 금액 변경 안내', `<p><b>${esc(workspaceName)}</b> 워크스페이스의 ${esc(planLabel)} 플랜 다음 갱신(<b>${esc(kDate(effectiveAt))}</b>) 금액이 <b>${esc(wonKr(oldAmount))} → ${esc(wonKr(newAmount))}</b>(VAT 포함)로 바뀝니다.</p>
    <p>설정 › 플랜 · 결제에서 동의하면 바뀐 금액으로 갱신됩니다. 동의하지 않으면 추가 결제 없이 자동 갱신이 중단되고, 이미 결제한 기간이 끝날 때까지 이용합니다. 언제든 해지할 수 있습니다.</p>${link ? button(link, '변경 내용 확인하기') : ''}`, support);
  const text = `${workspaceName} 워크스페이스의 ${planLabel} 플랜 다음 갱신(${kDate(effectiveAt)}) 금액이 ${wonKr(oldAmount)} → ${wonKr(newAmount)}(VAT 포함)로 바뀝니다.\n동의하지 않으면 자동 갱신이 중단됩니다(추가 결제 없음).\n${link ? `\n확인하기: ${link}\n` : ''}`;
  return { subject, html, text };
}

/** The renewal was not charged because the higher amount was not consented: auto-renewal stopped. */
export function renewalBlockedEmail({ workspaceName, planLabel, amount, agreed, periodEnd, link, support }) {
  const subject = `[RELAI] ${workspaceName} ${planLabel} 플랜 자동 갱신이 중단되었습니다`;
  const html = shell('자동 갱신이 중단되었습니다', `<p><b>${esc(workspaceName)}</b> 워크스페이스의 다음 갱신 금액 ${esc(wonKr(amount))}이(가) 동의한 금액 ${esc(wonKr(agreed))}보다 커서 결제하지 않았습니다.</p>
    <p>자동 갱신을 중단했습니다. ${periodEnd ? `${esc(kDate(periodEnd))}까지` : '결제한 기간이 끝날 때까지'} 지금 플랜을 이용하고, 이후 Free 플랜이 됩니다. 계속 이용하려면 새 금액을 확인하고 다시 구독해 주세요.</p>${link ? button(link, '플랜 · 결제 열기') : ''}`, support);
  const text = `${workspaceName} 워크스페이스의 다음 갱신 금액 ${wonKr(amount)}이(가) 동의한 금액 ${wonKr(agreed)}보다 커서 결제하지 않았고 자동 갱신을 중단했습니다.\n${link ? `\n열기: ${link}\n` : ''}`;
  return { subject, html, text };
}

/* 구독 해지 · Free 전환 정책 (founder 2026-10-21): shared by the cancel mail, the Free-transition mail and the Billing screen copy. */
export const FREE_POLICY = '구독이 끝나 Free 플랜이 되면 생성일이 가장 최근인 프로젝트 1개만 계속 편집할 수 있고, 나머지 프로젝트는 자동으로 조회 전용이 됩니다(편집할 프로젝트는 선택할 수 없습니다).';
export const FREE_KEEP = '해지만으로 프로젝트 데이터는 삭제되지 않으며 모든 프로젝트를 계속 조회·내보내기할 수 있습니다. 다시 구독하거나 플랜을 올리면 요금제 한도만큼 최근 프로젝트부터 편집 권한이 돌아옵니다. 워크스페이스 삭제는 해지와 별도로 설정에서 따로 진행합니다.';

/** Free 전환 안내: the plan ended (period end / grace over) → which project stays editable, which became read-only. */
export function freeTransitionEmail({ workspaceName, planLabel, limit = 1, editable = [], readOnly = [], link, support }) {
  const subject = `[RELAI] ${workspaceName} 워크스페이스가 Free 플랜으로 전환되었습니다`;
  const names = (list) => list.slice(0, 10).map((p) => p.name).join(', ') + (list.length > 10 ? ` 외 ${list.length - 10}개` : '');
  const lines = [
    editable.length ? `계속 편집할 수 있는 프로젝트 (최근 생성 ${limit}개): ${names(editable)}` : '',
    readOnly.length ? `조회 전용으로 바뀐 프로젝트 ${readOnly.length}개: ${names(readOnly)}` : '',
  ].filter(Boolean);
  const html = shell('Free 플랜으로 전환되었습니다', `<p><b>${esc(workspaceName)}</b> 워크스페이스의 ${esc(planLabel)} 플랜 이용 기간이 끝나 Free 플랜으로 전환되었습니다.</p>
    <p>${esc(FREE_POLICY)}</p>${lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}<p>${esc(FREE_KEEP)}</p>${link ? button(link, '플랜 · 결제 열기') : ''}`, support);
  const text = `${workspaceName} 워크스페이스의 ${planLabel} 플랜 이용 기간이 끝나 Free 플랜으로 전환되었습니다.\n${FREE_POLICY}\n${lines.map((l) => `- ${l}`).join('\n')}\n${FREE_KEEP}\n${link ? `\n열기: ${link}\n` : ''}`;
  return { subject, html, text };
}

/** 해지 확인 (§13② 계약 내용 고지): period-end cancel, or immediate cancel with the refund lines. */
export function cancelEmail({ workspaceName, planLabel, immediate, periodEnd, refundTotal = 0, refundLines = [], executed, retentionUntil, link, support }) {
  const subject = `[RELAI] ${workspaceName} ${planLabel} 플랜 해지 안내`;
  const what = immediate
    ? `구독을 해지해 지금 Free 플랜이 되었습니다. ${refundTotal > 0 ? `미사용 기간 환불 ${wonKr(refundTotal)}을(를) ${executed ? '결제한 카드로 취소 처리했습니다' : '3영업일 안에 결제한 카드로 취소해 드립니다'}(위약금 없음).` : '환불할 미사용 기간이 없습니다.'}`
    : `자동 갱신을 중단했습니다. ${periodEnd ? `${kDate(periodEnd)}까지` : '결제한 기간이 끝날 때까지'} 지금 플랜을 이용하고, 이후 Free 플랜이 됩니다. 더 이상 결제되지 않습니다.`;
  const lines = refundLines.map((l) => `<li>${esc(l.label || '결제')}: ${esc(wonKr(l.amount))} (미사용 ${esc(l.days)}/${esc(l.period_days)}일${l.kind === 'WITHDRAWAL' ? ', 청약철회' : ''})</li>`).join('');
  void retentionUntil;   // TODO(retention-legal, research/relai-retention-legal.md): personal-data retention periods are set after the legal review — never here
  const keep = `${FREE_POLICY} ${FREE_KEEP}`;
  const html = shell('구독 해지 안내', `<p><b>${esc(workspaceName)}</b> 워크스페이스의 ${esc(planLabel)} 플랜: ${esc(what)}</p>${lines ? `<ul>${lines}</ul>` : ''}<p>${esc(keep)}</p>${link ? button(link, '플랜 · 결제 열기') : ''}`, support);
  const text = `${workspaceName} 워크스페이스의 ${planLabel} 플랜: ${what}\n${refundLines.map((l) => `- ${l.label || '결제'}: ${wonKr(l.amount)} (미사용 ${l.days}/${l.period_days}일)`).join('\n')}\n${keep}\n${link ? `\n열기: ${link}\n` : ''}`;
  return { subject, html, text };
}
