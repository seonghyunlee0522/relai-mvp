/* RELAI 서비스 결제 (/pricing). The page sends a product key and buyer info; the server decides the amount and returns the
 * NicePay window parameters. 월 구독: while recurring is not open the submit only shows '월 구독은 준비 중입니다.' and calls nothing. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pay = $('#pay'); const form = $('#sp-form'); const msg = $('#sp-msg'); const submit = $('#sp-submit');
const SOON = '월 구독은 준비 중입니다.';
let selected = pay.dataset.selected;
const isMonthly = () => selected === 'agent-monthly';

function select(key) {
  selected = key; pay.dataset.selected = key;
  $$('.sp-card').forEach((c) => { const on = c.dataset.product === key; c.classList.toggle('is-on', on); const b = $('[data-pick]', c); b.setAttribute('aria-pressed', String(on)); b.textContent = on ? '선택됨' : (c.dataset.plan === 'monthly' ? '월 구독 선택' : '1회 결제 선택'); });
  $$('[data-sum]').forEach((s) => { s.hidden = s.dataset.sum !== key; });
  $('#sp-cardf').hidden = !isMonthly();
  submit.textContent = isMonthly() ? submit.dataset.labelMonthly : submit.dataset.labelOnce;
  setMsg('');
  const c = $(`.sp-card[data-product="${key}"]`);
  try { history.replaceState(null, '', `/pricing?plan=${c.dataset.plan}&product=agent`); } catch { /* ignore */ }
}
$$('[data-pick]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); select(a.dataset.pick); pay.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));

function setMsg(text, info = false) { msg.textContent = text; msg.classList.toggle('is-info', info); }
function setErrors(fields = {}) {
  $$('[data-err]').forEach((e) => { e.textContent = fields[e.dataset.err] || ''; const i = document.getElementById(e.dataset.err); if (i && i.classList.contains('sp-in')) i.setAttribute('aria-invalid', fields[e.dataset.err] ? 'true' : 'false'); });
  const first = Object.keys(fields)[0]; if (first) document.getElementById(first)?.focus();
}

const all = $('#agree_all'); const consents = $$('[data-consent]');
const visibleConsents = () => consents.filter((c) => !c.closest('[hidden]'));
all.addEventListener('change', () => visibleConsents().forEach((c) => { c.checked = all.checked; }));
consents.forEach((c) => c.addEventListener('change', () => { all.checked = visibleConsents().every((x) => x.checked); }));
$$('[data-toggle]').forEach((b) => b.addEventListener('click', () => { const t = document.getElementById(b.dataset.toggle); t.hidden = !t.hidden; }));
$('#card_expiry').addEventListener('input', (e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 4); e.target.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; });
$('#card_number').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 '); });

const val = (id) => document.getElementById(id).value.trim();
function localCheck() {
  const f = {};
  if (!val('name')) f.name = '이름을 입력해 주세요.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val('email'))) f.email = '이메일 주소를 확인해 주세요.';
  if (val('phone').replace(/\D/g, '').length < 9) f.phone = '연락처를 확인해 주세요.';
  if (isMonthly()) {
    if (!/^\d{14,16}$/.test(val('card_number').replace(/\D/g, ''))) f.card_number = '카드번호를 확인해 주세요.';
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(val('card_expiry'))) f.card_expiry = '유효기간을 MM/YY 형식으로 입력해 주세요.';
    if (!/^(\d{6}|\d{10})$/.test(val('card_id_no'))) f.card_id_no = '생년월일 6자리 또는 사업자등록번호 10자리를 입력해 주세요.';
    if (!/^\d{2}$/.test(val('card_pw'))) f.card_pw = '카드 비밀번호 앞 2자리를 입력해 주세요.';
    if (!$('#agree_recurring').checked) f.agree_recurring = '정기결제에 동의해 주세요.';
  }
  if (!$('#agree_terms').checked) f.agree_terms = '이용약관에 동의해 주세요.';
  if (!$('#agree_privacy').checked) f.agree_privacy = '개인정보 수집·이용에 동의해 주세요.';
  if (!$('#agree_payment').checked) f.agree_payment = '결제 진행에 동의해 주세요.';
  return f;
}

const loadSdk = (url) => new Promise((resolve, reject) => {
  if (window.AUTHNICE) return resolve();
  const s = document.createElement('script'); s.src = url; s.onload = () => (window.AUTHNICE ? resolve() : reject(new Error('sdk'))); s.onerror = () => reject(new Error('sdk'));
  document.head.appendChild(s);
});

let busy = false;
form.addEventListener('submit', async (e) => {
  e.preventDefault(); if (busy) return;
  setMsg('');
  // 월 구독 before NicePay opens recurring billing: say so and call nothing (no order, no card data sent).
  if (isMonthly() && pay.dataset.recurring !== '1') { setErrors({}); setMsg(SOON, true); return; }
  const f = localCheck(); setErrors(f);
  if (Object.keys(f).length) { setMsg('입력값을 확인해 주세요.'); return; }
  if (isMonthly()) { setMsg(SOON, true); return; }   // recurring registration for this page is not open yet
  busy = true; submit.disabled = true;
  try {
    const r = await fetch('/api/service-pay/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ product: selected, buyer: { name: val('name'), company: val('company'), email: val('email'), phone: val('phone') },
        agree_terms: $('#agree_terms').checked, agree_privacy: $('#agree_privacy').checked, agree_payment: $('#agree_payment').checked }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setErrors(j.error?.fields || {}); setMsg(j.error?.message || '결제를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.'); return; }
    await loadSdk(j.sdk_url).catch(() => { throw new Error('결제창을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'); });
    window.AUTHNICE.requestPay({ ...j.pay, fnError: (res) => { setMsg((res && (res.errorMsg || res.msg)) || '결제가 취소되었습니다.'); } });
  } catch (err) { setMsg(err.message || '결제를 시작하지 못했습니다.'); }
  finally { busy = false; submit.disabled = false; }
});
