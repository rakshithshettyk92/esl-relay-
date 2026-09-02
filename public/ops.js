'use strict';

const byId = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
})[char]);

function duration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days ? `${days}d ` : ''}${hours}h ${minutes}m`;
}

async function loadStatus() {
  const notice = byId('notice');
  try {
    const response = await fetch('/ops/api/status', { cache:'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Status request failed');
    notice.hidden = true;
    byId('serviceStatus').textContent = data.status;
    byId('serviceStatus').className = data.status === 'running' ? 'ok' : 'bad';
    byId('databaseStatus').textContent = `${data.database.connected ? 'Connected' : 'Offline'} · ${data.database.latencyMs}ms`;
    byId('databaseStatus').className = data.database.connected ? 'ok' : 'bad';
    byId('sessions').textContent = data.active_sessions;
    byId('devices').textContent = data.registered_devices;
    byId('openCalls').textContent = data.open_calls;
    byId('calls24h').textContent = data.calls_24h;
    byId('pendingJobs').textContent = data.pendingJobs;
    byId('uptime').textContent = duration(data.uptimeSeconds);
    byId('updated').textContent = `Updated ${new Date(data.timestamp).toLocaleString()}`;
    byId('calls').innerHTML = data.recentCalls.length ? data.recentCalls.map(call => `
      <tr><td>${escapeHtml(new Date(call.created_at).toLocaleString())}</td>
      <td>${escapeHtml(`${call.company_code} / ${call.store_code}`)}</td>
      <td>${escapeHtml(call.label_code)}</td><td>${escapeHtml(call.message)}</td>
      <td><span class="status">${escapeHtml(call.status)}</span></td>
      <td>${escapeHtml(call.claimed_by_username || 'Not yet attended')}</td></tr>`).join('')
      : '<tr><td colspan="6">No calls recorded yet.</td></tr>';
  } catch (error) {
    notice.hidden = false;
    notice.textContent = `Status unavailable: ${error.message}`;
    byId('serviceStatus').textContent = 'Unavailable';
    byId('serviceStatus').className = 'bad';
  }
}

async function loadLogs() {
  try {
    const level = byId('logLevel').value;
    const response = await fetch(`/ops/api/logs?limit=250${level ? `&level=${level}` : ''}`, { cache:'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Log request failed');
    byId('logs').innerHTML = data.logs.length ? data.logs.map(entry => `
      <li><time>${escapeHtml(new Date(entry.timestamp).toLocaleString())}</time>
      <strong class="${escapeHtml(entry.level)}">${escapeHtml(entry.level.toUpperCase())}</strong>
      <span>${escapeHtml(entry.message)}</span></li>`).join('') : '<li>No matching logs.</li>';
  } catch (error) {
    byId('logs').innerHTML = `<li>Logs unavailable: ${escapeHtml(error.message)}</li>`;
  }
}

async function refresh() { await Promise.all([loadStatus(), loadLogs()]); }
byId('refresh').addEventListener('click', refresh);
byId('logLevel').addEventListener('change', loadLogs);
refresh();
setInterval(refresh, 15_000);
