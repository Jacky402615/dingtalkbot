# dingtalkbot D2 决策记录（decisions.md）

- Issue: #2 "Agent session layer: spawn claude, per-chat sessions + TTL resume, AI-card streaming bridge"
- 日期：2026-09-13（r1）· 评审：codex-eval `kind=options`，round 1 verdict `needs-attention`（13 项：11 项认可推荐项+强化条件已采纳；D5 记 FLAGGED-FOR-HUMAN；D12 采纳 codex 修正方向）
- 上游规格：`ops/drafts/spec/dingtalkbot-spec.md`（session `dingtalkbot`，2026-09-13 finalize）；issue 正文已定事项（per-chat 键控、TTL=60min、AI 卡模板按 ID 配置、双阈值节流、markdown 回退链、串行队列、数字选答、模型可配默认 glm-5.3-flash）不再重议。

## 探索核实（源码级/本机实测）

- **claude CLI 2.1.153 无头行为（本机实测）**：
  - `claude -p --output-format stream-json --verbose` 事件流：`system/init`（含 session_id、tools、model）→ `assistant` 消息（content blocks：text / tool_use / thinking）→ `user`（tool_result）→ `result`（含 session_id、`permission_denials` 数组）。
  - `--include-partial-messages` 追加 token 级 `stream_event` 增量（打字机数据源）。
  - `--session-id <uuid>` 可预指派；`--resume <sid>` 续会话且 session_id 稳定（banana-42 往返实测通过，模型 glm-5.3-flash 经网关可用）。
  - **`-p` 模式下 AskUserQuestion 恒被自动拒绝**（default / `--allowedTools` / `bypassPermissions` 三种姿势实测均拒绝，tool_result `is_error:"Answer questions?"`），CLI 永不等待；问题载荷可从流内 tool_use 块（及 result.permission_denials）完整恢复。
- **钉钉 AI 卡 REST 形状（官方 python SDK card_replier.py + open-dingtalk/dingtalk-card-examples 源码核实）**：
  - 创建并投放：`POST /v1.0/card/instances/createAndDeliver`，body `{cardTemplateId, outTrackId(自生成唯一 id), cardData:{cardParamMap:{<contentKey>:""}}, callbackType:"STREAM", openSpaceId, imGroupOpenDeliverModel|imRobotOpenDeliverModel}`；投放路由：群 `dtv1.card//IM_GROUP.<conversationId>` + `imGroupOpenDeliverModel:{robotCode}`；p2p `dtv1.card//IM_ROBOT.<senderStaffId>` + `imRobotOpenDeliverModel:{spaceType:"IM_ROBOT"}`。
  - 流式更新：`PUT /v1.0/card/streaming`，body `{outTrackId, guid(每次更新唯一 uuid), key:<contentKey>, content:全量累计文本, isFull:true, isFinalize, isError}`；`isFinalize=true` 自动收终（卡片转 finished 态，无需手动 flowStatus）。
  - 官方打字机示例节流为纯字节阈值（20 字符）——本 issue 要求时间+字节双阈值，严于官方示例。

## D1: claude 生成机制

**选定 (a)**：每回合一个 CLI 子进程——`claude -p <prompt> [--session-id <uuid> | --resume <sid>] --output-format stream-json --verbose --include-partial-messages --model <cfg>`，逐行解析 stdout JSONL；cwd=网关工作区根（`-r` 目录，加载该目录身份/hooks/CLAUDE.md——feishubot 同模型）；env 全量继承（网关 env 携带 ANTHROPIC_BASE_URL/凭据）。
Codex 条件（采纳）：无 shell 直接 spawn；`claude` 可执行缺失（ENOENT）响亮报错路径；`claude_bin` 可配置（默认 `claude`）。
不选 (b) SDK（新增运行时依赖、违背 "spawn claude" 与 D1 极简依赖面）；不选 (c) 常驻 stream-json 双向进程（每 chat 进程监督/崩溃恢复复杂，且实测对 AskUserQuestion 无收益）。

## D2: AskUserQuestion 桥（回合边界协议）

