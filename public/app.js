const state = {
  config: null,
  db: {},
  board: null,
  activeTab: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function displayField(item, field) {
  const value = item[field.name] ?? '';
  if (field.type === 'select' && field.options) return value || field.options[0];
  return value;
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function siteLabel(site) {
  return site ? [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ') : '未关联';
}

function siteOptions(selectedId) {
  return (state.db.sites || [])
    .map((site) => `<option value="${site.id}"${site.id === selectedId ? ' selected' : ''}>${escapeHtml(siteLabel(site))}</option>`)
    .join('');
}

function fmtWait(minutes) {
  if (minutes === null || minutes === undefined) return '-';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}小时`;
  return `${Math.floor(hours / 24)}天${hours % 24 ? `${hours % 24}小时` : ''}`;
}

function toLocalInput(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function reviewRow(review) {
  const bottle = (state.db.bottles || []).find((entry) => entry.id === review.bottleId);
  const basis = review.basis || {};
  return `<div class="review${review.status === '已更正' ? ' superseded' : ''}">
    ${pill(review.status, toneFor(review.status))}
    ${pill(review.conclusion, toneFor(review.conclusion))}
    <span>${escapeHtml(bottle?.bottleCode || '')} · v${review.version} · 复测 ${escapeHtml(review.reviewer)} · ${fmtDate(review.createdAt)}</span>
    ${(review.reasons || []).length ? `<span class="meta">${escapeHtml(review.reasons.join('；'))}</span>` : ''}
    <span class="meta">依据 ${basis.temperature}℃ · 封条${basis.sealIntact ? '完好' : '破损'} · 采样 ${fmtDate(basis.sampledAt)} · 限${basis.limitHours}h</span>
  </div>`;
}

function handoffCard(handoff) {
  const reviews = (state.db.reviews || [])
    .filter((entry) => entry.handoffId === handoff.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return `<div class="handoff${handoff.result === '正常' ? '' : ' problem'}">
    <div class="handoff-head">
      <strong>${escapeHtml(handoff.station)}</strong>
      ${pill(handoff.result, toneFor(handoff.result))}
      <span class="meta">${fmtDate(handoff.arrivedAt)} · ${handoff.temperature}℃ · 接收 ${escapeHtml(handoff.receiver)} · 封条${handoff.sealIntact ? '完好' : '破损'}</span>
    </div>
    ${handoff.result === '待复检' ? `<details class="inline-form"><summary>复测（须另一位巡测员）</summary>
      <form data-coldchain-form="review" data-id="${handoff.id}">
        <label>复测员<input name="reviewer" required></label>
        <label>复测温度（℃）<input type="number" step="0.1" name="temperature" placeholder="留空取到站温度"></label>
        <label class="wide">备注<input name="note"></label>
        <div class="actions wide"><button>提交复测结论</button></div>
      </form>
    </details>` : ''}
    <details class="inline-form"><summary>封条更正</summary>
      <form data-coldchain-form="correct-handoff" data-id="${handoff.id}">
        <label>更正为<select name="sealIntact">
          <option${handoff.sealIntact ? ' selected' : ''}>完好</option>
          <option${handoff.sealIntact ? '' : ' selected'}>破损</option>
        </select></label>
        <label>说明<input name="note" placeholder="更正原因"></label>
        <div class="actions wide"><button>更正并重算结论</button></div>
      </form>
    </details>
    ${reviews.length ? `<div class="reviews">${reviews.map(reviewRow).join('')}</div>` : ''}
  </div>`;
}

function transportCard(transport) {
  const box = (state.db.coldboxes || []).find((entry) => entry.id === transport.boxId);
  const bottles = (transport.bottleIds || [])
    .map((id) => (state.db.bottles || []).find((entry) => entry.id === id))
    .filter(Boolean);
  const handoffs = (state.db.handoffs || [])
    .filter((entry) => entry.transportId === transport.id)
    .sort((a, b) => new Date(a.arrivedAt) - new Date(b.arrivedAt));
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(box?.boxCode || '冷箱')} · ${escapeHtml(transport.route)}</h3>${pill(transport.status, toneFor(transport.status))}</div>
    <div class="meta">发运 ${fmtDate(transport.startedAt)} · 当前站：${escapeHtml(transport.currentStation || '-')}</div>
    <div class="chips">${bottles.map((bottle) => pill(`${bottle.bottleCode} · ${bottle.status}`, toneFor(bottle.status))).join('')}</div>
    <div class="timeline">${handoffs.length ? handoffs.map(handoffCard).join('') : '<div class="empty">尚无到站交接</div>'}</div>
    <details class="inline-form"><summary>到站登记</summary>
      <form data-coldchain-form="handoff" data-id="${transport.id}">
        <label>站点<input name="station" required placeholder="如：县城冷链站"></label>
        <label>到站温度（℃）<input type="number" step="0.1" name="temperature" required></label>
        <label>接收人<input name="receiver" required></label>
        <label>封条<select name="sealIntact"><option>完好</option><option>破损</option></select></label>
        <label class="wide">备注<input name="note"></label>
        <div class="actions wide"><button>登记到站</button></div>
      </form>
    </details>
    <div class="actions"><button class="secondary" data-archive="${transport.id}">存档并结束转运</button></div>
  </article>`;
}

function boardRow(row) {
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(row.bottleCode)}</h3>${pill(row.status, toneFor(row.status))}</div>
    <div class="meta">${escapeHtml(siteLabel(row.site))} · 采样员 ${escapeHtml(row.sampler)} · 采样 ${fmtDate(row.sampledAt)}</div>
    <div class="detail">
      <div>当前站<br><strong>${escapeHtml(row.currentStation || '未装箱')}</strong></div>
      <div>已等待<br><strong>${fmtWait(row.waitingMinutes)}</strong></div>
      <div>转运批次<br><strong>${row.transport ? `${escapeHtml(row.transport.boxCode)} · ${escapeHtml(row.transport.route)}` : '—'}</strong></div>
    </div>
    ${row.problems.length
      ? `<div class="problems">问题交接：${row.problems.map((problem) => pill(`${problem.station} · ${problem.result}`, 'bad')).join('')}</div>`
      : '<div class="meta" style="margin-top:8px">交接均正常</div>'}
    <details class="inline-form"><summary>更正采样信息</summary>
      <form data-coldchain-form="correct-bottle" data-id="${row.id}">
        <label>采样时刻<input type="datetime-local" name="sampledAt" value="${toLocalInput(row.sampledAt)}" required></label>
        <label>样点<select name="siteId">${siteOptions(row.siteId)}</select></label>
        <label class="wide">说明<input name="note" placeholder="更正原因"></label>
        <div class="actions wide"><button>更正并重算复核结论</button></div>
      </form>
    </details>
  </article>`;
}

function renderColdchainView(view) {
  const freeBoxes = (state.db.coldboxes || []).filter((box) => box.status === '空闲');
  const pendingBottles = (state.db.bottles || []).filter((bottle) => bottle.status === '待装运');
  const activeTransports = (state.db.transports || []).filter((transport) => transport.status === '转运中');
  const rows = state.board?.rows || [];
  const canShip = freeBoxes.length && pendingBottles.length;
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-coldchain-form="transport">
        <h2>装箱发运</h2>
        <div class="form-grid">
          <label class="wide">冷箱（仅空闲可选）
            <select name="boxId" required>${freeBoxes.length
              ? freeBoxes.map((box) => `<option value="${box.id}">${escapeHtml(box.boxCode)}</option>`).join('')
              : '<option value="">无空闲冷箱</option>'}</select>
          </label>
          <label class="wide">转运线路<input name="route" required placeholder="如：西线巡测 → 实验室"></label>
          <label class="wide">备注<input name="note"></label>
          <div class="wide">
            <span class="field-label">待装运样品瓶（同批勾选）</span>
            <div class="check-list">${pendingBottles.length
              ? pendingBottles.map((bottle) => `<label class="check-item"><input type="checkbox" name="bottleIds" value="${bottle.id}"><span>${escapeHtml(bottle.bottleCode)} · ${escapeHtml(siteLabel((state.db.sites || []).find((site) => site.id === bottle.siteId)))} · ${escapeHtml(bottle.sampler)} · ${fmtDate(bottle.sampledAt)}</span></label>`).join('')
              : '<span class="meta">暂无待装运样品瓶</span>'}</div>
          </div>
        </div>
        <div class="actions"><button ${canShip ? '' : 'disabled'}>发运</button></div>
        <p class="meta">同一冷箱存在未结束转运时，不能装别批样品。</p>
      </form>
      <div class="panel">
        <h2>等待列表（按等待时间排序）</h2>
        <div class="list">${rows.length ? rows.map(boardRow).join('') : '<div class="empty">暂无在途或待办样品</div>'}</div>
      </div>
    </div>
    <div class="panel" style="margin-top:18px">
      <h2>在途转运</h2>
      <div class="list">${activeTransports.length ? activeTransports.map(transportCard).join('') : '<div class="empty">暂无在途转运批次</div>'}</div>
    </div>
  </section>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'coldchain') return renderColdchainView(view);
    return renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  const [db, board] = await Promise.all([api('/api/db'), api('/api/coldchain/board')]);
  state.db = db;
  state.board = board;
  render();
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const archive = event.target.closest('[data-archive]');
  if (tab) setTab(tab.dataset.tab);
  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
  if (archive) {
    try {
      await api(`/api/coldchain/transports/${archive.dataset.archive}/archive`, { method: 'POST' });
      await load();
      toast('已存档，冷箱已释放');
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(values(form, view)) });
  form.reset();
  await load();
  toast('已保存');
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-coldchain-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.coldchainForm;
  const id = form.dataset.id;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    if (kind === 'transport') {
      const bottleIds = new FormData(form).getAll('bottleIds');
      await api('/api/coldchain/transports', {
        method: 'POST',
        body: JSON.stringify({ boxId: data.boxId, route: data.route, note: data.note, bottleIds })
      });
      toast('已发运');
    } else if (kind === 'handoff') {
      await api(`/api/coldchain/transports/${id}/handoffs`, {
        method: 'POST',
        body: JSON.stringify({
          station: data.station,
          temperature: Number(data.temperature),
          receiver: data.receiver,
          sealIntact: data.sealIntact === '完好',
          note: data.note
        })
      });
      toast('已登记到站');
    } else if (kind === 'review') {
      await api(`/api/coldchain/handoffs/${id}/reviews`, {
        method: 'POST',
        body: JSON.stringify({
          reviewer: data.reviewer,
          temperature: data.temperature === '' ? null : Number(data.temperature),
          note: data.note
        })
      });
      toast('复测结论已记录');
    } else if (kind === 'correct-bottle') {
      await api(`/api/coldchain/bottles/${id}/correct`, {
        method: 'PATCH',
        body: JSON.stringify({
          sampledAt: data.sampledAt ? new Date(data.sampledAt).toISOString() : undefined,
          siteId: data.siteId || undefined,
          note: data.note
        })
      });
      toast('已更正并重算');
    } else if (kind === 'correct-handoff') {
      await api('/api/coldchain/handoffs/' + id + '/correct', {
        method: 'PATCH',
        body: JSON.stringify({ sealIntact: data.sealIntact === '完好', note: data.note })
      });
      toast('已更正并重算');
    }
    await load();
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
