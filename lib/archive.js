// 冷箱转运 · 存档模块
// 更正与结论重算前的旧记录统一进 archives，旧记录随时可查。
function push(db, entry) {
  db.archives = db.archives || [];
  const record = {
    id: `archives-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    ...entry
  };
  db.archives.push(record);
  return record;
}

// 字段更正前的旧值（采样时刻 / 样点 / 封条），snapshot 保存整条旧记录
function fieldCorrection(db, { kind, refId, refLabel, fieldLabel, oldValue, newValue, reason, snapshot }) {
  return push(db, {
    kind,
    refId,
    refLabel,
    fieldLabel,
    oldValue,
    newValue,
    reason: reason || '',
    snapshot
  });
}

// 被重算覆盖的复核结论
function conclusion(db, { refId, refLabel, reason, status, conclusion }) {
  return push(db, {
    kind: '结论重算',
    refId,
    refLabel,
    fieldLabel: '复核结论',
    oldValue: conclusion?.text || '',
    newValue: '',
    reason: reason || '',
    snapshot: { status, conclusion }
  });
}

module.exports = { fieldCorrection, conclusion };
