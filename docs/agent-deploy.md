# 用户 Agent 操作流程：Codex

当前版本：0.1.0-alpha.1 / AI0，仅部署源码诊断工具，不能部署可远程访问的 AI 服务。

## 可复制给 Agent 的任务

> 请读取 Mydstiny/remotedesk-codex-plugin 中维护者指定的固定提交及 docs/agent-deploy.md，准备并检查当前 AI0 诊断工具。先核验来源和版本，再在临时目录校验源码、运行测试和 doctor，记录脱敏结果。不要开启监听、替换现有问答接收器、修改账号或使用浮动远程 shell。若目标是鸿蒙配对，请明确报告当前尚未实现，而不要把 doctor 成功当作配对完成。

## 必须遵守的流程

1. 从可信的维护者交付记录取得完整 commit SHA，确认仓库 owner 为 `Mydstiny`；私有仓库需要用户已有的 GitHub 访问权。不得索取或打印 token。
2. 获取该提交到临时目录并核对 `git rev-parse HEAD`。当前没有发布包、签名安装器或 release；不要虚构下载地址。GitHub 提交与同源 checksum 只是来源/完整性线索，不能宣称独立签名认证。
3. 阅读 `compatibility.json`、`docs/compatibility.md`、`package.json` 和待执行脚本。当前包没有 npm 安装依赖或 install hooks，不需要全局 npm 安装。
4. 运行 `npm test`、`npm pack --dry-run --ignore-scripts`、`node bin/remotedesk-codex.mjs doctor --json`。检查每条 `checks`，不能只检查可执行文件存在。DSH 还必须检查各解析组件的版本。
5. 按 [操作文档](operations.md) 执行已授权的本地探针。Codex 探针创建临时只读会话，可能触发引擎自己的缓存/日志；DSH 原生测试使用合成会话，不读取用户 profile 或会话。
6. 记录命令、退出码、版本、通过项与未测项。`status=ok` 只证明被执行的诊断；`capabilities.remoteAccess=false` 是明确的未开放状态。
7. 测试结束即退出进程；当前没有后台服务、开机启动、防火墙变化或配对数据。清理仅限本次创建的临时副本，保留用户 AI 安装及账号。

退出码：0 表示当前诊断通过，2 表示环境/兼容/探针阻塞，64 表示参数错误。非零结果禁止自动绕过版本检查或反复重试未决写操作。

## 后续版本才有的流程

正式版本会增加带来源验证的安装/升级/回滚、设备配对、监听范围、项目选择、停止和卸载命令。当前不提供 install/start/pair/upgrade 命令；不能用手工暴露官方引擎端口代替。
