# 林下设施面积闸门

面向森林康养等林下产业的生产服务设施占用林地面积管控服务。管理宗地许可、分期方案、测绘图斑版本、现场核验与整改闭环，在**作出任何批准承诺前**计算累计占用与剩余空间，阻断图斑重叠、分期累计超额、撤回重报漏洞、测绘版本覆盖、共用设施重复计面与并发双岗放行。

## 运行

- `npm test`：运行全部领域闸门测试（11 项）。
- `npm start`：启动 HTTP 服务，`GET /health` 确认状态。
- 业务入口：`POST /api/commands`，请求体 `{ "command": "...", "payload": { ... } }`。

## 命令清单

| 命令 | 作用 |
| --- | --- |
| `parcel.register` / `parcel.ledger` | 登记宗地许可 / 查询累计占用台账与剩余空间 |
| `project.register` | 项目落宗地（支持同宗地多项目） |
| `survey.submit` / `survey.supersede` / `survey.invalidate` | 提交测绘版本 / 标记被新图纸取代 / 作废（批准锁定后两者均被拒） |
| `plan.submit` / `plan.withdraw` / `plan.evaluate` | 分期方案提交（冻结图斑版本）/ 撤回 / 闸门试算 |
| `plan.decide` | 双岗审批：两名不同审批人放行方可生效，驳回即驳回 |
| `inspection.record` | 现场核验，实测偏离批准图纸即转整改 |
| `rectification.open` / `rectification.close` | 整改立项与闭环，闭环后恢复批准效力 |

## 闸门阻断项

`plan.evaluate` / `plan.decide` 返回 `blockers`：

- `spatial_conflict`：与已批准或其他待决图斑内相交（共用设施、边界相接除外）。
- `quota_exceeded`：已批准 + 待决 + 本方案累计超出宗地许可面积。
- `survey_version_invalidated`：方案冻结的测绘版本已作废。

领域规则见 [`docs/domain.md`](docs/domain.md)，完整行为示例见 `test/gate.test.mjs`。
