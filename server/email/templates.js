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
