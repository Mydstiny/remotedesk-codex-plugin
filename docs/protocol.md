# RemoteDesk AI Bridge Protocol v1

适配器 0.2.0；协议主版本 1。正式请求 schema 位于 [Codex 仓库 packages/protocol](https://github.com/Mydstiny/remotedesk-codex-plugin/tree/v0.2.0/packages/protocol)。两插件共用 bridge-core，DSH 记录固定来源与 tarball 哈希。

## 传输、信任与请求

端点为 `https://<host>:<port>`，TLS ≥1.3。客户端固定邀请文件的私有 CA 并核验服务证书 SAN；业务请求使用其独立 clientAuth 证书。仅 `POST /v1/pair` 允许尚未持证的客户端，body `{code,csr,name}`，返回 `{deviceId,cert,instance}`。邀请文件 `{code,expires,ca,serverInstance}` 从可信独立渠道取得。CSR 必须证明持有对应私钥，不复制 CSR 请求的权限扩展。

`POST /v1/rpc`，Content-Type application/json。读请求 `{method,params}`，写请求 `{method,params,operationId,epoch}`。所有额外字段拒绝；方法为下表的精确字符串。ID 只允许 ASCII 字母、数字、下划线、连字符，最长 100 字节。限制按 UTF-8 字节计算，JSON body ≤800000 字节。原生协议拒绝 Origin/Sec-Fetch-Site，不能直接由普通网页 fetch 调用。

HTTP 200 读响应 `{result:<值>}`，写响应 `{operation:<回执>}`。协议校验/认证失败为 HTTP 400 `{error:<稳定错误码>}`，内部失败为 HTTP 500 INTERNAL_FAILURE；业务写操作被拒绝也可能是 HTTP 200 的 operation.status=rejected，不能只看 HTTP 状态。客户端默认 60 秒超时，超时是未知结果。

## 方法

| 方法 | params | result/operation.result |
| --- | --- | --- |
| handshake | `{version:1}` | `{version,engine,capabilities,instance,runtime,epoch:{id,device,expires},deviceId,role}` |
| project.list | `{}` | `[{id,title}]`，只有已授权项目，不暴露主机路径 |
| session.list | `{projectId}` | `[{id,project,archived,title}]` |
| session.create | `{projectId,title?}` | `{sessionId}`；新建本插件拥有的原生会话 |
| session.read | `{sessionId,cursor?}` | `{session:{id,project,archived,title},snapshot,cursor}`；外层 cursor 是 SSE 游标，snapshot.nextCursor 是历史分页游标 |
| session.resume | `{sessionId,lease}` | `{resumed:true}`，恢复并取消归档状态 |
| session.archive | `{sessionId,lease}` | `{archived:true}`，先取消并收敛活动任务，再卸载本插件引擎 handle；保留历史 |
| lease.acquire | `{sessionId}` | `{lease,expires}`；写租约 90 秒，别的有效控制器获得 LEASE_BUSY |
| lease.renew | `{sessionId,lease}` | `{expires}`，建议每 30 秒续期 |
| lease.release | `{sessionId,lease}` | `{released:true}`；撤销待答审批，不取消模型任务 |
| turn.start | `{sessionId,lease,text,attachments?}` | Codex `{turnId,cancelRequested}` / DSH `{messageId,accepted:true}`；仅表示接受，不等于回合完成 |
| turn.steer | `{sessionId,lease,text}` | Codex 上游 steer 结果 / DSH `{messageId}`；仅活动回合可用 |
| turn.cancel | `{sessionId,lease}` | `{cancelRequested:true}`；等待本插件控制的执行收敛，失败时不虚报停止 |
| approval.list | `{sessionId}` | 本设备可回答的 `[{id,request,expires}]` |
| approval.answer | `{sessionId,lease,approvalId,answer}` | `{answered:true}`；命令 answer 为 `{decision:"accept"|"decline"|"cancel"}`，提问为 `{text}` |
| diff.read | `{sessionId}` | `{exitCode,stdout,stderr}`，容器内 git diff，不执行外部 diff/textconv/hooks |
| attachment.upload | `{projectId,mime,data}` | `{attachmentId}`；base64 有效期一小时 |
| operation.read | `{operationId}` | 已存在回执或 `{status:"not_found"}`；not_found 不授权重复执行 |

viewer 可读会话/事件/差异；全部写方法仅 operator。没有远程添加项目、配置 provider URL、签发邀请、创建任意 Docker 镜像或扩大宿主权限的 API。这些都是本地主机管理动作。

图片支持 PNG/JPEG，文本为有效 UTF-8；每个附件 ≤512000 字节、每设备最多 20 个未过期附件、每回合最多 4 个。图片签名先在桥接层检查，再由引擎解码；模型支持度须单独确认。文本输入 ≤128000 字节。审批最多五分钟，只允许匹配 device/generation/session/lease 的单次答复。

## 会话与模型

Codex snapshot `{status,model,provider,turns,nextCursor}`，turns 使用固定版本 App Server 的完整 transcript；每页最多 20 个回合。DSH snapshot `{status,model,provider,inputModalities,events,nextCursor}`，events 为本插件会话的已过滤原生事件，每页最多 200 条。客户端不得假定两个引擎的内层消息结构相同。

Codex 只提供 RemoteDesk 受限配置的三项动态工具；DSH 对本插件创建的 Agent 提供相同工具，并保持现有本地 Agent 不变。命令均为 project Docker：无网络、无宿主其他路径、逐次审批。创建会话时保存 provider/model，不让远端请求指定 endpoint/密钥。`pro.lifetime` 是未来 App 的权益映射，本协议的设备认证不构成购买验证。

## 事件流和恢复

`GET /v1/events?cursor=<外层快照cursor>&runtime=<handshake.runtime>` 使用相同 mTLS。SSE `id` 为全局递增 cursor，`data` 为 `{cursor,session,project,runtime,event}`。只发送授权项目；流会有 15 秒注释心跳。每设备最多两个流，慢客户端缓冲超过 1 MiB 断开。保留最多 2000 条/8 MiB 事件。

公共事件含本引擎 model/tool/turn 事件、`approval.request`（approvalId/request/expires）、`approval.closed`、`execution.idle`、`snapshot.required` 和 `persistence.failed`。UI 按事件更新展示；未知新增类型应忽略并保留快照刷新能力。只有 execution.idle 表示本插件执行已收敛；不要把某一个 DSH turn/end 当作整个 Agent 的所有追加消息结束。

先握手、读快照，再从快照 cursor 订阅。快照游标在读取引擎前捕获，允许重叠事件但不能跳过间隙；按 cursor 去重，渲染仍以内层稳定 item/message ID 为准。runtime 变化、游标越界或历史清理返回 RESET_REQUIRED，需要重新握手/快照。服务重启清空旧租约；客户端必须重新取得租约，不能沿用旧审批。

## 写操作持久语义

handshake 给出服务识别的随机 epoch，最长 24 小时，绑定设备；操作接收前必须存在且未过期。客户端在发送前落盘 `{method,params,operationId,epoch}`，重试使用原包。operationId 由客户端生成 UUID，payload 指纹包括 method 和原始 params JSON 成员顺序。

服务先持久写 dispatching 再调用引擎；回执含 `operationId,status,epoch,created`，并可能有 result/error，其他存储字段可增补。状态：dispatching=尚未确认；succeeded=该控制请求成功；rejected=明确拒绝；unknown=不能证明是否已生效，需核对 transcript/差异。进程恢复把遗留 dispatching 转为 unknown，绝不自动重新派发。

相同有效 epoch/ID/原始 payload 返回旧回执；换 payload 返回 OPERATION_ID_CONFLICT。过期或不存在 epoch 返回 EPOCH_EXPIRED_RECONCILE，不因找不到回执就再执行。回执至少保留到 epoch 到期后七天；旧 epoch 清理后仍不被承认。正常断网不自动取消任务；明确取消、设备撤销和主机停服会收敛本插件拥有的执行。

## 常见错误与限制

DEVICE_UNAUTHORIZED/DEVICE_REVOKED：停止请求并让用户重新授权。PROJECT_FORBIDDEN：设备没有项目权限。LEASE_REQUIRED/LEASE_BUSY：重新协商有效控制器。APPROVAL_STALE：重新读取待处理审批，禁止重放旧答复。PROJECT_BUSY：另一 RemoteDesk 会话仍占用此项目。MODEL_IMAGE_CAPABILITY_UNDECLARED：当前模型未声明图片能力。EXECUTION_PROFILE_MISMATCH/MCP_ISOLATION_FAILED：引擎边界不满足，不能绕过。

服务总连接最多 64、并发请求最多 32、每设备最多 8、项目最多 32、会话最多 1000、单 epoch 操作最多 10000。该锁只覆盖本机两个 RemoteDesk 插件的同一规范项目路径，不能阻止用户编辑器或其他本地 Agent 同时写项目。客户端重连、租约和 idempotency 实现须在未来鸿蒙设备端另行验收。
