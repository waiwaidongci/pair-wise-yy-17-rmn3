# 钟乳石洞穴微环境巡测

围绕洞穴、分区、样点和巡测路线记录微环境数据，发现异常后生成复查闭环；水样冷箱转运逐站登记交接，断链可定位到具体交接。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3912

数据保存在`data/db.json`，后续可以继续增量迭代。

## 冷链转运

- 样品瓶绑定样点与采样员；同一冷箱存在未结束转运时，不能装别批样品。
- 到站登记温度、接收人、封条：温度超出 2-8℃ 或封条破损即转待复检，须由另一位巡测员复测；复测结论按温度、封条与采样到到站时长（按样点敏感等级限时）判定。
- 采样时刻、样点或封条更正后，关联复核结论按新值重算并生成新版本，旧版本标记“已更正”仍可查询。
- 等待列表按等待时间排序，可看到每瓶样到了哪一站、哪次交接有问题。

接口（判定、存档与页面数据分别承载）：

- `GET /api/coldchain/board` 等待列表
- `POST /api/coldchain/transports` 装箱发运
- `POST /api/coldchain/transports/:id/handoffs` 到站登记（判定）
- `POST /api/coldchain/handoffs/:id/reviews` 复测结论
- `PATCH /api/coldchain/bottles/:id/correct` 更正采样时刻/样点
- `PATCH /api/coldchain/handoffs/:id/correct` 更正封条
- `POST /api/coldchain/transports/:id/archive` 存档结束转运
