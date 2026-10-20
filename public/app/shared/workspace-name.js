/** Workspace name as shown in a sentence: '홍길동님의 워크스페이스' stays as is, 'Hanbit Workspace' → 'Hanbit 워크스페이스',
 *  '한빛' → '한빛 워크스페이스'. Never '… 워크스페이스 워크스페이스' (Jim prod 10-21 P2 #1). Same rule as the server's invite-mail wsLabel (email templates). */
export const wsLabel = (name) => {
  const v = String(name || '').trim().replace(/ ?Workspace$/i, ' 워크스페이스').trim();
  return /워크스페이스$/.test(v) ? v : `${v} 워크스페이스`;
};
