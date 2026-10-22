// wide-b1: measure + screenshot the list/detail-panel split at several widths on relai.kr (QA account, read-only).
// node scripts/e2e-wide-b1.cjs <before|after> [widths] [pages]  — "after" serves this worktree's public/app/app.css instead of prod's; "control" serves HEAD's (same as prod) through the same route, to separate route artefacts from real changes.
const {chromium}=require('playwright');const fs=require('fs');const path=require('path');
const B='https://relai.kr',P='/app/projects/648bfd17-818d-43ab-ba86-8a88c0ba03a2';const mode=process.argv[2]||'before';
const W=(process.argv[3]||'1440,1920,2560').split(',').map(Number);const PAGES=(process.argv[4]||'wbs,requirements').split(',');
const OUT=path.join(__dirname,'../research/design/wide-b1');const CSS=mode==='control'?require('child_process').execSync('git show HEAD:public/app/app.css',{cwd:__dirname,maxBuffer:1e8}):fs.readFileSync(path.join(__dirname,'../public/app/app.css'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ROW={wbs:'.gtable--wbs tbody tr:has-text("현업 인터뷰") td >> nth=2',requirements:'.gtable tbody tr >> nth=0 >> td >> nth=2',changes:'text=CR-001',issues:'text=ISS-001',tests:'text=TC-004'};
(async()=>{const b=await chromium.launch();const res={};
for(const w of W){const ctx=await b.newContext({viewport:{width:w,height:1100},locale:'ko-KR'});
 const r=await ctx.request.post(B+'/api/auth/login',{data:{email:'qa-20261021-pm@maxxspace.com',password:process.env.PW},headers:{origin:B}});if(!r.ok())throw new Error('login '+r.status());
 if(mode==='after'||mode==='control')await ctx.route(/\/assets\/app\.css/,rt=>rt.fulfill({status:200,contentType:'text/css',body:CSS}));
 const p=await ctx.newPage();const e5=[];p.on('response',x=>{if(x.status()>=500)e5.push(x.status()+' '+x.url())});
 for(const pg of PAGES){await p.goto(B+P+'/'+pg,{waitUntil:'networkidle'}).catch(()=>{});await sleep(1500);
  await p.locator(ROW[pg]).first().click().catch(e=>console.log('noclick',pg,e.message.slice(0,60)));await sleep(1800);
  const m=await p.evaluate(()=>{const R=e=>{if(!e)return null;const r=e.getBoundingClientRect();return [Math.round(r.left),Math.round(r.right)]};
   const d=[...document.querySelectorAll('.rlayout .drawer')].find(x=>!x.hidden);const list=document.querySelector('.rlayout .grid, .rlayout .rtable-wrap');
   const tbl=document.querySelector('.rlayout .gtable, .rlayout .rtable');
   const ins=d?[...d.querySelectorAll('input:not([type=checkbox]):not([type=hidden]),select,textarea')].filter(i=>i.offsetParent).map(i=>Math.round(i.getBoundingClientRect().width)):[];
   return {vw:innerWidth,url:location.pathname+location.search.slice(0,8),list:R(list),table:R(tbl),drawer:R(d),drawerBody:R(d&&d.querySelector('.drawer__b')),inputs:ins.slice(0,8),hscroll:document.documentElement.scrollWidth>innerWidth}});
  res[`${pg}@${w}`]=m;console.log(mode,pg,w,JSON.stringify(m));
  await p.screenshot({path:`${OUT}/${mode}-${pg}-${w}.png`});await sleep(1500)}
 if(e5.length)console.log('5xx',e5);await ctx.close()}
fs.writeFileSync(`${OUT}/${mode}-measure.json`,JSON.stringify(res,null,1));await b.close()})();
