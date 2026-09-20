# 林下设施面积闸门

集体林权改革场景下，森林康养木屋等项目取得权属凭证后，用于管控生产服务设施占用林地面积的闸门服务：管理宗地许可、分期方案、测绘图斑版本、现场核验与整改闭环，在任何批准承诺前计算累计占用与剩余空间，阻断图斑重叠、撤回重报误用、测绘版本过期、共用设施重复计面与双审批人放行后的超额结果。

## 运行

- `npm test`：运行 20 个领域与场景测试（几何计算、闸门规则、联合审查会）。
- `npm start`：启动 HTTP 服务，`GET /health` 确认状态（默认端口 3000，`PORT` 可改）。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/parcels` | 登记宗地许可（总面积、核验容差） |
| GET | `/parcels/:id/occupancy` | 累计占用、剩余空间与逐方案明细（含采用的图斑版本） |
| GET | `/parcels/:id/joint-review` | 联合审查：在途方案空间冲突核对 + 按提交顺序串行可批性 |
| POST | `/projects` | 登记项目（归属宗地） |
| POST | `/surveys` | 登记测绘批次 |
| POST | `/surveys/:id/versions` | 新增图斑版本（精度变化；新版本自动成为当前版本） |
| POST | `/plans` | 提交分期方案（期号、设施图斑、可声明前版、共用项目） |
| POST | `/plans/:id/withdraw` | 撤回在途方案 |
| GET | `/plans/:id/evaluation` | 单方案闸门评估（版本时效、空间冲突、可批面积） |
| POST | `/plans/:id/approvals` | 审批人放行（两名不同审批人；闸门不过即驳回） |
| POST | `/plans/:id/verification` | 现场核验（实测图斑比对，超差进入整改） |
| POST | `/plans/:id/rectifications` | 提交整改复测 |
| POST | `/plans/:id/rectification/resolve` | 整改闭环判定（含按实测面积重算闸门） |
| GET | `/events` | 只追加事件账本全量 |

## 设计要点

- **事件溯源**：所有决定只追加事件（`src/core.mjs` 的 `InMemoryEventStore`），当前状态由事件流归约；历史批准保留图斑版本快照，不会被新图纸覆盖。
- **承诺前算账**：`evaluatePlan` / `evaluateJointReview` 在请求时刻重算累计占用；联合审查按事件序号确定的提交顺序串行放行，防止分阶段累计悄悄越界。
- **几何计算**：`src/geometry.mjs` 提供凸多边形图斑面积、重叠面积与越界面积（Sutherland–Hodgman 裁剪）。

领域规则见 [`docs/domain.md`](docs/domain.md)。
