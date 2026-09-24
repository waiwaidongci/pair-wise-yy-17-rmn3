const express = require('express');

const TEMP_MIN = 2;
const TEMP_MAX = 8;
// 不同敏感等级样点允许的采样到到站时长上限（小时）
const TRANSIT_LIMIT_HOURS = { 高: 24, 中: 48, 低: 72 };
const DEFAULT_LIMIT_HOURS = 48;
const COLLECTIONS = ['coldboxes', 'bottles', 'transports', 'handoffs', 'reviews'];

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function ensureCollections(db) {
  for (const key of COLLECTIONS) db[key] = db[key] || [];
}

// 到站判定：温度超出2-8℃或封条破损即为问题交接
function handoffProblems({ temperature, sealIntact }) {
  const problems = [];
  const temp = Number(temperature);
  if (!(temp >= TEMP_MIN && temp <= TEMP_MAX)) problems.push(`温度${temperature}℃超出${TEMP_MIN}-${TEMP_MAX}℃`);
  if (!sealIntact) problems.push('封条破损');
  return problems;
}

function limitFor(sensitivity) {
  return TRANSIT_LIMIT_HOURS[sensitivity] ?? DEFAULT_LIMIT_HOURS;
}

// 复核结论：温度、封条、采样到到站的时长共同判定
function judgeReview(basis) {
  const reasons = handoffProblems(basis);
  const hours = (new Date(basis.arrivedAt) - new Date(basis.sampledAt)) / 36e5;
  if (Number.isFinite(hours) && hours > basis.limitHours) {
    reasons.push(`转运时长${hours.toFixed(1)}h超过${basis.limitHours}h上限`);
  }
  return { conclusion: reasons.length ? '不合格' : '合格', reasons };
}

