// Renders the share/brand images in public/brand/ from HTML (run after changing the copy or the logo):
//   og-image.png 1200×630 (Open Graph / Twitter card, logo-white.svg), apple-touch-icon.png 180×180, icon-192.png, favicon-32.png.
// Needs Playwright with chromium:  node scripts/brand-assets.cjs
const fs = require('fs'); const path = require('path'); const { chromium } = require('playwright');
const OUT = path.join(__dirname, '../public/brand');
const font = `@font-face{font-family:NG;font-weight:400;src:url('file://${path.join(__dirname, '../server/fonts/NanumGothic-Regular.ttf')}')}
@font-face{font-family:NG;font-weight:800;src:url('file://${path.join(__dirname, '../server/fonts/NanumGothic-Bold.ttf')}')}`;
const svg = fs.readFileSync(path.join(OUT, 'icon.svg'), 'utf8');          // favicon (bolder strokes, reads at 16–32px)
const appSvg = fs.readFileSync(path.join(OUT, 'icon-app.svg'), 'utf8');   // app / touch icons
const logoWhite = fs.readFileSync(path.join(OUT, 'logo-white.svg'), 'utf8');   // R mark + RELAi wordmark for dark backgrounds
const PHASES = ['착수', '요구사항 정의', '분석·설계', '구현', '시험', '전환 및 오픈', '운영 및 유지보수'];
const og = `<!doctype html><meta charset="utf-8"><style>${font}
*{box-sizing:border-box;margin:0}body{width:1200px;height:630px;overflow:hidden;font-family:NG,sans-serif;letter-spacing:-.02em;
background:radial-gradient(900px 500px at 85% 10%,#2E51C4 0,transparent 60%),linear-gradient(135deg,#0B1324 0,#101828 55%,#1D2939 100%);color:#fff;display:flex;padding:64px 72px;gap:48px}
.l{flex:1;display:flex;flex-direction:column}.brand{display:flex;align-items:center}.brand svg{height:50px;width:auto}
h1{font-size:54px;line-height:1.22;white-space:nowrap;font-weight:800;margin-top:56px;letter-spacing:-.04em}h1 em{font-style:normal;color:#9FB4F5}
p{margin-top:24px;font-size:24px;color:#C9D3E6;line-height:1.5}
.ph{margin-top:auto;display:flex;flex-wrap:wrap;gap:8px}.ph span{font-size:17px;font-weight:800;padding:7px 14px;border-radius:99px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);color:#DCE3F2}
.ph span.n{background:#2E51C4;border-color:#2E51C4;color:#fff}
.phone{width:300px;height:560px;margin-top:-6px;border-radius:40px;background:#0B1324;padding:10px;box-shadow:0 30px 80px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.12)}
.s{height:100%;border-radius:31px;background:#F6F8FB;color:#101828;overflow:hidden;font-size:14px}
.top{background:#fff;padding:22px 18px 10px;font-weight:800;font-size:16px}.strip{background:#fff;padding:0 18px 12px;border-bottom:1px solid #EEF2F7;font-size:13px;color:#475467;display:flex;gap:8px;align-items:center}
.chip{font-size:12px;font-weight:800;color:#243F9C;background:#F2F4FB;border-radius:99px;padding:2px 9px}
.b{padding:14px;display:grid;gap:12px}.card{background:#fff;border:1px solid #EEF2F7;border-radius:14px;padding:14px}.now{border-color:#C7D0EE;box-shadow:inset 4px 0 0 #2E51C4}
.k{font-size:12px;font-weight:800;color:#2E51C4}.t{font-size:18px;font-weight:800;margin:4px 0 5px;color:#101828}.m{font-size:12.5px;color:#475467}
.row{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid #EEF2F7;font-size:14px}.row:first-child{border-top:0}
.row i{width:18px;height:18px;border-radius:50%;border:2px solid #E4EAF2;flex:none}.row i.d{background:#16A36A;border-color:#16A36A}.row i.n{background:#2E51C4;border-color:#2E51C4;box-shadow:inset 0 0 0 3px #fff}
.row span{flex:1}.row em{font-style:normal;font-size:12px;color:#475467}.row em.n{color:#2E51C4;font-weight:800}
.kpi{display:grid;grid-template-columns:1fr 1fr;gap:8px}.kpi div{background:#fff;border:1px solid #EEF2F7;border-radius:12px;padding:10px 12px}.kpi small{display:block;font-size:11.5px;color:#475467}.kpi b{font-size:17px}.ok{color:#16A36A}
</style><body><div class="l"><div class="brand">${logoWhite}</div>
<h1>프로젝트 생애주기를 따라<br><em>지금 해야 할 일</em>을 안내합니다.</h1>
<p>요구사항 · 일정 · 테스트 · 주간보고를 한 흐름으로.<br>PM 경험이 없어도 끝까지 갑니다.</p>
<div class="ph">${PHASES.map((p, i) => `<span class="${i === 2 ? 'n' : ''}">${String(i + 1).padStart(2, '0')} ${p}</span>`).join('')}</div></div>
<div class="phone"><div class="s"><div class="top">A사 상담 시스템 구축</div><div class="strip">03 / 07 · 분석·설계 <span class="chip">진행 중</span></div>
<div class="b"><div class="card now"><div class="k">✦ 다음 할 일</div><div class="t">화면 설계를 확정하세요</div><div class="m">담당 김하늘 · 11/13까지</div></div>
<div class="card"><div class="row"><i class="d"></i><span>상세 요구사항 분석</span><em>완료</em></div><div class="row"><i class="n"></i><span>화면 설계</span><em class="n">진행 중</em></div><div class="row"><i></i><span>DB 설계</span><em>11/27</em></div></div>
<div class="kpi"><div><small>일정</small><b class="ok">정상</b></div><div><small>요구사항 확정</small><b>16/18</b></div></div></div></div></div></body>`;
const icon = (px) => `<!doctype html><style>*{margin:0}body{width:${px}px;height:${px}px}svg{width:${px}px;height:${px}px;display:block}</style><body>${px >= 180 ? appSvg.replace('rx="150"', 'rx="0"') : svg}</body>`;
(async () => {
  const b = await chromium.launch();
  const shot = async (html, w, h, file) => { const p = await b.newPage({ viewport: { width: w, height: h } }); await p.setContent(html, { waitUntil: 'load' }); await p.evaluate(() => document.fonts.ready); await p.screenshot({ path: path.join(OUT, file) }); await p.close(); console.log(file); };
  await shot(og, 1200, 630, 'og-image.png');
  await shot(icon(180), 180, 180, 'apple-touch-icon.png');
  await shot(icon(192), 192, 192, 'icon-192.png');
  await shot(icon(32), 32, 32, 'favicon-32.png');
  await b.close();
})();
