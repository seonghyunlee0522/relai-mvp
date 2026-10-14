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
  const subject = `[RELAI] ${workspaceName} Workspace 생성 초대`;
  const until = new Date(expiresAt).toLocaleDateString('ko-KR');
  const html = shell('RELAI 사용을 시작하도록 초대되었습니다', `<p>${inviteeName ? `${esc(inviteeName)}님, ` : ''}<b>${esc(workspaceName)}</b> Workspace를 RELAI에서 생성하고 프로젝트 관리를 시작하세요.</p>
    <p>아래 버튼을 눌러 Google 계정 또는 이메일로 가입하면 <b>${esc(workspaceName)}</b> Workspace가 만들어지고 회원님이 OWNER가 됩니다.</p>${button(link, '초대 확인하고 시작하기')}<p style="font-size:13px;color:#667085">이 초대는 ${until}까지 유효하며, 초대받은 이메일 계정으로만 수락할 수 있습니다.</p>`, support);
  const text = `RELAI 사용을 시작하도록 초대되었습니다.\n\nWorkspace: ${workspaceName}\n\n아래 링크에서 가입 또는 로그인 후 초대를 수락하세요 (${until}까지 유효):\n${link}\n`;
  return { subject, html, text };
}
export function memberInviteEmail({ workspaceName, inviterName, roleLabel, link, expiresAt, support }) {
  const subject = `[RELAI] ${workspaceName} Workspace에 초대되었습니다`;
  const until = new Date(expiresAt).toLocaleDateString('ko-KR');
  const html = shell(`${workspaceName} Workspace에 초대되었습니다`, `<p><b>${esc(inviterName || 'Workspace 관리자')}</b>님이 <b>${esc(workspaceName)}</b> Workspace에 초대했습니다.</p>
    <p>역할: <b>${esc(roleLabel)}</b></p>${button(link, '초대 확인')}<p style="font-size:13px;color:#667085">이 초대는 ${until}까지 유효하며, 초대받은 이메일 계정으로 가입하거나 로그인해야 수락할 수 있습니다.</p>`, support);
  const text = `${inviterName || 'Workspace 관리자'}님이 ${workspaceName} Workspace에 초대했습니다.\n역할: ${roleLabel}\n\n초대 확인 (${until}까지 유효):\n${link}\n`;
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
  const html = shell('Team 플랜 이용 기간이 곧 끝납니다', `<p><b>${esc(workspaceName)}</b> Workspace의 Team 플랜${seats ? `(사용자 ${esc(seats)}명)` : ''} 이용 기간이 <b>${esc(until)}</b>에 끝납니다.</p>
    <p>자동 결제되지 않는 상품이라 연장하지 않으면 기간 종료 후 Free 플랜 한도가 적용됩니다. 데이터는 삭제되지 않으며 새 항목 추가만 제한됩니다.</p>${link ? button(link, '이용 기간 연장하기') : ''}
    <p style="font-size:13px;color:#667085">연장은 Workspace OWNER가 설정 › 플랜 · 결제에서 할 수 있습니다. 남은 기간은 그대로 이어집니다.</p>`, support);
  const text = `${workspaceName} Workspace의 Team 플랜 이용 기간이 ${until}에 끝납니다.\n연장하지 않으면 기간 종료 후 Free 플랜 한도가 적용됩니다(데이터는 유지).\n${link ? `\n연장하기: ${link}\n` : ''}`;
  return { subject, html, text };
}
