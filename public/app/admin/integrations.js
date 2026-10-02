/* Admin → Integrations: connection health and sync failures only. Never credentials, never customer issue content. */
import { $, html, raw } from '../core/dom.js';
import { adminApi, chip, errorBlock, head, kpis, rel, section, table } from './ui.js';

const st = (c) => (c.status === 'ERROR' ? chip(c.reconnect_required ? 'RECONNECT_REQUIRED' : 'ERROR') : chip(c.status));
export async function adminIntegrationsPage(main = $('#main')) {
  document.title = 'Integrations — RELAI Admin';
  let d; try { d = await adminApi('integrations'); } catch (e) { main.innerHTML = errorBlock(e); return; }
  main.innerHTML = html`<div class="apage">${raw(head('Integrations', html`<span class="hint">Jira Cloud 연결 상태 · 동기화 실패 (자격 증명·Issue 내용은 표시하지 않습니다)</span>`))}
    ${raw(kpis([{ label: 'Active', value: d.counts.active, tone: 'ok' }, { label: 'Error', value: d.counts.error, tone: d.counts.error ? 'bad' : '' }, { label: 'Reconnect Required', value: d.counts.reconnect_required, tone: d.counts.reconnect_required ? 'warn' : '' }, { label: 'Disabled', value: d.counts.disabled }]))}
    ${raw(section('Jira Connections', table([
      { key: 'workspace_name', label: 'Workspace', w: 200, cls: 'ttl' }, { key: 'site_url', label: 'Jira Site', w: 220, render: (r) => (r.site_url || '').replace(/^https?:\/\//, '') },
      { key: 'status', label: 'Status', w: 150, render: (r) => html`${raw(st(r))}${raw(r.last_error ? html` <small class="dim" title="${r.last_error}">${r.last_error.slice(0, 40)}</small>` : '')}` },
      { key: 'external_account_name', label: 'Jira 계정', w: 140 }, { key: 'mapped_projects', label: 'Projects', w: 80 }, { key: 'links', label: 'Links', w: 70 }, { key: 'webhooks', label: 'Webhooks', w: 80 },
      { key: 'connected_at', label: 'Connected', w: 110, render: (r) => rel(r.connected_at) }, { key: 'last_synced_at', label: 'Last Sync', w: 110, render: (r) => rel(r.last_synced_at) },
    ], d.connections, { id: 'atbl-c' })))}
    ${raw(section('Project Mappings', table([
      { key: 'workspace_name', label: 'Workspace', w: 180 }, { key: 'project_name', label: 'RELAI Project', w: 220, cls: 'ttl' }, { key: 'site_url', label: 'Jira Site', w: 200, render: (r) => (r.site_url || '').replace(/^https?:\/\//, '') },
      { key: 'external_project_key', label: 'Jira Project', w: 200, render: (r) => html`<b class="mono">${r.external_project_key}</b> ${r.external_project_name}` }, { key: 'auto_complete_leaf_wbs', label: 'Auto complete', w: 110, render: (r) => (r.auto_complete_leaf_wbs ? 'ON' : 'OFF') },
      { key: 'connection_status', label: 'Conn.', w: 90, render: (r) => chip(r.connection_status) }, { key: 'last_synced_at', label: 'Last Sync', w: 110, render: (r) => rel(r.last_synced_at) },
    ], d.mappings, { id: 'atbl-m' })))}
    ${raw(section('최근 Sync Failure', table([
      { key: 'started_at', label: 'When', w: 120, render: (r) => rel(r.started_at) }, { key: 'workspace_name', label: 'Workspace', w: 160 }, { key: 'project_name', label: 'Project', w: 200 }, { key: 'trigger', label: 'Trigger', w: 100 },
      { key: 'status', label: 'Status', w: 90, render: (r) => chip(r.status) }, { key: 'items_failed', label: 'Failed / Total', w: 110, render: (r) => `${r.items_failed} / ${r.items_total}` }, { key: 'error_summary', label: 'Error', w: 320, render: (r) => html`<small>${r.error_summary || '-'}</small>` },
    ], d.failures, { id: 'atbl-f', empty: '최근 실패한 동기화가 없습니다.' })))}
  </div>`;
}
