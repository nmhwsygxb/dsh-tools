# dsh-tools — DeepSeek Harness 工具包（一键安装，自选组件）

给 DeepSeek Harness（DSH）扩展的一组宿主插件：**远程执行、执行前自动审核、GitHub、联网研究、本地 git 发布、沙箱逃生、Bug 知识库、Blender 3D、上下文压缩、自愈启动器**。

每个工具独立隔离，安装时**自己选要装哪些**；需要凭据的工具（GitHub、远程机器）在安装过程中由你输入，**包内不含任何作者个人信息**。

---

## 快速开始（30 秒）

1. 下载本仓库 zip，解压（或直接 Clone）
2. 双击 `install.bat`
3. 按菜单输入要安装的工具序号（如 `1,2,3` 或 `all`）
4. 按提示输入工作区路径、以及（如选了对应工具）GitHub Token / 远程机器 IP·端口·令牌
5. 重启 dsh，工具生效

> 也可以把下载的 `.zip` 或解压后的**文件夹**直接拖到 `install.bat` 图标上，自动解压并进入安装。

## 组件清单

| # | 组件 | 说明 | 装后的工具 |
|---|------|------|-----------|
| 1 | **remote-exec 远程执行** | 在远程机器执行命令 / 上传文件（需远程机器运行 `remote-agent-server.js`） | `remote_exec` `remote_info` `remote_ping` |
| 2 | **self-review 执行前自动审核** | AI 执行程序前自动做静态危险扫描（safe/caution/danger）+ 审计日志；审批关闭/完全权限下也生效 | `self_review` |
| 3 | **github-manager** | 13 个 GitHub 工具（仓库/Issue/PR/文件/搜索） | `gh_*` |
| 4 | **web-research 联网研究** | 搜索 / 抓网页 / 论文检索·下载 | `wr_*` |
| 5 | **git-publish 本地发布** | commit + 自动递增版本号 + 推本地 git 远程 | `git_publish` `git_repo_status` |
| 6 | **sandbox-escape 沙箱逃生** | 带审批门控的宿主级命令执行 + 沙箱状态查询 | `sandbox_escape` `sandbox_status` |
| 7 | **bug-tracker Bug 知识库** | 跨会话 bug 建档 / 根因 / 修复全生命周期 | `bug_*` |
| 8 | **blender 3D 控制** | 建模 / 渲染 / 导出（需本机 Blender） | `blender_*` |
| 9 | **ctx-compact 上下文压缩** | 长会话自动压缩阈值（默认 200k tokens） | — |
| 10 | **auto-heal 自愈启动器** | 内核检查 + 故障插件自动禁用继续启动 | `node auto-heal.js` 启动 |

## 安装行为说明

- 插件 JS 复制到 `%USERPROFILE%\.dsh\profiles\<profile>\`（默认 `web`，可用 `-ProfileName` 指定）
- 生成/合并该目录下的 `cordis.patch.yml`；**已有配置先备份**（`cordis.patch.yml.bak-时间戳`）
- 公共配置会写入 patch：工作区根 `workspaceRoot`、bug 数据目录 `dataDir`、远程机器 `host/port/token`
- 需要重启 dsh（配置在启动时加载）
- 全程无需管理员权限；卸载 = 删掉 profile 里对应 js + 注释掉 patch 行即可

### 常用参数（install.bat 内也可改）

```powershell
# 交互式
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# 全装，跳过菜单
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Tools all

# 只装远程执行 + 自审，指定 profile 与工作区
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -Tools 1,2 -ProfileName web -WorkspaceRoot "D:\work"
```

## 需要凭据的组件

| 组件 | 凭据 | 安装时 | 运行时 |
|------|------|--------|--------|
| github-manager | GitHub PAT | 输入后存 `profile\github-token.txt` 供复制 | 在 dsh 对话里运行 `gh_set_token` 粘贴一次（存 dsh 凭据存储） |
| remote-exec | 远程 token | 输入后写入 patch `config.token` | 远程 agent 用 `--token` 或环境变量 `REMOTE_TOKEN` 启动 |

## 远程端部署（组件 1）

远程机器（被控制端）运行独立脚本 `tools/01-remote-exec/remote-agent-server.js`（零依赖、纯 Node）：

```bash
# 在远程机器
node remote-agent-server.js --port 3788 --token mysecret
# 可选：限上传目录
node remote-agent-server.js --port 3788 --token mysecret --allow-dir D:\uploads
```

端点为 `GET/POST /exec`、`/upload`、`GET /logs`、`/ping`、`/info`；每次执行都写入 `remote-agent-audit.log`，日志中的 token 一律脱敏。

> 注意：`remote-agent-server.js` 允许在远程机器上执行任意命令，**务必设置强 token 且不要暴露到公网**。

## 目录结构

```
dsh-tools/
├── install.bat          双击 / 拖拽安装入口
├── install.ps1          安装主脚本（自选组件 + 凭据交互）
├── README.md
└── tools/
    ├── 01-remote-exec/    remote-agent.js（宿主端）+ remote-agent-server.js（远程端）
    ├── 02-self-review/    self-review.js
    ├── 03-github/         github-manager.js
    ├── 04-web-research/   web-research.js
    ├── 05-git-publish/    git-publish.js
    ├── 06-sandbox-escape/ sandbox-escape.js
    ├── 07-bug-tracker/    bug-tracker.js
    ├── 08-blender/        blender.js
    ├── 09-ctx-compact/    ctx-compact.js
    └── 10-auto-heal/      auto-heal.js（启动器，配合 install 使用）
```

## 隐私与安全

- 所有插件源码**不含作者个人目录 / IP / Token / 会话 ID**；默认值均为通用占位（如远程 host 默认 `127.0.0.1`）
- 需要凭据的工具在**安装时由你输入**，不写入仓库
- 也有 `self-review`（组件 2）：AI 每次执行有副作用命令前先自审并留审计日志，避免误删/误格式化
- `git-publish` 默认**不推公网**、不自动 init，避免误操作

## 要求

- Windows + 已安装 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（`dsh` 命令可用）
- PowerShell 5.1+（Windows 自带）
- 组件 8 需本机安装 Blender
- 组件 1 需目标机器有 Node.js