**选定 (a)**：流内监听 `tool_use name=AskUserQuestion` → 完整保留 questions 载荷（含 multiSelect、多 question 块）→ 抑制该回合内问题之后的 assistant 文本（问题之前的文本照常流出），卡片终态渲染编号选项列表 → 会话状态记 `pendingQuestion` → 下一条纯数字消息经 `--resume` 以结构化应答回传。
已知代价（接受）：CLI 内部自动拒绝使模型多跑一个子回合并看到一次 denial；数字应答以用户消息形式回传（非字面 tool_result 注入——headless CLI 无法注入，实测证实），AC5 语义仍满足。
不选 (b) 标记协议（依赖模型遵从、偏离 issue 表述）；不选 (c) permission-prompt-tool MCP 桥（过重）。

## D3: ack 与入队模式

**选定 (a)**：session handler 将消息推入 per-chat 串行队列后**立即返回**（adapter 快速 ack，压在 60s 重推窗口内），回合在后台跑。
Codex 条件（采纳）：入口按 `msgId` 去重（近期见过的 msgId 直接丢弃 + warn 日志，LRU 容量 500）；队列有界（见 D8）；先落队列/状态再 ack。

## D4: 会话存储

**选定 (a)**：每 chat 一个 JSON——`.bot/sessions/<sha256(chatKey) 前 16 hex>.json`，内容 `{chatKey, sessionId(uuid 由网关生成), lastActiveAt(epoch ms), pendingQuestion?}`；首回合 `--session-id`、后续 `--resume`；**TTL 判定与 lastActiveAt 更新都在消息到达时**（对用户公平：排队等待不计入 TTL——排队是网关自己的延迟）；tmp+rename 原子写；文件损坏 → warn + 弃用开新会话；`pendingQuestion` 迁移仅经串行队列（无并发写竞争）。
Codex 建议 TTL 在回合开始时判定（minor 分歧，记录不采纳：会让排队中的合法追问被判超时）。

## D5: 无头 agent 权限模式 —— FLAGGED-FOR-HUMAN

**选定 (a)**：config `agent_permission_mode` 默认 **`bypassPermissions`**（无头模式任何权限弹窗都会自动拒绝，acceptEdits 下 Bash 恒被拒=agent 残废；无人值守指挥面需要行动力，feishubot 家族同型）。
**风险标记（人工确认）**：D2 落地后、D3 访问控制前的窗口期，任何能向该钉钉应用发消息的主体都可驱动全权限 agent。缓解：启动时若 permission=bypass 打响亮 warn 日志；live-smoke runbook 明确"上线前确认应用可见范围/所在群受控"；D3 尽快跟进。codex 建议 interim 用 acceptEdits（(b)）——不采纳为默认（破坏可用性），但 `agent_permission_mode` 键支持收紧为 acceptEdits。

## D6: 卡片生命周期与回退链

**选定 (a)**：回合开始即 createAndDeliver 卡片（早反馈，inputting 态自动呈现）→ 流式更新 → 终态。
- 创建失败：本回合无卡，缓存全文，回合结束发**恰好一条** markdown 全文 + error 日志（AC4）。
- 流式更新中途失败：桥置 dead 停止更新；**尽力尝试一次** `isError` 收终（再失败仅留日志，接受残留半成品卡）；回合结束发**恰好一条** markdown 全文 + error 日志（AC4）。
- claude 侧失败/超时：卡 `isError` 收终 + 卡内短错误文案；若卡桥已 dead 则一条 markdown 错误消息。**用户可见失败通道有且一条**。
- 超长输出：卡片/流式内容累计上限 30000 字符（截断加省略标注 + warn），防 O(n²) 全量载荷与消息上限。

## D7: 节流（AC6）

