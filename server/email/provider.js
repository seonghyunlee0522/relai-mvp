/** Provider interface: send({ to, subject, html, text, tags }) → { id }. Throws EmailSendError. */
export class EmailSendError extends Error { constructor(code, message, { retryable = false } = {}) { super(message); this.code = code; this.retryable = retryable; } }

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
      } catch (e) { clearTimeout(t); throw new EmailSendError(e.name === 'AbortError' ? 'timeout' : 'network', '메일 서버에 연결할 수 없습니다.', { retryable: true }); }
      clearTimeout(t);
      if (!res.ok) throw new EmailSendError(`http_${res.status}`, body?.message ? String(body.message).slice(0, 200) : `메일 발송 실패 (HTTP ${res.status})`, { retryable: res.status === 429 || res.status >= 500 });
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
