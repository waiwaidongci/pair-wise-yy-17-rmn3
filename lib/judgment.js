// 冷箱转运 · 判定模块
// 只负责“怎么判”：到站温度与封条 → 交接结论；更正后按新值重算结论。
const TEMP_MIN = 2;
const TEMP_MAX = 8;

// 到站判定：温度超出 2~8℃ 或封条破损 → 待复检
function judgeArrival({ temperature, sealIntact }) {
  const issues = [];
  const temp = Number(temperature);
  if (!Number.isFinite(temp)) {
    issues.push('温度缺失');
  } else if (temp < TEMP_MIN || temp > TEMP_MAX) {
    issues.push(`温度越限（${temp}℃，要求 ${TEMP_MIN}~${TEMP_MAX}℃）`);
  }
  if (!sealIntact) issues.push('封条破损');
  return { issues, status: issues.length ? '待复检' : '正常' };
}

function siteLabel(site) {
  if (!site) return '未关联样点';
  return [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
}

// 交接结论里随附的样品快照，更正样点/采样时刻后按新值重建
function sampleSnapshot(bottle, site) {
  return {
    bottleId: bottle.id,
    bottleCode: bottle.bottleCode,
    sampler: bottle.sampler || '',
    sampledAt: bottle.sampledAt || '',
    siteLabel: siteLabel(site)
  };
}

// 由当前值生成复核结论；recheck 复测信息在更正重算时可保留或清空
function buildConclusion(handoff, samples, recheck = null) {
  const temp = Number(handoff.temperature);
  const tempText = Number.isFinite(temp) ? `${temp}℃` : '温度缺失';
  const sealText = handoff.sealIntact ? '封条完好' : '封条破损';
  const verdict = handoff.issues && handoff.issues.length ? `待复检：${handoff.issues.join('、')}` : '正常';
  return {
    text: `${tempText} · ${sealText} → ${verdict}`,
    samples: samples || [],
    recheck
  };
}

module.exports = { TEMP_MIN, TEMP_MAX, judgeArrival, siteLabel, sampleSnapshot, buildConclusion };