**选定 (a)**：双阈值 AND——`距上次刷新 ≥ card_stream_min_interval_ms（默认 1500）` **且** `新增字节 ≥ card_stream_min_bytes（默认 64）` 才发 streamingUpdate；`isFinalize` 恒全量收终（无数据丢失）；每次 flush 落 info 日志（累计字节/间隔/本次 suppressed 次数），AC6 以日志可观察。AND 语义就是配额保护：小增量不刷（codex 提示的"小增量饿死"即设计意图，finalize 兜底）。
默认值 live 前无法证明配额余量 → 保持可配 + live-smoke 观察项（codex 信息缺口，记录）。
`--include-partial-messages` 开启（message 级事件在 tool 阶段太断续）。

## D8: per-chat 串行队列

**选定 (a) + codex 修正**：`Map<chatKey, tail-Promise>` 链式串行；**有界**——`queue_max_per_chat` 默认 10，溢出拒绝新消息：一条简短 markdown"忙线"提示 + warn（可见拒绝，不静默丢）；链尾错误 catch/finally 清理；空闲（tail 完成）后从 Map 摘除防泄漏；关停时停止收新、SIGTERM 处理中子进程、清队列。
不做磁盘持久队列（钉钉重推只覆盖 ack 前窗口；进程内队列足够 v1）。

## D9: 回合看门狗

**选定 (a)**：`agent_turn_timeout_ms` 默认 600_000；超时 → 子进程**进程组** SIGTERM → 5s 宽限 → SIGKILL（detached spawn 保证组杀覆盖 claude 的孙进程如 MCP server）→ 队列继续；用户侧按 D6 单通道收终（卡 isError 或一条 markdown）。
无看门狗 = 一次挂起饿死整个 chat 队列（DoS），必须设。

## D10: echo handler 处置

**选定 (a)**：删除 `handlers/echo.ts` 及其单测；`run.ts` 改接 session handler；**round-trip 集成测试改用 fake session handler 重写**（传输层覆盖不降级）；SPEC.md Reply 节 echo 行为条目由 D2 契约取代。
不留 config 开关回退（死配置面）。

## D11: 配置形状

**选定 (a)**：`BotConfig` 增键（全部有默认值，缺省可跑）：

```json
{
  "session_idle_ttl_minutes": 60,
  "ai_card_template_id": "",
  "card_content_key": "content",
  "model": "glm-5.3-flash",
  "agent_permission_mode": "bypassPermissions",
  "agent_turn_timeout_ms": 600000,
  "claude_bin": "claude",
  "card_stream_min_interval_ms": 1500,
  "card_stream_min_bytes": 64,
  "queue_max_per_chat": 10
}
```

`ai_card_template_id` 为空 → 启动 warn 一次 + 每回合直接走 markdown 回退（模板建好前 bot 可用、CI 可测）；数值键做正数校验（非法值 warn + 用默认）。
`card_content_key`（模板内容变量名，默认 `content`）——模板是 owner 在卡片平台建的，变量名跟随模板，留配置位。

## D12: 群 @ 前缀（修订 D1 的延后决定）

**选定 (b)（codex 修正，采纳）**：session handler 入口剥**一个**前导 bot 提及——窄正则 `^@[^\s@]+\s+` 剥一次（transport 归一层保持字节忠实不变，剥离属 D2 会话层）。
理由：群内所有消息都以 `@机器人 ...` 开头，(a) 原样透传会使 D13 的纯数字判定在群里**恒不命中**（"@bot 1"），且把传输框架噪音永久漏进模型上下文。D1 当初延后的是 echo 场景的展示性剥离；D2 的数字选答依赖它，属新约束而非翻旧案。任意 @token（非首位、多个）不动——群策略主体仍在 D3。

## D13: 数字应答语义

**选定 (a) + 补全**：存在 `pendingQuestion` 且消息（剥 @ 后）匹配 `^\d+(\s*,\s*\d+)*$` → 解析为应答：
- **单 question**（常见）：编号即选项序；`multiSelect:false` 只取首个数字，`true` 可多选（`1,3`）。
- **多 question**（罕见，工具最多 4 个）：逗号列表**按题位映射**（第 i 个数字答第 i 题）；渲染时按题分组编号并附回复格式说明。
- 越界序号 → 一条简短帮助文本（不进模型），pending 保留；非数字消息照常入队为普通回合（pending 保留至被应答或会话 TTL 过期）；新问题覆盖旧 pending。
结构化应答回传格式：`[AskUserQuestion 应答] <question>: 已选 "<labels>"`（按题逐行）。

