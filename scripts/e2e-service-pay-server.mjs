// E2E server for RELAI 서비스 결제 (/pricing): the real app with the NicePay adapter on a stubbed NicePay API (injected fetch)
// and a local stand-in for the NicePay JS SDK + payment window. Nothing reaches NicePay; no card is charged.
//   DATABASE_URL=postgres://… PORT=3131 EMAIL_PROVIDER=fake node scripts/e2e-service-pay-server.mjs
// The stand-in window (/__nicepay/window) offers 결제 / 취소 / 금액 변조(1,000원) so the browser run can drive every path.
import express from 'express';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createNicepayProvider, windowSignature, paymentSignature } from '../server/billing/nicepay.js';

process.env.SERVICE_PAY_ENABLED ??= 'true';   // checkout is opt-in (payment review P1-1); E2E_CLOSED=1 renders the closed page
if (process.env.E2E_CLOSED === '1') process.env.SERVICE_PAY_ENABLED = 'false';
const CLIENT = 'S2_e2eclient'; const SECRET = 'abcdefghijklmnopqrstuvwxyz012345';
const port = Number(process.env.PORT || 3131);
const tids = new Map();   // tid → orderId (the window binds them, as NicePay does)
const calls = [];
const payObj = (o) => { const p = { resultCode: '0000', resultMsg: '정상 처리되었습니다.', ediDate: new Date().toISOString(), currency: 'KRW', payMethod: 'card',
  card: { cardCode: '04', cardName: '삼성', cardNum: '536112******1234', cardQuota: 0 }, ...o }; return { ...p, signature: paymentSignature(p, SECRET) }; };
const fetchStub = async (url, init) => {
  const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; calls.push({ path: u.pathname, amount: body?.amount ?? null });
  const json = (o) => ({ json: async () => o }); let m;
  if ((m = u.pathname.match(/^\/v1\/payments\/([^/]+)$/))) return json(payObj({ tid: m[1], orderId: tids.get(m[1]), status: 'paid', amount: body.amount, paidAt: new Date().toISOString() }));
  if ((m = u.pathname.match(/^\/v1\/payments\/([^/]+)\/cancel$/))) return json(payObj({ tid: m[1], cancelledTid: `c_${m[1]}`, orderId: body.orderId, status: 'cancelled', amount: 0 }));
  return json({ resultCode: '9999', resultMsg: 'unknown' });
};
const provider = createNicepayProvider({ env: { NICEPAY_CLIENT_KEY: CLIENT, NICEPAY_SECRET_KEY: SECRET, NICEPAY_SDK_URL: '/__nicepay/sdk.js' }, fetch: fetchStub });
const db = await openDb();
const outer = express();
outer.get('/__nicepay/sdk.js', (req, res) => res.type('js').send(`window.AUTHNICE={requestPay:function(o){var q=new URLSearchParams({p:JSON.stringify({clientId:o.clientId,orderId:o.orderId,amount:o.amount,goodsName:o.goodsName,returnUrl:o.returnUrl})});location.href='/__nicepay/window?'+q;}};`));
outer.get('/__nicepay/window', (req, res) => {
  const p = JSON.parse(String(req.query.p || '{}'));
  const form = (over) => { const tid = `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; tids.set(tid, p.orderId);
    const f = { authResultCode: '0000', authResultMsg: '인증 성공', tid, clientId: p.clientId, orderId: p.orderId, amount: String(p.amount), authToken: `tok_${tid}`, ...over };
    return { ...f, signature: windowSignature(f, SECRET) }; };
  const html = (id, label, f) => `<form method="post" action="${p.returnUrl}" id="${id}">${Object.entries(f).map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`).join('')}<button>${label}</button></form>`;
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>NICEPAY</title><body style="font-family:sans-serif;padding:24px"><h1>NICEPAY 결제창 (stand-in)</h1><p>${p.goodsName} · ${p.amount}원</p>
${html('np-pay', '결제', form({}))}${html('np-cancel', '취소', form({ authResultCode: 'U310', authResultMsg: '사용자 취소' }))}${html('np-tamper', '금액 변조', form({ amount: '1000' }))}</body>`);
});
outer.get('/__nicepay/calls', (req, res) => res.json(calls));
outer.use(createApp(db, { billingProvider: provider }));
outer.listen(port, () => console.log(`service-pay e2e server on http://127.0.0.1:${port}`));
