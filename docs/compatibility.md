# 兼容性与验证边界

2026-09-07：适配器 0.1.0-alpha.1；Codex CLI 0.153.4；macOS arm64；Node 26.4.0。机器可读允许列表见 [compatibility.json](../compatibility.json)。Node 22/24/26 的 GitHub CI 仅验证源码测试，真实引擎矩阵另计。

| 检查 | 证据 | 未证明的内容 |
| --- | --- | --- |
| initialize / initialized | 本机真实 App Server 通过 | 登录和模型额度 |
| 临时 thread/start | 上游返回 readOnly / untrusted / user；通过 | 实际 shell/MCP/文件/子 Agent 限制 |
| stdio 请求关联、UTF-8 分帧、超时/退出/限额 | 合成子进程测试 | 网络、磁盘持久化和真实模型回合 |
| 服务端审批请求 | 合成请求一律返回不支持；通过 | 真实审批 UI、拒绝/允许/晚到答复与 Codex 工具调用 |
| 会话恢复、回合完成/取消、差异 | 未测 | 不能作为能力开放 |

本次通过 CLI 生成的官方 schema 核对 thread/read、turn/start、turn/steer、turn/interrupt 与审批类型；schema 存在不表示已经实现适配。只保留关键接口来源/哈希，不复制整个生成目录。

不能将项目 cwd 或桥接项目白名单视为执行隔离。正式运行前需要证明引擎工具、shell、MCP、子进程和子 Agent 的实际可读写及联网范围，以及默认配置不会导入不受限制的工具出口。

AI0 仍在进行；AI1 TLS 配对与协议尚未交付。当前源代码不得被宣称为已可连接的付费功能。
