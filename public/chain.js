// 冷箱转运 · 页面入口
// 判定逻辑见 lib/judgment.js，存档逻辑见 lib/archive.js，本文件只负责页面承载。
window.ChainPage = (() => {
  let ctx = null;

  const esc = (value) => ctx.escapeHtml(value ?? '');
  const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });

  function pill(value) {
    const tone = ctx.config.tones?.[value] || '';
    return `<span class="pill ${tone}">${esc(value || '-')}</span>`;
  }

  function sites() {
    return ctx.db.sites || [];
  }

  function siteLabel(siteId) {
    const site = sites().find((entry) => entry.id === siteId);
    return site ? [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ') : '未关联样点';
  }

  function boxOf(boxId) {
    return (ctx.db.coldboxes || []).find((entry) => entry.id === boxId);
  }

  // 瓶所属批次：进行中的优先，否则取最近一批
  function transportOf(bottle) {
    const list = (ctx.db.transports || []).filter((entry) => (entry.bottleIds || []).includes(bottle.id));
    return list.find((entry) => entry.status === '进行中')
      || list.sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0))[0]
      || null;
  }

  function handoffsOf(transportId) {
    return (ctx.db.handoffs || [])
      .filter((entry) => entry.transportId === transportId)
      .sort((a, b) => new Date(a.arrivedAt || 0) - new Date(b.arrivedAt || 0));
  }

  function durationText(from, to) {
    const start = new Date(from).getTime();
    const end = new Date(to).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '-';
    const mins = Math.max(0, Math.round((end - start) / 60000));
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const rest = mins % 60;
    if (days) return `${days}天${hours}小时`;
    if (hours) return `${hours}小时${rest}分`;
    return `${rest}分钟`;
  }

  // 看板排序：未送达的按等待时间降序在前，已送达的按结束时间降序在后
  function boardBottles() {
    const rank = (bottle) => {
      const transport = transportOf(bottle);
      const done = transport && transport.status === '已结束';
      const end = done ? new Date(transport.endedAt).getTime() : Date.now();
      return { done: done ? 1 : 0, wait: end - new Date(bottle.sampledAt || 0).getTime() };
    };
    return [...(ctx.db.bottles || [])].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra.done !== rb.done) return ra.done - rb.done;
      return rb.wait - ra.wait;
    });
  }

  function bottleForm() {
    const options = sites().map((site) => `<option value="${site.id}">${esc(siteLabel(site.id))}</option>`).join('');
    return `<form class="panel" data-chain-form="bottle">
      <h2>登记样品瓶</h2>
      <div class="form-grid">
        <label>样瓶编号<input name="bottleCode" required placeholder="如 W-004"></label>
        <label>采样员<input name="sampler" required placeholder="采样员姓名"></label>
        <label class="wide">样点<select name="siteId">${options}</select></label>
        <label class="wide">采样时刻<input type="datetime-local" name="sampledAt" required></label>
        <label class="wide">备注<input name="note" placeholder="选填"></label>
      </div>
      <div class="actions"><button>保存样瓶</button></div>
    </form>`;
  }

  function boxForm() {
    return `<form class="panel" data-chain-form="box">
      <h2>登记冷箱</h2>
      <div class="form-grid">
        <label>冷箱编号<input name="boxCode" required placeholder="如 BX-03"></label>
        <label>备注<input name="note" placeholder="选填"></label>
      </div>
      <div class="actions"><button>保存冷箱</button></div>
    </form>`;
  }

  function transportForm() {
    const idleBoxes = (ctx.db.coldboxes || []).filter((box) => box.status !== '转运中');
    const idleBottles = (ctx.db.bottles || []).filter((bottle) => bottle.status === '待装车');
    const boxOptions = idleBoxes.length
      ? idleBoxes.map((box) => `<option value="${box.id}">${esc(box.boxCode)}（空闲）</option>`).join('')
      : '<option value="">暂无空闲冷箱</option>';
    const checks = idleBottles.length
      ? idleBottles.map((bottle) => `<label><input type="checkbox" name="bottleIds" value="${bottle.id}"> ${esc(bottle.bottleCode)} · ${esc(siteLabel(bottle.siteId))} · ${esc(bottle.sampler)}</label>`).join('')
      : '<div class="meta">暂无待装车样品瓶</div>';
    return `<form class="panel" data-chain-form="transport">
      <h2>发起转运</h2>
      <label>冷箱（有未结束转运的冷箱不可装新批）<select name="boxId">${boxOptions}</select></label>
      <div class="chain-checks">${checks}</div>
      <label>转运路线<input name="route" placeholder="如 洞口集散点 → 县城中转站 → 实验室"></label>
      <div class="actions"><button ${idleBoxes.length && idleBottles.length ? '' : 'disabled'}>装车发运</button></div>
    </form>`;
  }

  function activeTransportCard(transport) {
    const box = boxOf(transport.boxId);
    const bottles = (transport.bottleIds || [])
      .map((id) => (ctx.db.bottles || []).find((bottle) => bottle.id === id))
      .filter(Boolean);
    const handoffs = handoffsOf(transport.id);
    const pending = handoffs.some((entry) => entry.status === '待复检');
    return `<article class="card">
      <div class="card-head"><h3>${esc(box?.boxCode || '冷箱')} · ${esc(transport.route || '转运中')}</h3>${pill(transport.status)}</div>
      <div class="meta">装车 ${ctx.fmtDate(transport.startedAt)} · 样品 ${bottles.map((bottle) => esc(bottle.bottleCode)).join('、') || '-'} · 已登记 ${handoffs.length} 站</div>
      <form class="chain-inline-form" data-chain-form="arrive" data-id="${transport.id}">
        <input name="station" required placeholder="到站站点">
        <input name="temperature" type="number" step="0.1" required placeholder="温度 ℃">
        <input name="receiver" required placeholder="接收人">
        <select name="sealIntact"><option value="true">封条完好</option><option value="false">封条破损</option></select>
        <button>登记到站</button>
      </form>
      <div class="actions">
        <button class="ghost" data-chain-action="finish" data-id="${transport.id}" ${pending ? 'disabled title="仍有待复检交接，复测完成后才能结束"' : ''}>结束转运</button>
      </div>
    </article>`;
  }

  function recheckForm(handoff) {
    return `<form class="chain-inline-form" data-chain-form="recheck" data-id="${handoff.id}">
      <input name="recheckBy" required placeholder="复测巡测员（须与接收人不同）">
      <select name="result"><option>复检合格</option><option>复检不合格</option></select>
      <input name="note" placeholder="复测备注（选填）">
      <button>提交复测</button>
    </form>`;
  }

  function correctSealDetails(handoff) {
    return `<details class="chain-correct">
      <summary>更正封条（更正后结论按新值重算，旧记录存档）</summary>
      <form class="chain-inline-form" data-chain-form="correct-seal" data-id="${handoff.id}">
        <select name="value"><option value="完好">完好</option><option value="破损">破损</option></select>
        <input name="reason" required placeholder="更正原因">
        <button class="ghost">提交更正</button>
      </form>
    </details>`;
  }

  function legHtml(handoff, index, handoffs, transport) {
    const prevAt = index === 0 ? transport.startedAt : handoffs[index - 1].arrivedAt;
    const segment = prevAt ? `距上一程 +${durationText(prevAt, handoff.arrivedAt)}` : '';
    const problem = (handoff.issues || []).length > 0 || handoff.status === '复检不合格';
    const recheck = handoff.conclusion?.recheck;
    return `<div class="chain-leg${problem ? ' bad' : ''}">
      <div class="leg-head">
        <strong>第${index + 1}站 · ${esc(handoff.station)}</strong>
        ${pill(handoff.status)}
        ${(handoff.issues || []).length ? `<span class="leg-flag">⚠ ${esc(handoff.issues.join('、'))}</span>` : ''}
      </div>
      <div class="meta">${ctx.fmtDate(handoff.arrivedAt)}${segment ? ` · ${segment}` : ''} · ${esc(String(handoff.temperature))}℃ · 接收人 ${esc(handoff.receiver)} · 封条${esc(handoff.sealText)}</div>
      <div class="meta">结论：${esc(handoff.conclusion?.text || '-')}</div>
      ${recheck ? `<div class="meta">复测：${esc(recheck.by)} → ${esc(recheck.result)}${recheck.note ? ` · ${esc(recheck.note)}` : ''}（${ctx.fmtDate(recheck.at)}）</div>` : ''}
      ${handoff.status === '待复检' ? recheckForm(handoff) : ''}
      ${correctSealDetails(handoff)}
    </div>`;
  }

  function correctBottleDetails(bottle) {
    const options = sites().map((site) => `<option value="${site.id}"${site.id === bottle.siteId ? ' selected' : ''}>${esc(siteLabel(site.id))}</option>`).join('');
    return `<details class="chain-correct">
      <summary>更正采样信息（更正后关联结论按新值重算，旧记录存档）</summary>
      <form class="chain-inline-form" data-chain-form="correct-bottle" data-id="${bottle.id}">
        <input type="hidden" name="field" value="sampledAt">
        <input type="datetime-local" name="value" required>
        <input name="reason" required placeholder="更正原因">
        <button class="ghost">更正采样时刻</button>
      </form>
      <form class="chain-inline-form" data-chain-form="correct-bottle" data-id="${bottle.id}">
        <input type="hidden" name="field" value="siteId">
        <select name="value">${options}</select>
        <input name="reason" required placeholder="更正原因">
        <button class="ghost">更正样点</button>
      </form>
    </details>`;
  }

  function bottleCard(bottle) {
    const transport = transportOf(bottle);
    const handoffs = transport ? handoffsOf(transport.id) : [];
    const done = transport && transport.status === '已结束';
    const waiting = done ? durationText(bottle.sampledAt, transport.endedAt) : durationText(bottle.sampledAt, new Date().toISOString());
    const position = !transport
      ? '待装车'
      : done
        ? '已送达实验室'
        : handoffs.length
          ? `已到 ${handoffs[handoffs.length - 1].station}`
          : '已装车 · 未到首站';
    const box = transport ? boxOf(transport.boxId) : null;
    return `<article class="card">
      <div class="card-head"><h3>${esc(bottle.bottleCode)}</h3>${pill(bottle.status)}</div>
      <div class="meta">${esc(siteLabel(bottle.siteId))} · 采样员 ${esc(bottle.sampler)} · 采样 ${ctx.fmtDate(bottle.sampledAt)}</div>
      <div class="chain-position">当前：${esc(position)} · ${done ? '全程历时' : '已等待'} ${waiting}${box ? ` · 冷箱 ${esc(box.boxCode)}` : ''}</div>
      ${handoffs.length ? `<div class="chain-legs">${handoffs.map((handoff, index) => legHtml(handoff, index, handoffs, transport)).join('')}</div>` : ''}
      ${correctBottleDetails(bottle)}
    </article>`;
  }

  function archiveCard(entry) {
    return `<article class="card chain-archive">
      <div class="card-head"><h3>${esc(entry.refLabel || entry.refId)}</h3><span class="pill">${esc(entry.kind)}</span></div>
      <div class="meta">${ctx.fmtDate(entry.createdAt)} · ${esc(entry.fieldLabel || '')}：${esc(String(entry.oldValue ?? '-'))}${entry.newValue ? ` → ${esc(String(entry.newValue))}` : ''}</div>
      ${entry.reason ? `<div class="meta">原因：${esc(entry.reason)}</div>` : ''}
      <details class="chain-correct"><summary>旧记录快照</summary><pre>${esc(JSON.stringify(entry.snapshot, null, 2))}</pre></details>
    </article>`;
  }

  function view() {
    const activeTransports = (ctx.db.transports || []).filter((entry) => entry.status === '进行中');
    const bottles = boardBottles();
    const archives = ctx.db.archives || [];
    return `<div class="chain-grid">
      <div class="chain-col">
        ${bottleForm()}
        ${boxForm()}
        ${transportForm()}
      </div>
      <div class="chain-col">
        <div class="panel">
          <h2>进行中的转运</h2>
          <div class="list">${activeTransports.length ? activeTransports.map(activeTransportCard).join('') : '<div class="empty">暂无进行中的转运</div>'}</div>
        </div>
        <div class="panel">
          <h2>转运看板</h2>
          <p class="meta">按等待时间排列，未送达的在前；标记 ⚠ 的交接即为问题交接。</p>
          <div class="list">${bottles.length ? bottles.map(bottleCard).join('') : '<div class="empty">暂无样品瓶</div>'}</div>
        </div>
      </div>
    </div>
    <div class="panel chain-archives">
      <h2>存档记录（更正前的旧记录仍可查）</h2>
      <div class="list">${archives.length ? archives.map(archiveCard).join('') : '<div class="empty">暂无存档记录</div>'}</div>
    </div>`;
  }

  async function onSubmit(event) {
    const form = event.target.closest('[data-chain-form]');
    if (!form) return;
    event.preventDefault();
    const kind = form.dataset.chainForm;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      if (kind === 'bottle') {
        await ctx.api('/api/chain/bottles', post(data));
      } else if (kind === 'box') {
        await ctx.api('/api/chain/boxes', post(data));
      } else if (kind === 'transport') {
        const bottleIds = new FormData(form).getAll('bottleIds');
        await ctx.api('/api/chain/transports', post({ boxId: data.boxId, route: data.route, bottleIds }));
      } else if (kind === 'arrive') {
        await ctx.api(`/api/chain/transports/${form.dataset.id}/arrive`, post({
          station: data.station,
          temperature: Number(data.temperature),
          receiver: data.receiver,
          sealIntact: data.sealIntact === 'true'
        }));
      } else if (kind === 'recheck') {
        await ctx.api(`/api/chain/handoffs/${form.dataset.id}/recheck`, post(data));
      } else if (kind === 'correct-bottle') {
        await ctx.api('/api/chain/correct', post({ kind: 'bottle', id: form.dataset.id, field: data.field, value: data.value, reason: data.reason }));
      } else if (kind === 'correct-seal') {
        await ctx.api('/api/chain/correct', post({ kind: 'handoff', id: form.dataset.id, field: 'sealIntact', value: data.value, reason: data.reason }));
      }
      await ctx.reload();
      ctx.toast('已保存');
    } catch (error) {
      ctx.toast(error.message);
    }
  }

  async function onClick(event) {
    const button = event.target.closest('[data-chain-action="finish"]');
    if (!button || button.disabled) return;
    try {
      await ctx.api(`/api/chain/transports/${button.dataset.id}/finish`, { method: 'POST' });
      await ctx.reload();
      ctx.toast('转运已结束');
    } catch (error) {
      ctx.toast(error.message);
    }
  }

  function render(root, context) {
    ctx = context;
    root.innerHTML = view();
    root.addEventListener('submit', onSubmit);
    root.addEventListener('click', onClick);
  }

  return { render };
})();