## FLAGGED-FOR-HUMAN（人工门提示）

1. **D5 权限模式**：`bypassPermissions` 默认 + D3 未落地的暴露窗口——需 owner 确认钉钉应用可见范围受控（live-smoke runbook 步骤化），或显式改 config 收紧。
2. **D7 节流默认值**：1500ms/64B 的配额余量需 live 观察（AC6 日志位就绪后回填校准）。
3. **AI 卡模板依赖**：`ai_card_template_id` 需 owner 在钉钉卡片平台创建含 AI markdown 组件（绑定变量 `content`）的模板并导入应用；模板变量名若非 `content` 用 `card_content_key` 对齐。AC1 的活体证据以此为前置。

## 评审记录

- r1 options 评审：verdict `needs-attention`；13 项全部裁决——D1/D2/D3/D4/D6/D7/D8/D9/D10/D11/D13 认可推荐项+强化条件采纳（有界队列、进程组看门狗、sha256-16 文件名、原子写、msgId 去重、单通道失败 UX、30000 字符截断、多题按位映射、transport 测试重写）；D5 保留默认 bypass 但记 FLAGGED-FOR-HUMAN（codex interim 建议 acceptEdits，分歧已记录）；D12 采纳 codex 方向（窄剥前导 @，修订 D1 延后决定）。summary="No-ship: ... pre-access-control bypassPermissions, unbounded queueing, group numeric-prefix breakage, and incomplete AskUser lifecycle need resolution." → 四项均已在本记录裁决闭环。frontier 清空（配置小键随 D11 落定，无新开问题）。

### plan 评审引发的决策修订（r1 plan round 1 采纳）

- **runner 回调异步串行化（修订 D1/D2 实现面）**：`TurnCallbacks.onText/onQuestion` 可返回 Promise，runner 内部以串行链顺序 await、settle 前排空——修复同步回调 vs 异步 `pushText` HTTP 的乱序/越终风险。
- **runner 文本累计消息域化（修订 D1 实现面）**：跨 assistant 消息的块 index 不共享——`committed[]`（已完成消息全文）+ `current[]`（当前消息按 index），message 级覆写、delta 级追加；exit 后晚到 stdout 行经 readline close 双信号不丢；init session_id 与请求不符 warn。
- **pendingQuestion 即时落盘（修订 D4）**：onQuestion 触发时立即 `store.persist(record)`（不等回合结束）——数字应答在上一回合仍在飞时到达也能命中（到达时判定读盘）。
- **queue close 语义（修订 D8）**：`TurnQueue.close()` 拒新 + 丢弃排队未开始回合（warn）；关停序 `queue.close() → runner.killAll() → gateway.stop()`——关停后绝不 spawn 新回合。
- **D6 补全**：流更新失败后仍尽力一次 isError 收终（decisions 原文即如此，计划初稿遗漏，已对齐）；`fail(errorText, partialText)` 的 markdown 回退包含已生成部分文本（不留全文丢失）；AC6 的增量字节 = `Buffer.byteLength(本次 clamp 全文) - Buffer.byteLength(上次已刷全文)`。
- **D13 修订**：多题载荷中**任一题 multiSelect** → 数字作答不可表示，渲染即提示"用文字回复"，parse 返回 help（诚实降级）；仅全单选多题支持按位逗号映射。
- **runCommand depsOverrides 注入（修订 D10）**：`RunOverrides.depsOverrides?: Partial<AgentHandlerDeps>`——run.ts 真实装配线可被集成测试覆盖。
- **SessionStore 构造自建目录**（mkdir recursive 0700）与 `persist()` 公开化：净部署首回合不炸、回合中可即时持久化。
- **驳回一项（记录分歧）**：codex 建议移除/默认关闭 `[Context: sender/staffId/chat]` 前缀——不采纳：该前缀是 issue Proposal 明文规定（"spawn claude in the workspace dir with feishubot-style context prefix"），非计划自创。
- **plan round 1 评审**：verdict `needs-attention`（12 项：E2E 占位、回调竞态、会话声明竞态、AC6 字节语义、失败终态违约、runner 累计 bug、关停不全、多题多选不可表示、fixture 不可执行、目录引导、Context 前缀质疑）→ 11 项采纳修复入计划 round 2，1 项驳回（Context 前缀，理由如上）。

