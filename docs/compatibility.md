# 兼容性与验证

版本 **0.3.0 / protocol major 1**，Codex **0.153.4**；Node.js 22.16+、OpenSSL 3。精确组件门见 [compatibility.json](../compatibility.json)。使用原生沙箱，无容器运行时依赖。

| 检查 | 覆盖 |
| --- | --- |
| 源码 CI | Windows/macOS/Linux，Node 22/24/26；协议、mTLS、授权、状态、路径和生命周期回归 |
| 原生引擎 CI | 固定官方引擎与本地固定模型；原生工具、审批、问答、模型/强度、取消、历史、分叉和压缩/终端管理 |
| 服务/安装 | 当前用户服务生命周期；DSH 原生 packed bundle 安装含空格和 & 路径 |
| 本机真实模型 | 部署后独立记录所选 provider/model、实际命令/文件结果、重启和取消；固定响应测试不能替代 |

每次提交的实际通过状态以该 commit 的 GitHub Actions 为准。macOS 本机固定模型探针和独立复核涵盖迟到答复、原生权限、撤权、背景续跑/锁、创建关闭竞态与未知恢复。DSH 完整 dedicated/web profile 测试另运行 `test/profile-runtime.mjs`。

原生读取/网络/后台进程限制见 SECURITY。Windows DSH 上游写隔离是 partial；Codex 固定使用原生 unelevated Windows sandbox，不自动配置管理员 sandbox。macOS x64、Windows arm64、无人登录启动、任意用户扩展/工具链不属于默认已验矩阵。

HarmonyOS UI、设备证书存储、真实双机 LAN、设备断线重连、Pro 权益和 RustDesk 传输仍需独立端侧验收。服务 ready、CI 通过、真实宿主模型可用是不同证据；发布说明记录实际完成范围。
