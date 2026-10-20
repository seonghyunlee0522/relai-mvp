/** Provider interface: send({ to, subject, html, text, tags }) → { id }. Throws EmailSendError. */
export class EmailSendError extends Error { constructor(code, message, { retryable = false } = {}) { super(message); this.code = code; this.retryable = retryable; } }

/** Safe Korean message per Resend HTTP status (https://resend.com/docs/api-reference/errors). */
export function resendErrorMessage(status) {
  if (status === 400 || status === 422) return '받는 주소 또는 발신 주소(EMAIL_FROM) 형식이 올바르지 않습니다.';
  if (status === 401) return 'RESEND_API_KEY가 올바르지 않습니다. Resend에서 키를 확인하세요.';
  if (status === 403) return '발신 도메인이 Resend에서 인증되지 않았습니다. 도메인 DNS 인증을 확인하세요.';
  if (status === 429) return 'Resend 발송 한도를 초과했습니다. 잠시 후 다시 시도하세요.';
  if (status >= 500) return 'Resend 서버 오류로 발송하지 못했습니다. 잠시 후 다시 시도하세요.';
  return `메일 발송에 실패했습니다. (HTTP ${status})`;
}
/** Strips anything key-shaped (Bearer tokens, Resend `re_…` keys, the configured key itself) from text that may be stored or shown. */
export function redactSecrets(text, key = process.env.RESEND_API_KEY) {
  let out = String(text ?? '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\bre_[A-Za-z0-9_]{6,}/g, '[redacted]');
  const k = String(key ?? '').trim(); if (k.length >= 6) out = out.split(k).join('[redacted]');
  return out;
}

export function resendProvider(cfg, fetchImpl = globalThis.fetch) {
  return {
    name: 'resend',
    async send({ to, subject, html, text, tags = [] }) {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), cfg.timeoutMs);
      let res; let body = null;
      try {
        res = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${cfg.resendApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: cfg.from, to: [to], subject, html, text, tags: tags.map((name) => ({ name: 'type', value: name })) }), signal: ac.signal });
        body = await res.json().catch(() => null);
      } catch (e) { clearTimeout(t); const timeout = e.name === 'AbortError'; throw new EmailSendError(timeout ? 'timeout' : 'network', timeout ? '메일 서버 응답 시간이 초과되었습니다.' : '메일 서버에 연결할 수 없습니다.', { retryable: true }); }
      clearTimeout(t);
      // Resend's own error text is never passed on (it can echo addresses or account details): a fixed Korean message per status.
      if (!res.ok) throw new EmailSendError(`http_${res.status}`, resendErrorMessage(res.status), { retryable: res.status === 429 || res.status >= 500 });
      return { id: body?.id ? String(body.id) : null };
    },
  };
}

/** In-memory provider for development and tests. `outbox` keeps full messages (never persisted); `failNext` simulates failures. */
export function fakeEmailProvider() {
  const f = { name: 'fake', outbox: [], failNext: null, seq: 0,
    async send(msg) {
      if (f.failNext) { const e = f.failNext; f.failNext = null; throw new EmailSendError(e.code || 'fake_fail', e.message || 'fake failure', { retryable: Boolean(e.retryable) }); }
      const id = `fake-${++f.seq}`; f.outbox.push({ id, ...msg, at: new Date().toISOString() }); return { id };
    },
    last: () => f.outbox[f.outbox.length - 1] || null,
    find: (fn) => f.outbox.filter(fn),
  };
  return f;
}
