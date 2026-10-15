/* Admin → Integrations: connection health and sync failures only. Never credentials, never customer issue content. */
import { $, html, raw } from '../core/dom.js';
import { adminApi, chip, errorBlock, head, kpis, rel, section, table } from './ui.js';

const st = (c) => (c.status === 'ERROR' ? chip(c.reconnect_required ? 'RECONNECT_REQUIRED' : 'ERROR') : chip(c.status));
export async function adminIntegrationsPage(main = $('#main')) {
  document.title = '연동 — RELAI Admin';
  let d; try { d = await adminApi('integrations'); } catch (e) { main.innerHTML = errorBlock(e); return; }
  main.innerHTML = html`<div class="apage">${raw(head('연동', html`<span class="hint">지라 클라우드 연결 상태 · 동기화 실패 (자격 증명·이슈 내용은 표시하지 않습니다)</span>`))}
    ${raw(kpis([{ label: '정상', value: d.counts.active, tone: 'ok' }, { label: '오류', value: d.counts.error, tone: d.counts.error ? 'bad' : '' }, { label: '재연결 필요', value: d.counts.reconnect_required, tone: d.counts.reconnect_required ? 'warn' : '' }, { label: '해제됨', value: d.counts.disabled }]))}
    ${raw(section('지라 연결', table([
      { key: 'workspace_name', label: '워크스페이스', w: 200, cls: 'ttl' }, { key: 'site_url', label: '지라 사이트', w: 220, render: (r) => (r.site_url || '').replace(/^https?:\/\//, '') },
      { key: 'status', label: '상태', w: 150, render: (r) => html`${raw(st(r))}${raw(r.last_error ? html` <small class="dim" title="${r.last_error}">${r.last_error.slice(0, 40)}</small>` : '')}` },
      { key: 'external_account_name', label: '지라 계정', w: 140 }, { key: 'mapped_projects', label: '프로젝트', w: 80 }, { key: 'links', label: '연결', w: 70 }, { key: 'webhooks', label: '웹훅', w: 80 },
      { key: 'connected_at', label: '연결일', w: 110, render: (r) => rel(r.connected_at) }, { key: 'last_synced_at', label: '최근 동기화', w: 110, render: (r) => rel(r.last_synced_at) },
    ], d.connections, { id: 'atbl-c' })))}
    ${raw(section('프로젝트 연결', table([
      { key: 'workspace_name', label: '워크스페이스', w: 180 }, { key: 'project_name', label: 'RELAI 프로젝트', w: 220, cls: 'ttl' }, { key: 'site_url', label: '지라 사이트', w: 200, render: (r) => (r.site_url || '').replace(/^https?:\/\//, '') },
      { key: 'external_project_key', label: '지라 프로젝트', w: 200, render: (r) => html`<b class="mono">${r.external_project_key}</b> ${r.external_project_name}` }, { key: 'auto_complete_leaf_wbs', label: '자동 완료', w: 110, render: (r) => (r.auto_complete_leaf_wbs ? '켜짐' : '꺼짐') },
      { key: 'connection_status', label: '연결', w: 90, render: (r) => chip(r.connection_status) }, { key: 'last_synced_at', label: '최근 동기화', w: 110, render: (r) => rel(r.last_synced_at) },
    ], d.mappings, { id: 'atbl-m' })))}
    ${raw(section('최근 동기화 실패', table([
      { key: 'started_at', label: '시각', w: 120, render: (r) => rel(r.started_at) }, { key: 'workspace_name', label: '워크스페이스', w: 160 }, { key: 'project_name', label: '프로젝트', w: 200 }, { key: 'trigger', label: '실행 방식', w: 100 },
      { key: 'status', label: '상태', w: 90, render: (r) => chip(r.status) }, { key: 'items_failed', label: '실패 / 전체', w: 110, render: (r) => `${r.items_failed} / ${r.items_total}` }, { key: 'error_summary', label: '오류', w: 320, render: (r) => html`<small>${r.error_summary || '-'}</small>` },
    ], d.failures, { id: 'atbl-f', empty: '최근 실패한 동기화가 없습니다.' })))}
  </div>`;
}
