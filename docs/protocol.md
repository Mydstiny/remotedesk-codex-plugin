# RemoteDesk AI Bridge Protocol v1

适配器 0.3.0；协议主版本 1。0.3.0 原生能力取代 0.2.0 三工具执行合同；客户端须重新握手并根据 capabilities 适配。正式请求 schema 位于 [Codex 仓库 packages/protocol](https://github.com/Mydstiny/remotedesk-codex-plugin/tree/v0.3.0/packages/protocol)。两插件共用 bridge-core，DSH 记录固定来源与 tarball 哈希。

## 传输、信任与请求

端点为 `https://<host>:<port>`，TLS ≥1.3。客户端固定邀请文件的私有 CA 并核验服务证书 SAN；业务请求使用其独立 clientAuth 证书。仅 `POST /v1/pair` 允许尚未持证的客户端，body `{code,csr,name}`，返回 `{deviceId,cert,instance}`。邀请文件 `{code,expires,ca,serverInstance}` 从可信独立渠道取得。CSR 必须证明持有对应私钥，不复制 CSR 请求的权限扩展。

`POST /v1/rpc`，Content-Type application/json。读请求 `{method,params}`，写请求 `{method,params,operationId,epoch}`。所有额外字段拒绝；方法为下表的精确字符串。ID 只允许 ASCII 字母、数字、下划线、连字符，最长 100 字节。限制按 UTF-8 字节计算，JSON body ≤800000 字节。原生协议拒绝 Origin/Sec-Fetch-Site，不能直接由普通网页 fetch 调用。

HTTP 200 读响应 `{result:<值>}`，写响应 `{operation:<回执>}`。协议校验/认证失败为 HTTP 400 `{error:<稳定错误码>}`，内部失败为 HTTP 500 INTERNAL_FAILURE；业务写操作被拒绝也可能是 HTTP 200 的 operation.status=rejected，不能只看 HTTP 状态。客户端默认 60 秒超时，超时是未知结果。

## 方法

| 方法 | params | result/operation.result |
| --- | --- | --- |
| handshake | `{version:1}` | `{version,engine,capabilities,instance,runtime,epoch:{id,device,expires},deviceId,role}` |
| project.list | `{}` | `[{id,title}]`，只有已授权项目，不暴露主机路径 |
| session.list | `{projectId,cursor?,limit?,query?,archived?}` | 无分页参数返回数组；分页返回 `{data,nextCursor}`，limit 1–100 |
| session.create | `{projectId,title?,settings?}` | `{sessionId}`；新建本插件拥有的原生会话 |
| session.read | `{sessionId,cursor?}` | `{session:{id,project,archived,title},snapshot,cursor}`；外层 cursor 是 SSE 游标，snapshot.nextCursor 是历史分页游标 |
| session.resume | `{sessionId,lease}` | `{resumed:true}`，恢复并取消归档状态 |
| session.archive | `{sessionId,lease}` | `{archived:true}`，先取消并收敛自有原生任务；Codex 调用原生 archive，DSH 保存桥接归档并卸载自有 agent；只读历史不取消归档 |
| lease.acquire | `{sessionId}` | `{lease,expires}`；写租约 90 秒，别的有效控制器获得 LEASE_BUSY |
| lease.renew | `{sessionId,lease}` | `{expires}`，建议每 30 秒续期 |
| lease.release | `{sessionId,lease}` | `{released:true}`；撤销待答审批，不取消模型任务 |
| turn.start | `{sessionId,lease,text,attachments?,settings?}` | Codex `{turnId,cancelRequested}` / DSH `{messageId,accepted:true}`；仅表示接受，不等于回合完成 |
| turn.steer | `{sessionId,lease,text}` | Codex 上游 steer 结果 / DSH `{messageId}`；仅活动回合可用 |
| turn.cancel | `{sessionId,lease}` | `{cancelRequested:true}`；等待本插件控制的执行收敛，失败时不虚报停止 |
| approval.list | `{sessionId}` | 本设备可回答的 `[{id,request,expires}]` |
| approval.answer | `{sessionId,lease,approvalId,answer}` | `{answered:true}`；命令 answer 为 `{decision:"accept"|"decline"|"cancel"}`，提问为 `{answers:{questionId:{answers:[string]}}}`；permissions 接受还需 `scope:"turn"` |
| diff.read | `{sessionId}` | Codex `{available,scope:"latest-native-turn",diff,turnId?}`；DSH `{available,scope:"native-file-tools",toolName?,callId?,arguments?,result?}`。仅原生已知变化，非完整 git diff |
| attachment.upload | `{projectId,mime,data}` | `{attachmentId}`；base64 有效期一小时 |
| model.list | `{projectId,cursor?}` | `{data,nextCursor,...}`；模型、provider、inputModalities、支持强度与默认强度 |
| session.update | `{sessionId,lease,title?,settings?}` | `{updated:true}`，保存会话设置 |
| session.items | `{sessionId,turnId,cursor?}` | 原生回合条目分页；Codex turn UUID，DSH 为 turn/start/end 的 data.turn 转字符串 |
| session.fork | `{sessionId,lease,title?,lastTurnId?}` | `{sessionId}`，从已完成历史建立独立会话 |
| session.compact | `{sessionId,lease}` | `{accepted:true}`，等待后续原生完成/失败事件；可取消 |
| terminal.list | `{sessionId,cursor?}` | `{data,nextCursor}`，仅此会话拥有的任务，processId 为原生字符串 |
| terminal.stop | `{sessionId,lease,processId}` | `{terminated:true}`，须原生确认停止；不影响其他会话 |
| operation.read | `{operationId}` | 已存在回执或 `{status:"not_found"}`；not_found 不授权重复执行 |

viewer 可读会话/事件/差异；全部写方法仅 operator。没有远程添加项目、配置 provider URL、签发邀请、任意安装扩展或编辑宿主配置的 API。这些都是本地主机管理动作。

图片支持 PNG/JPEG，文本为有效 UTF-8；每个附件 ≤512000 字节、每设备最多 20 个未过期附件、每回合最多 4 个。图片签名先在桥接层检查，再由引擎解码；模型支持度须单独确认。文本输入 ≤128000 字节。审批最多五分钟，只允许匹配 device/generation/session/lease 的单次答复。

## 会话与模型

Codex snapshot `{status,model,provider,turns,nextCursor}`，turns 使用固定版本 App Server 的完整 transcript；每页最多 20 个回合。DSH snapshot `{status,model,provider,inputModalities,events,nextCursor}`，events 为本插件会话的已过滤原生事件，每页最多 200 条。客户端不得假定两个引擎的内层消息结构相同。

settings 支持 model、reasoningEffort、permissionMode 和 collaborationMode；DSH 另支持已配置 provider，当前只公开 default 模式。Codex 支持 default/plan。以 handshake.capabilities 为准，不显示未开放的选项。标题/模型设置须先恢复归档会话并结束原生活动。

Codex 使用官方原生工具和按需审批，默认 read-only；workspace-write 允许原生沙箱内写入，不保证每次都弹窗。网络默认关闭，明确接受原生提权可能扩大宿主访问。DSH 使用 native standard 派生 preset，写/edit/shell 一次一批，读取与网络沿用宿主能力。两个引擎都不承诺容器隔离或所有 detached 进程终止。扩展/委派未开放；细节见 SECURITY。

Codex model.list 对 OpenAI 返回原生分页目录；自定义 provider 仅列本机配置的项目模型，标记 dynamicCatalog:false，不伪装成完整远程目录。DSH 按已配置 provider 查询并以短期快照分页。inputModalities/支持推理强度随模型更新；没有数据代表未知，不能当成支持或零消耗。

原生普通问题通过 approval.answer 回答；Codex delivery:async 的原生消息型问题作为普通用户明确输入，走 turn.steer 或 turn.start，不向旧 approvalId 回答，不自动启动回合。秘密输入在宿主完成。`pro.lifetime` 是未来 App 权益映射，本协议设备认证不构成购买验证。

Codex 文件审批的 `request.nativeItem` 保存完整原生 `changes/path/kind/diff`（含移动目标），`nativeItemComplete:true` 表示内容完整。客户端重连后应从 `approval.list` 恢复预览；待审批条目尚未进入原生历史，不能仅依赖 `session.read` 或旧实时事件。单条预览最多 4 MB、全服务最多 8 MB / 32 条；缺失或超限时取消该原生请求并发送 `approval.unavailable` / `NATIVE_FILE_CHANGE_PREVIEW_UNAVAILABLE`，不会截断后允许盲批。控制端断线期间保留，答复、取消或原生活动结束后清理；服务重启不复活旧审批。

## 事件流和恢复

`GET /v1/events?cursor=<外层快照cursor>&runtime=<handshake.runtime>` 使用相同 mTLS。SSE `id` 为全局递增 cursor，`data` 为 `{cursor,session,project,runtime,event}`。只发送授权项目；流会有 15 秒注释心跳。每设备最多两个流，慢客户端缓冲超过 1 MiB 断开。保留最多 2000 条/8 MiB 事件。

公共事件含原生 turn/item/status/tokenUsage、DSH user/assistant/tool/compaction 事件、approval.request/closed、execution.idle/background/blocked、snapshot.required。Codex snapshot.nativeState 保存最近收到的原生 usage/status/name；缺失即 unavailable。DSH 原生 surfaceOp replace 应按其目标替换消息，不能把压缩摘要简单追加成重复历史。

execution.background 表示仍有自有原生后台任务，项目锁保留；terminal.list/stop 可检查并停止。execution.idle 仅表示适配器观察到其原生受管理活动结束，不证明所有脱离进程或其他本地编辑器停止。execution.blocked/needs-reconciliation 表示不确定，应保留锁并按本机 recover 流程处理，不伪造成功。DSH 某个 turn/end 不是整个 Agent 的所有后续消息结束。

先握手、读快照，再从快照 cursor 订阅。快照游标在读取引擎前捕获，允许重叠事件但不能跳过间隙；按 cursor 去重，渲染仍以内层稳定 item/message ID 为准。runtime 变化、游标越界或历史清理返回 RESET_REQUIRED，需要重新握手/快照。服务重启清空旧租约；客户端必须重新取得租约，不能沿用旧审批。

## 写操作持久语义

handshake 给出服务识别的随机 epoch，最长 24 小时，绑定设备；操作接收前必须存在且未过期。客户端在发送前落盘 `{method,params,operationId,epoch}`，重试使用原包。operationId 由客户端生成 UUID，payload 指纹包括 method 和原始 params JSON 成员顺序。

服务先持久写 dispatching 再调用引擎；回执含 `operationId,status,epoch,created`，并可能有 result/error，其他存储字段可增补。状态：dispatching=尚未确认；succeeded=该控制请求成功；rejected=明确拒绝；unknown=不能证明是否已生效，需核对 transcript/差异。进程恢复把遗留 dispatching 转为 unknown，绝不自动重新派发。

相同有效 epoch/ID/原始 payload 返回旧回执；换 payload 返回 OPERATION_ID_CONFLICT。过期或不存在 epoch 返回 EPOCH_EXPIRED_RECONCILE，不因找不到回执就再执行。回执至少保留到 epoch 到期后七天；旧 epoch 清理后仍不被承认。正常断网不自动取消任务；明确取消、设备撤销和主机停服会收敛本插件拥有的执行。

## 常见错误与限制

DEVICE_UNAUTHORIZED/DEVICE_REVOKED：停止请求并让用户重新授权。PROJECT_FORBIDDEN：设备没有项目权限。LEASE_REQUIRED/LEASE_BUSY：重新协商有效控制器。APPROVAL_STALE：重新读取待处理审批，禁止重放旧答复。PROJECT_BUSY：另一 RemoteDesk 会话仍占用此项目。MODEL_IMAGE_CAPABILITY_UNDECLARED：当前模型未声明图片能力。EXECUTION_PROFILE_MISMATCH/MCP_ISOLATION_FAILED：引擎边界不满足，不能绕过。

服务总连接最多 64、并发请求最多 32、每设备最多 8、项目最多 32、会话最多 1000、单 epoch 操作最多 10000。该锁只覆盖本机两个 RemoteDesk 插件的同一规范项目路径，不能阻止用户编辑器或其他本地 Agent 同时写项目。客户端重连、租约和 idempotency 实现须在未来鸿蒙设备端另行验收。