module.exports = function coldchain({ readDb, writeDb, stamp }) {
  const router = express.Router();

  async function loadDb() {
    const db = await readDb();
    ensureCollections(db);
    return db;
  }

  function reviewBasis(db, handoff, bottle, overrideTemp) {
    const site = db.sites.find((entry) => entry.id === bottle.siteId);
    const sensitivity = site?.sensitivity || '中';
    return {
      temperature: overrideTemp ?? handoff.temperature,
      sealIntact: handoff.sealIntact,
      sampledAt: bottle.sampledAt,
      arrivedAt: handoff.arrivedAt,
      siteId: bottle.siteId,
      sensitivity,
      limitHours: limitFor(sensitivity)
    };
  }

  function buildReview(db, handoff, bottle, { reviewer, overrideTemp = null, note = '', version = 1 }) {
    const basis = reviewBasis(db, handoff, bottle, overrideTemp ?? undefined);
    const { conclusion, reasons } = judgeReview(basis);
    return {
      id: newId('review'),
      handoffId: handoff.id,
      bottleId: bottle.id,
      version,
      reviewer,
      temperature: overrideTemp,
      conclusion,
      reasons,
      basis,
      status: '现行',
      note,
      createdAt: new Date().toISOString()
    };
  }

  function refreshHandoffResult(db, handoff) {
    const current = db.reviews.filter((entry) => entry.handoffId === handoff.id && entry.status === '现行');
    const result = current.length
      ? (current.some((entry) => entry.conclusion === '不合格') ? '复检不合格' : '复检合格')
      : (handoffProblems(handoff).length ? '待复检' : '正常');
    if (result !== handoff.result) {
      handoff.result = result;
      handoff.updatedAt = new Date().toISOString();
    }
  }

  function refreshBottleStatus(db, bottle) {
    const transport = db.transports.find((entry) => entry.id === bottle.currentTransportId);
    if (!transport) return;
    const handoffs = db.handoffs.filter((entry) => entry.transportId === transport.id);
    const reviews = db.reviews.filter((entry) => entry.bottleId === bottle.id && entry.status === '现行');
    let status = '转运中';
    if (handoffs.some((entry) => entry.result === '待复检')) status = '待复检';
    else if (reviews.some((entry) => entry.conclusion === '不合格')) status = '复检不合格';
    else if (reviews.length) status = '复检合格';
    if (transport.status === '已结束' && status !== '待复检' && status !== '复检不合格') status = '已入库';
    if (status !== bottle.status) {
      bottle.status = status;
      bottle.updatedAt = new Date().toISOString();
    }
  }

  // 更正后重算：旧版本标记为已更正保留可查，按新值生成下一版结论
  function recalcReviews(db, filter, note) {
    const now = new Date().toISOString();
    const handoffIds = new Set();
    const bottleIds = new Set();
    let recalculated = 0;
    const current = db.reviews.filter((entry) => entry.status === '现行' && filter(entry));
    for (const review of current) {
      const handoff = db.handoffs.find((entry) => entry.id === review.handoffId);
      const bottle = db.bottles.find((entry) => entry.id === review.bottleId);
      if (!handoff || !bottle) continue;
      const next = buildReview(db, handoff, bottle, {
        reviewer: review.reviewer,
        overrideTemp: review.temperature,
        note: note || review.note,
        version: review.version + 1
      });
      const changed = next.conclusion !== review.conclusion
        || JSON.stringify(next.basis) !== JSON.stringify(review.basis);
      if (!changed) continue;
      review.status = '已更正';
      review.supersededAt = now;
      db.reviews.push(next);
      handoffIds.add(handoff.id);
      bottleIds.add(bottle.id);
      recalculated += 1;
    }
    for (const handoffId of handoffIds) {
      const handoff = db.handoffs.find((entry) => entry.id === handoffId);
      if (handoff) refreshHandoffResult(db, handoff);
    }
    for (const bottleId of bottleIds) {
      const bottle = db.bottles.find((entry) => entry.id === bottleId);
      if (bottle) refreshBottleStatus(db, bottle);
    }
    return { recalculated };
  }

  // 等待列表：按等待时间降序，标出每瓶当前站与问题交接
  router.get('/board', async (req, res) => {
    const db = await loadDb();
    const now = Date.now();
    const rows = db.bottles
      .filter((bottle) => bottle.status !== '已入库')
      .map((bottle) => {
        const site = db.sites.find((entry) => entry.id === bottle.siteId);
        const transport = db.transports.find((entry) => entry.id === bottle.currentTransportId);
        const box = transport ? db.coldboxes.find((entry) => entry.id === transport.boxId) : null;
        const handoffs = db.handoffs
          .filter((entry) => entry.transportId === transport?.id)
          .sort((a, b) => new Date(a.arrivedAt) - new Date(b.arrivedAt));
        const lastHandoff = handoffs[handoffs.length - 1];
        const waitingSince = bottle.status === '待装运'
          ? bottle.sampledAt
          : (lastHandoff?.arrivedAt || transport?.startedAt || bottle.sampledAt);
        const problems = handoffs
          .filter((entry) => entry.result === '待复检' || entry.result === '复检不合格')
          .map((entry) => ({ handoffId: entry.id, station: entry.station, result: entry.result, arrivedAt: entry.arrivedAt }));
        return {
          ...bottle,
          site: site ? { cave: site.cave, zone: site.zone, pointCode: site.pointCode, sensitivity: site.sensitivity } : null,
          transport: transport ? { id: transport.id, route: transport.route, status: transport.status, boxCode: box?.boxCode || '' } : null,
          waitingSince,
          waitingMinutes: Math.max(0, Math.round((now - new Date(waitingSince).getTime()) / 60000)),
          problems
        };
      })
      .sort((a, b) => b.waitingMinutes - a.waitingMinutes);
    res.json({ generatedAt: new Date(now).toISOString(), rows });
  });

  // 装箱发运：同一冷箱还有未结束转运时不能装别批样品
  router.post('/transports', async (req, res) => {
    const db = await loadDb();
    const { boxId, route, note = '' } = req.body;
    const bottleIds = Array.isArray(req.body.bottleIds) ? req.body.bottleIds : [];
    const box = db.coldboxes.find((entry) => entry.id === boxId);
    if (!box) return res.status(404).json({ error: '冷箱不存在' });
    if (!route) return res.status(400).json({ error: '请填写转运线路' });
    if (!bottleIds.length) return res.status(400).json({ error: '至少选择一瓶样品' });
    if (db.transports.some((entry) => entry.boxId === boxId && entry.status === '转运中')) {
      return res.status(409).json({ error: '该冷箱还有未结束的转运，不能装别批样品' });
    }
    const bottles = bottleIds.map((id) => db.bottles.find((entry) => entry.id === id));
    if (bottles.some((entry) => !entry)) return res.status(404).json({ error: '样品瓶不存在' });
    if (bottles.some((entry) => entry.status !== '待装运')) {
      return res.status(409).json({ error: '只有待装运的样品瓶可以装箱' });
    }
    const now = new Date().toISOString();
    const transport = {
      id: newId('transport'),
      boxId,
      bottleIds: [...bottleIds],
      route,
      note,
      status: '转运中',
      currentStation: '已装箱待发',
      startedAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
      history: [stamp('装箱发运', note)]
    };
    db.transports.push(transport);
    box.status = '转运中';
    box.updatedAt = now;
    box.history = box.history || [];
    box.history.unshift(stamp('装箱发运', `批次 ${transport.id}`));
    for (const bottle of bottles) {
      bottle.status = '转运中';
      bottle.currentTransportId = transport.id;
      bottle.currentStation = transport.currentStation;
      bottle.updatedAt = now;
      bottle.history = bottle.history || [];
      bottle.history.unshift(stamp('装箱发运', `冷箱 ${box.boxCode} · ${route}`));
    }
    await writeDb(db);
    res.status(201).json(transport);
  });

  // 到站登记：温度、接收人、封条；超温或封条破损转待复检
  router.post('/transports/:id/handoffs', async (req, res) => {
    const db = await loadDb();
    const transport = db.transports.find((entry) => entry.id === req.params.id);
    if (!transport) return res.status(404).json({ error: '转运批次不存在' });
    if (transport.status !== '转运中') return res.status(409).json({ error: '该批次已结束，不能登记交接' });
    const { station, receiver, note = '' } = req.body;
    const temperature = Number(req.body.temperature);
    const sealIntact = Boolean(req.body.sealIntact);
    if (!station || !receiver) return res.status(400).json({ error: '请填写站点和接收人' });
    if (!Number.isFinite(temperature)) return res.status(400).json({ error: '请填写到站温度' });
    const now = new Date().toISOString();
    const handoff = {
      id: newId('handoff'),
      transportId: transport.id,
      station,
      arrivedAt: now,
      temperature,
      receiver,
      sealIntact,
      result: handoffProblems({ temperature, sealIntact }).length ? '待复检' : '正常',
      note,
      createdAt: now,
      updatedAt: now,
      history: [stamp('到站登记', `${station} · ${temperature}℃ · ${receiver}`)]
    };
    db.handoffs.push(handoff);
    transport.currentStation = station;
    transport.updatedAt = now;
    transport.history = transport.history || [];
    transport.history.unshift(stamp('到站登记', `${station}${handoff.result === '待复检' ? ' · 转待复检' : ''}`));
    for (const bottleId of transport.bottleIds) {
      const bottle = db.bottles.find((entry) => entry.id === bottleId);
      if (!bottle) continue;
      bottle.currentStation = station;
      bottle.updatedAt = now;
      bottle.history = bottle.history || [];
      if (handoff.result === '待复检') {
        bottle.status = '待复检';
        bottle.history.unshift(stamp('转待复检', `${station} 交接异常`));
      } else {
        bottle.history.unshift(stamp('到站登记', station));
      }
    }
    await writeDb(db);
    res.status(201).json(handoff);
  });

  // 复测：须由另一位巡测员提交，结论按温度、封条、转运时长判定
  router.post('/handoffs/:id/reviews', async (req, res) => {
    const db = await loadDb();
    const handoff = db.handoffs.find((entry) => entry.id === req.params.id);
    if (!handoff) return res.status(404).json({ error: '交接记录不存在' });
    if (handoff.result !== '待复检') return res.status(409).json({ error: '该交接不在待复检状态' });
    const { reviewer, note = '' } = req.body;
    if (!reviewer) return res.status(400).json({ error: '请填写复测员' });
    if (reviewer === handoff.receiver) return res.status(409).json({ error: '复测须由另一位巡测员完成' });
    const overrideTemp = req.body.temperature === null || req.body.temperature === undefined || req.body.temperature === ''
      ? null
      : Number(req.body.temperature);
    if (overrideTemp !== null && !Number.isFinite(overrideTemp)) {
      return res.status(400).json({ error: '复测温度无效' });
    }
    const transport = db.transports.find((entry) => entry.id === handoff.transportId);
    const now = new Date().toISOString();
    const created = [];
    for (const bottleId of transport?.bottleIds || []) {
      const bottle = db.bottles.find((entry) => entry.id === bottleId);
      if (!bottle) continue;
      const review = buildReview(db, handoff, bottle, { reviewer, overrideTemp, note, version: 1 });
      review.createdAt = now;
      db.reviews.push(review);
      created.push(review);
    }
    refreshHandoffResult(db, handoff);
    handoff.history = handoff.history || [];
    handoff.history.unshift(stamp('复测', `${reviewer} · ${handoff.result}`));
    for (const bottleId of transport?.bottleIds || []) {
      const bottle = db.bottles.find((entry) => entry.id === bottleId);
      if (!bottle) continue;
      refreshBottleStatus(db, bottle);
      bottle.history = bottle.history || [];
      bottle.history.unshift(stamp('复测', `${reviewer} · ${bottle.status}`));
    }
    await writeDb(db);
    res.status(201).json(created);
  });

  // 更正采样时刻/样点：关联复核结论按新值重算，旧记录保留为已更正
  router.patch('/bottles/:id/correct', async (req, res) => {
    const db = await loadDb();
    const bottle = db.bottles.find((entry) => entry.id === req.params.id);
    if (!bottle) return res.status(404).json({ error: '样品瓶不存在' });
    const { sampledAt, siteId, note = '' } = req.body;
    const changes = [];
    if (sampledAt) {
      const time = new Date(sampledAt).getTime();
      if (Number.isNaN(time)) return res.status(400).json({ error: '采样时刻无效' });
      if (time !== new Date(bottle.sampledAt).getTime()) {
        changes.push(`采样时刻 ${bottle.sampledAt} → ${new Date(time).toISOString()}`);
        bottle.sampledAt = new Date(time).toISOString();
      }
    }
    if (siteId && siteId !== bottle.siteId) {
      const site = db.sites.find((entry) => entry.id === siteId);
      if (!site) return res.status(404).json({ error: '样点不存在' });
      changes.push(`样点 ${bottle.siteId} → ${siteId}`);
      bottle.siteId = siteId;
    }
    if (!changes.length) return res.status(400).json({ error: '没有需要更正的字段' });
    bottle.updatedAt = new Date().toISOString();
    bottle.history = bottle.history || [];
    bottle.history.unshift(stamp('更正', `${changes.join('；')}${note ? ` · ${note}` : ''}`));
    const result = recalcReviews(db, (entry) => entry.bottleId === bottle.id, note || '采样信息更正重算');
    await writeDb(db);
    res.json({ bottle, recalculated: result.recalculated });
  });

  // 更正封条：关联复核结论按新值重算
  router.patch('/handoffs/:id/correct', async (req, res) => {
    const db = await loadDb();
    const handoff = db.handoffs.find((entry) => entry.id === req.params.id);
    if (!handoff) return res.status(404).json({ error: '交接记录不存在' });
    if (typeof req.body.sealIntact !== 'boolean') return res.status(400).json({ error: '请给出更正后的封条状态' });
    if (handoff.sealIntact === req.body.sealIntact) return res.status(400).json({ error: '封条状态未变化' });
    const note = req.body.note || '';
    handoff.sealIntact = req.body.sealIntact;
    handoff.updatedAt = new Date().toISOString();
    handoff.history = handoff.history || [];
    handoff.history.unshift(stamp('封条更正', `${req.body.sealIntact ? '完好' : '破损'}${note ? ` · ${note}` : ''}`));
    const transport = db.transports.find((entry) => entry.id === handoff.transportId);
    const result = recalcReviews(db, (entry) => entry.handoffId === handoff.id, note || '封条更正重算');
    refreshHandoffResult(db, handoff);
    for (const bottleId of transport?.bottleIds || []) {
      const bottle = db.bottles.find((entry) => entry.id === bottleId);
      if (bottle) refreshBottleStatus(db, bottle);
    }
    await writeDb(db);
    res.json({ handoff, recalculated: result.recalculated });
  });

  // 存档：结束转运并释放冷箱；存在待复检交接时禁止
  router.post('/transports/:id/archive', async (req, res) => {
    const db = await loadDb();
    const transport = db.transports.find((entry) => entry.id === req.params.id);
    if (!transport) return res.status(404).json({ error: '转运批次不存在' });
    if (transport.status !== '转运中') return res.status(409).json({ error: '该批次已存档' });
    const pending = db.handoffs.filter((entry) => entry.transportId === transport.id && entry.result === '待复检');
    if (pending.length) return res.status(409).json({ error: `还有${pending.length}次交接待复检，不能存档` });
    const now = new Date().toISOString();
    transport.status = '已结束';
    transport.endedAt = now;
    transport.updatedAt = now;
    transport.history = transport.history || [];
    transport.history.unshift(stamp('存档', '转运结束'));
    const box = db.coldboxes.find((entry) => entry.id === transport.boxId);
    if (box) {
      box.status = '空闲';
      box.updatedAt = now;
      box.history = box.history || [];
      box.history.unshift(stamp('转运结束', `批次 ${transport.id} 已存档`));
    }
    for (const bottleId of transport.bottleIds) {
      const bottle = db.bottles.find((entry) => entry.id === bottleId);
      if (!bottle) continue;
      refreshBottleStatus(db, bottle);
      bottle.history = bottle.history || [];
      bottle.history.unshift(stamp('转运存档', bottle.status));
    }
    await writeDb(db);
    res.json(transport);
  });

  return router;
};
