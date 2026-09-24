const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const judgment = require('./lib/judgment');
const archive = require('./lib/archive');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  ensureChain(db);
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const now = new Date().toISOString();
  const item = {
    id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  db[collection].push(item);
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  await writeDb(db);
  res.json(item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
  await writeDb(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });
  await writeDb(db);
  res.json(result.item);
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

// ---------- 冷箱转运（判定：lib/judgment.js，存档：lib/archive.js） ----------
const CHAIN_COLLECTIONS = ['bottles', 'coldboxes', 'transports', 'handoffs', 'archives'];

function ensureChain(db) {
  for (const key of CHAIN_COLLECTIONS) db[key] = db[key] || [];
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function siteOf(db, siteId) {
  return (db.sites || []).find((site) => site.id === siteId);
}

function transportBottles(db, transport) {
  return (transport.bottleIds || []).map((id) => db.bottles.find((bottle) => bottle.id === id)).filter(Boolean);
}

function transportHandoffs(db, transportId) {
  return db.handoffs.filter((entry) => entry.transportId === transportId);
}

function transportSamples(db, transport) {
  return transportBottles(db, transport).map((bottle) => judgment.sampleSnapshot(bottle, siteOf(db, bottle.siteId)));
}

// 瓶状态跟随所属转运批次：已结束→已送达；有待复检交接→待复检；否则转运中
function refreshBottleStatus(db, transport) {
  const pending = transportHandoffs(db, transport.id).some((entry) => entry.status === '待复检');
  const now = new Date().toISOString();
  for (const bottle of transportBottles(db, transport)) {
    bottle.status = transport.status === '已结束' ? '已送达' : pending ? '待复检' : '转运中';
    bottle.updatedAt = now;
  }
}

// 登记样品瓶：绑定样点与采样员
app.post('/api/chain/bottles', async (req, res) => {
  const db = await readDb();
  ensureChain(db);
  const { bottleCode, siteId, sampler, sampledAt, note } = req.body || {};
  if (!bottleCode || !siteId || !sampler || !sampledAt) {
    return res.status(400).json({ error: '样瓶编号、样点、采样员、采样时刻均为必填' });
  }
  if (!siteOf(db, siteId)) return res.status(400).json({ error: '样点不存在' });
  if (db.bottles.some((bottle) => bottle.bottleCode === bottleCode)) {
    return res.status(409).json({ error: `样瓶编号 ${bottleCode} 已存在` });
  }
  const sampledTime = new Date(sampledAt);
  if (Number.isNaN(sampledTime.getTime())) return res.status(400).json({ error: '采样时刻无效' });
  const now = new Date().toISOString();
  const bottle = {
    id: newId('bottles'),
    bottleCode,
    siteId,
    sampler,
    sampledAt: sampledTime.toISOString(),
    status: '待装车',
    note: note || '',
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', '样品瓶登记')]
  };
  db.bottles.push(bottle);
  await writeDb(db);
  res.status(201).json(bottle);
});

// 登记冷箱
app.post('/api/chain/boxes', async (req, res) => {
  const db = await readDb();
  ensureChain(db);
  const { boxCode, note } = req.body || {};
  if (!boxCode) return res.status(400).json({ error: '冷箱编号必填' });
  if (db.coldboxes.some((box) => box.boxCode === boxCode)) {
    return res.status(409).json({ error: `冷箱编号 ${boxCode} 已存在` });
  }
  const now = new Date().toISOString();
  const box = {
    id: newId('coldboxes'),
    boxCode,
    status: '空闲',
    currentTransportId: null,
    note: note || '',
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', '冷箱登记')]
  };
  db.coldboxes.push(box);
  await writeDb(db);
  res.status(201).json(box);
});

// 发起转运：同一冷箱存在未结束转运时禁止装入别批样品
app.post('/api/chain/transports', async (req, res) => {
  const db = await readDb();
  ensureChain(db);
  const { boxId, bottleIds, route } = req.body || {};
  const box = db.coldboxes.find((entry) => entry.id === boxId);
  if (!box) return res.status(400).json({ error: '冷箱不存在' });
  const busy = db.transports.some((entry) => entry.boxId === boxId && entry.status === '进行中');
  if (busy || box.status === '转运中') {
    return res.status(409).json({ error: `冷箱 ${box.boxCode} 还有未结束转运，不能装别批样品` });
  }
  const ids = Array.isArray(bottleIds) ? bottleIds : [];
  const bottles = ids.map((id) => db.bottles.find((bottle) => bottle.id === id));
  if (!ids.length || bottles.some((bottle) => !bottle)) {
    return res.status(400).json({ error: '请选择要装车的样品瓶' });
  }
  const notIdle = bottles.filter((bottle) => bottle.status !== '待装车');
  if (notIdle.length) {
    return res.status(409).json({ error: `${notIdle.map((bottle) => bottle.bottleCode).join('、')} 不在待装车状态` });
  }
  const now = new Date().toISOString();
  const transport = {
    id: newId('transports'),
    boxId,
    bottleIds: ids,
    route: route || '',
    status: '进行中',
    startedAt: now,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', `装车 ${bottles.map((bottle) => bottle.bottleCode).join('、')}`)]
  };
  db.transports.push(transport);
  box.status = '转运中';
  box.currentTransportId = transport.id;
  box.updatedAt = now;
  box.history = box.history || [];
  box.history.unshift(stamp('装车发运', transport.route));
  for (const bottle of bottles) {
    bottle.status = '转运中';
    bottle.updatedAt = now;
    bottle.history = bottle.history || [];
    bottle.history.unshift(stamp('装车', `冷箱 ${box.boxCode}`));
  }
  await writeDb(db);
  res.status(201).json(transport);
});

// 到站登记：温度、接收人、封条 → 判定，越限或破损即转待复检
app.post('/api/chain/transports/:id/arrive', async (req, res) => {
  const db = await readDb();
  ensureChain(db);
  const transport = db.transports.find((entry) => entry.id === req.params.id);
  if (!transport) return res.status(404).json({ error: '转运批次不存在' });
  if (transport.status !== '进行中') return res.status(409).json({ error: '转运已结束，不能再登记到站' });
  const { station, temperature, receiver, sealIntact, arrivedAt } = req.body || {};
  if (!station || !receiver || temperature === undefined || temperature === '') {
    return res.status(400).json({ error: '站点、温度、接收人均为必填' });
  }
  const temp = Number(temperature);
  if (!Number.isFinite(temp)) return res.status(400).json({ error: '温度必须是数字' });
  const seal = sealIntact === true || sealIntact === 'true';
  const judged = judgment.judgeArrival({ temperature: temp, sealIntact: seal });
  const now = new Date().toISOString();
  const handoff = {
    id: newId('handoffs'),
    transportId: transport.id,
    station,
    arrivedAt: arrivedAt ? new Date(arrivedAt).toISOString() : now,
    temperature: temp,
    receiver,
    sealIntact: seal,
    sealText: seal ? '完好' : '破损',
    issues: judged.issues,
    status: judged.status,
    conclusion: null,
    recheckBy: '',
    recheckResult: '',
    recheckNote: '',
    recheckedAt: null,
    createdAt: now,
    updatedAt: now,
    history: [stamp('到站登记', `${station} · ${temp}℃ · ${judged.status}`)]
  };
  handoff.conclusion = judgment.buildConclusion(handoff, transportSamples(db, transport));
  db.handoffs.push(handoff);
  transport.updatedAt = now;
  transport.history = transport.history || [];
  transport.history.unshift(stamp('到站登记', `${station} → ${judged.status}`));
  refreshBottleStatus(db, transport);
  await writeDb(db);
  res.status(201).json(handoff);
});

// 复测：须由另一位巡测员完成
app.post('/api/chain/handoffs/:id/recheck', async (req, res) => {
  const db = await readDb();
  ensureChain(db);
  const handoff = db.handoffs.find((entry) => entry.id === req.params.id);
  if (!handoff) return res.status(404).json({ error: '交接记录不存在' });
  if (handoff.status !== '待复检') return res.status(409).json({ error: '该交接不在待复检状态' });
  const { recheckBy, result, note } = req.body || {};
  if (!recheckBy) return res.status(400).json({ error: '请填写复测巡测员' });
  if (recheckBy === handoff.receiver) return res.status(409).json({ error: '复测须由另一位巡测员完成' });
  if (!['复检合格', '复检不合格'].includes(result)) {
    return res.status(400).json({ error: '复测结果须为 复检合格 或 复检不合格' });
  }
  const now = new Date().toISOString();
  handoff.recheckBy = recheckBy;
  handoff.recheckResult = result;
  handoff.recheckNote = note || '';
  handoff.recheckedAt = now;
  handoff.status = result;
  handoff.conclusion = handoff.conclusion || {};
  handoff.conclusion.recheck = { by: recheckBy, result, note: note || '', at: now };
  handoff.updatedAt = now;
  handoff.history = handoff.history || [];
  handoff.history.unshift(stamp('复测', `${recheckBy} → ${result}`));
  const transport = db.transports.find((entry) => entry.id === handoff.transportId);
  if (transport) refreshBottleStatus(db, transport);
  await writeDb(db);
  res.json(handoff);
});

// 结束转运：仍有待复检交接时不允许结束
app.post('/api/chain/transports/:id/finish', async (req, res) => {
  const db = await readDb();
  ensureChain(db);
  const transport = db.transports.find((entry) => entry.id === req.params.id);
  if (!transport) return res.status(404).json({ error: '转运批次不存在' });
  if (transport.status !== '进行中') return res.status(409).json({ error: '转运已结束' });
  if (transportHandoffs(db, transport.id).some((entry) => entry.status === '待复检')) {
    return res.status(409).json({ error: '仍有待复检的交接，复测完成后才能结束转运' });
  }
  const now = new Date().toISOString();
  transport.status = '已结束';
  transport.endedAt = now;
  transport.updatedAt = now;
  transport.history = transport.history || [];
  transport.history.unshift(stamp('结束转运', ''));
  const box = db.coldboxes.find((entry) => entry.id === transport.boxId);
  if (box) {
    box.status = '空闲';
    box.currentTransportId = null;
    box.updatedAt = now;
    box.history = box.history || [];
    box.history.unshift(stamp('转运结束', ''));
  }
  refreshBottleStatus(db, transport);
  await writeDb(db);
  res.json(transport);
});

// 更正：采样时刻 / 样点 / 封条 → 关联复核结论按新值重算，旧记录存档可查
app.post('/api/chain/correct', async (req, res) => {
  const db = await readDb();
  ensureChain(db);
  const { kind, id, field, value, reason } = req.body || {};
  const now = new Date().toISOString();

  if (kind === 'bottle') {
    const bottle = db.bottles.find((entry) => entry.id === id);
    if (!bottle) return res.status(404).json({ error: '样品瓶不存在' });
    if (!['sampledAt', 'siteId'].includes(field)) {
      return res.status(400).json({ error: '仅支持更正采样时刻或样点' });
    }
    const fieldLabel = field === 'sampledAt' ? '采样时刻' : '样点';
    let newValue = value;
    if (field === 'sampledAt') {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: '采样时刻无效' });
      newValue = parsed.toISOString();
    }
    if (field === 'siteId' && !siteOf(db, newValue)) return res.status(400).json({ error: '样点不存在' });
    if (!newValue) return res.status(400).json({ error: '新值不能为空' });
    if (String(bottle[field]) === String(newValue)) return res.status(409).json({ error: '新值与原值一致' });
    archive.fieldCorrection(db, {
      kind: '样品瓶更正',
      refId: bottle.id,
      refLabel: bottle.bottleCode,
      fieldLabel,
      oldValue: bottle[field],
      newValue,
      reason,
      snapshot: { ...bottle }
    });
    bottle[field] = newValue;
    bottle.updatedAt = now;
    bottle.history = bottle.history || [];
    bottle.history.unshift(stamp('更正', `${fieldLabel}已更正${reason ? `：${reason}` : ''}`));
    // 关联交接的复核结论按新值重算，旧结论逐条存档
    const related = db.transports.filter((entry) => (entry.bottleIds || []).includes(bottle.id));
    for (const transport of related) {
      const samples = transportSamples(db, transport);
      for (const handoff of transportHandoffs(db, transport.id)) {
        archive.conclusion(db, {
          refId: handoff.id,
          refLabel: `${handoff.station}（${bottle.bottleCode}）`,
          reason: `${bottle.bottleCode} ${fieldLabel}更正`,
          status: handoff.status,
          conclusion: handoff.conclusion
        });
        handoff.conclusion = judgment.buildConclusion(handoff, samples, handoff.conclusion?.recheck || null);
        handoff.updatedAt = now;
        handoff.history = handoff.history || [];
        handoff.history.unshift(stamp('结论重算', `因 ${bottle.bottleCode} ${fieldLabel}更正`));
      }
    }
    await writeDb(db);
    return res.json(bottle);
  }

  if (kind === 'handoff') {
    const handoff = db.handoffs.find((entry) => entry.id === id);
    if (!handoff) return res.status(404).json({ error: '交接记录不存在' });
    if (field !== 'sealIntact') return res.status(400).json({ error: '仅支持更正封条状态' });
    const newSeal = value === true || value === 'true' || value === '完好';
    if (newSeal === !!handoff.sealIntact) return res.status(409).json({ error: '新值与原值一致' });
    archive.fieldCorrection(db, {
      kind: '封条更正',
      refId: handoff.id,
      refLabel: handoff.station,
      fieldLabel: '封条',
      oldValue: handoff.sealText,
      newValue: newSeal ? '完好' : '破损',
      reason,
      snapshot: { ...handoff }
    });
    handoff.sealIntact = newSeal;
    handoff.sealText = newSeal ? '完好' : '破损';
    const judged = judgment.judgeArrival(handoff);
    handoff.issues = judged.issues;
    handoff.status = judged.status;
    let noteText = `封条更正为${handoff.sealText}，结论按新值重算`;
    if (handoff.recheckedAt) {
      // 原复测基于旧值作出，更正后作废，需重新复测
      handoff.recheckBy = '';
      handoff.recheckResult = '';
      handoff.recheckNote = '';
      handoff.recheckedAt = null;
      noteText += '，原复测结论作废';
    }
    handoff.conclusion = judgment.buildConclusion(handoff, handoff.conclusion?.samples || [], null);
    handoff.updatedAt = now;
    handoff.history = handoff.history || [];
    handoff.history.unshift(stamp('封条更正', noteText));
    const transport = db.transports.find((entry) => entry.id === handoff.transportId);
    if (transport) refreshBottleStatus(db, transport);
    await writeDb(db);
    return res.json(handoff);
  }

  res.status(400).json({ error: '不支持的更正类型' });
});

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