### plan 评审引发的决策修订（r1 plan round 2 采纳）

- **TurnResult 拆分**：`{ ok, outputText, errorText, durationMs }`——部分文本与失败原因分列；`bridge.fail(errorText, outputText)` 双参。
- **同消息 text→tool_use 保序**：runner 按块序扫描，问题前文本先 enqueue 再拦截 questionSeen。
- **message.id 防御回退**：id 缺失时每个 assistant 事件视为新域（id 存在性已实测，回退仅防御）。
- **exit/close 收尾**：双信号 + 2s 兜底定时器（close 丢失不吃回合超时预算）；spawn 同步 throw 路径 TDZ 安全。
- **回调抛错响亮**：runner 的 emit 链 catch 落 error 日志（不静默），不使回合失败。
- **killAll 升级**：TERM → killDelayMs → KILL，且置 closed 拒新 run；关停序 `queue.close → runner.killAll → gateway.stop`，`signalHook` 注入使关停序可测。
- **回合 job 盘面真值**：job 开始 `store.load(chatKey)` 重读，pendingQuestion 继承盘面（到达时快照不覆写后续持久化）；应答成功才清 pending；`!ok` 清 pending；`!ok && !resume` → `store.delete(chatKey)` 作废幽灵会话。
- **回合 job 整体 try/catch**：异常 → `bridge.fail` 兜底（卡不悬挂）后 rethrow。
- **桥 fail 的 isError finalize 失败 → markdown 兜底**（任何卡失败路径都有用户可见终态）。
- **AC1 集成测试修复**：assemble 默认 `aiCardTemplateId:'tpl-9'`，断言 create/finalize 精确载荷；run.test.ts 增装配线与关停序两用例。
- **plan round 2 评审**：verdict `needs-attention`（11 项）→ 全部采纳修复入计划 round 3（本轮为修订轮，round 3 为终审轮）。

### plan 评审引发的决策修订（r1 plan round 3 采纳——评审预算终轮后落地）

- **runner 累计三态定稿**：`committedText` + `inflightAuthoritative`（权威全文）+ `inflightPartial`（delta 累计）分离——权威**替换** partial 而非提交，消除 delta 误提交/文本重复；同消息 text→tool_use 保序且不双发快照。
- **超时收尾确定性**：TERM → killDelay → KILL **完成后**才 settle（escalation 序列对测试确定）；`killAll` 置 closed 拒新 run。
- **AC6 日志三要素**：flush 日志 `bytes/delta/intervalMs/suppressed`（间隔字段补齐）。
- **SessionStore 盘面合并**：`persist/endTurn` 的 `lastActiveAt = max(record, 盘面)`（旧在飞回合不倒拨 TTL）；新增跨实例（网关重启）resume 测试（AC2 重启面）。
- **应答/新题竞态防御**：应答回合携带 `answeredToolUseId`，job 开始时对盘面重验——不匹配则降级为普通消息；仅 `ok && 仍匹配` 才清 pending。
- **测试异步边界保真**：fakeRunner/scriptedRunner `await` 脚本与回调返回的 Promise；handler 测试经 `queue.waitIdle(chatKey)`（新接口）确定性等回合完成，替代裸定时器。
- **关停测试落地**：`signalHook` 收敛为观察者（直接交付真实 shutdown 处理器），测试调用并断言 `queue.close → runner.killAll` 序 + 排队回合不 spawn。
- **plan round 3 评审**：verdict `needs-attention`（8 项）→ 评审预算（3 轮）已尽，8 项全部在计划内修复（本节即修订记录），未再跑第 4 轮 codex；残余把关移交执行轮 code-review 与 Human-Review 人工门（D1 同收口姿势）。
