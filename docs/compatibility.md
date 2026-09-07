# 兼容性与验收边界

电脑端版本 **0.2.0 / protocol v1**，固定 Codex CLI **0.153.4**。Node.js 最低 22.16；OpenSSL 3；本机 Docker Linux 容器。精确组件允许列表见 [compatibility.json](../compatibility.json)，未知版本拒绝监听。源码检查与真实引擎检查的区分如下。

| 检查 | 实际执行 | 范围 |
| --- | --- | --- |
| 单元、安全及打包检查 | Windows/macOS/Linux × Node 22/24/26 | mTLS、设备撤销、租约、操作去重/过期、竞态、协议边界与打包 |
| 固定版原生引擎 | Windows/macOS/Linux、Node 22；另有本机 macOS arm64 Node 26 | 真实引擎 + 本地确定性模型响应；回合、受限工具、审批/提问、取消、历史与冷恢复 |
| 真实容器与 HTTPS 端到端 | Linux CI、macOS arm64 本机 Docker Desktop | 非 root、无网络、项目挂载、外部路径拒绝、读写、错误退出、取消与容器清理；配对、文本/图片、steer、审批接受/拒绝、事件、归档/恢复、重启、撤销 |
| 三平台用户服务 | Windows Task Scheduler / macOS launchd / Linux systemd user | 共享 bridge-core 的真实管理器安装、重复安装、状态、停止、重新启动、卸载、保留 state；额外验证延迟启动后立即停止；服务负载为隔离测试 Bridge |
| 崩溃恢复与清理失败 | Linux CI、macOS 本机 | 真实 Docker 进程在控制器 SIGKILL 后仍运行；Docker 不可用时保留写锁，恢复先确认容器停止再释放项目锁；模型已结束但容器仍运行的真实故障测试也保留锁并阻止取消成功/新回合 |
| 原生工具禁用 | 三平台原生测试 | 模型请求恰好三个 RemoteDesk 动态工具；原生 exec、MCP、浏览器、子 Agent 和额外内置工具不进入请求；恢复后仍保持 |

三平台服务测试位于 canonical [bridge-core 仓库](https://github.com/Mydstiny/remotedesk-codex-plugin/tree/v0.2.0/test)，DSH 打包相同版本和 hash 的共享核心。每次提交的结果可在 [GitHub Actions](https://github.com/Mydstiny/remotedesk-codex-plugin/actions/workflows/check.yml) 查阅。

这些测试中的模型回答是确定性测试服务，底层引擎、TLS、持久化、容器及所列系统服务均为真实组件；不涉及用户账号或付费模型调用。没有把模拟模型的输出当作云模型质量/账号验收。

Windows 的原生引擎、ACL、进程清理和任务计划已经有真实系统 CI；Windows Docker Desktop 的项目共享和 UID 1000 写入仍须在部署电脑执行文档中的冒烟验收，GitHub Windows runner 未运行 Docker Desktop Linux 容器。macOS x64/Windows arm64、无人登录启动、所有用户镜像/工具链不在已验矩阵中。

HarmonyOS App 尚未开始本次接入；手机连接、Pro 购买状态、真实双机局域网、防火墙与 RustDesk TCP 隧道由后续客户端阶段验收。本版本的参考客户端可验证电脑端协议；不能替代设备验收。原生本地 Agent 不参与 RemoteDesk 的项目写锁。
