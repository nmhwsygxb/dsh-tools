<div align="center">

# 🧰 dsh-tools

**DeepSeek Harness 工具套餐 · 自选组件 · 一键安装**

为 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 扩展的一套宿主插件：
远程执行 · 执行前自动审核 · GitHub · 联网研究 · 本地 Git 发布 · 沙箱逃生 · Bug 知识库 · Blender 3D · 上下文压缩 · 自愈启动

![Version](https://img.shields.io/badge/版本-v1.0.0-2ea44f)
![Components](https://img.shields.io/badge/组件-10-1f6feb)
![Platform](https://img.shields.io/badge/平台-Windows-0078d6)
![License](https://img.shields.io/badge/许可-MIT-8250df)
![Privacy](https://img.shields.io/badge/隐私-零个人信息-e2e2e2)
![Security](https://img.shields.io/badge/安全-修复通过-31c754)
![DSH](https://img.shields.io/badge/实测_dsh-0.1.2--rc.1-6f42c1)

**拖进来，选一选，装好就能用。**

</div>

---

## ✨ 特性

| | |
|---|---|
| 🧩 **组件独立** | 10 个工具相互解耦，安装时自由勾选，绝不多装 |
| 🚀 **一键安装** | 双击 `install.bat`，或把 zip / 文件夹直接拖到图标上 |
| 🔐 **凭据安全** | GitHub / 远程机器凭据在安装时**你亲自输入**，仓库零泄露 |
| 🧼 **干净无痕** | 所有插件已去除个人目录、IP、Token、会话 ID |
| 📦 **零依赖** | 插件均为纯 JS，远程 agent 也是单文件纯 Node |
| ♻️ **可回滚** | 安装自动备份原 `cordis.patch.yml`（`.bak-时间戳`） |

---

## 🛠️ v1.0.1 更新（安全加固 + Bug 修复）

本次 QA 审查修复了 26 项问题，包括：

- **🔴 高危修复**：远程 agent 未设 token 时不再默认全开放（fail-closed，403 拒绝 `/exec`/`/upload`/`/logs`）；Blender 代码执行默认开启受限模式（`restrictedMode: true`）；`auto-heal` 自动禁用插件改为**默认关闭**（需 `--heal-auto-disable` 显式开启，防误判禁用健康插件）
- **🟡 中危修复**：Blender 会话 `delete`/`reset` 必须 `confirm: true`；GitHub 公开仓库只读（读文件/列表/下载）无需 token；Bing 搜索 URL 解码修复；`install.ps1` YAML 注入转义 + 安装器纯英文防乱码
- **🟢 细节修复**：>1MB 文件读取提示、`per_page` 参数钳制、路径归一化等

> 完整审计报告见 [CHANGELOG](#-changelog)。

---

## 🚀 安装方式一：dsh plugin add 一键安装（标准 dsh bundle，推荐）

本仓库是**标准 dsh 插件包**（`package.json` 声明 `dsh.bundle`），dsh 官方插件安装器直接支持：

```bash
# 一条命令装全部 9 个 host 工具插件
dsh plugin --profile web add github:nmhwsygxb/dsh-tools

# 或简写（默认 web profile）
dsh plugin add github:nmhwsygxb/dsh-tools
```

> ⚠️ **前置条件**：需要 [pnpm](https://pnpm.io/) 在 PATH 上（`dsh plugin` 是 pnpm 转发器，缺 pnpm 会报 `pnpm not found`）。本包无 prepare 脚本，通常不会触发 pnpm 的 allowBuilds 拦截；若 pnpm 提示构建脚本被阻止，按提示把仓库名加入 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后重试。

安装流程（已在本机 0.1.2-rc.1 端到端验证）：

1. pnpm 从 GitHub 拉取仓库并装入 `profile/node_modules/dsh-tools`
2. dsh 检测到 `dsh.bundle.patch` 声明，自动把 `dsh-tools` 加入 `dsh.profile.bundles` 层栈
3. 启动 dsh 时加载 `cordis.patch.yml`，9 个工具插件（remote-agent / self-review / github-manager / web-research / git-publish / sandbox-escape / bug-tracker / blender / ctx-compact）全部注册
4. 重启 dsh，完成 🎉

> 💡 不需要的组件：编辑 `profile\node_modules\dsh-tools\cordis.patch.yml`，删掉对应的一行 `insert` 后重启。
> 💡 凭据（GitHub token / 远程 host·port·token）安装后运行 `gh_set_token` 或编辑 patch 的 `config` 段填入。
> 💡 **建议配置 `workspaceRoot`**（bundle 方式不会自动填）：web-research 下载 / github 文件 / bug-tracker 数据 / git-publish 仓库 等默认用 dsh 启动目录，可能不是你的工作区。编辑 patch 给对应插件加 `workspaceRoot: <你的工作区路径>`，如 `D:\work`（YAML 字符串引号包裹）。

## 🚀 安装方式二：拖拽安装（install.bat，可自选组件）

```bash
# 获取工具包
git clone https://github.com/nmhwsygxb/dsh-tools.git
# 或者直接下载 zip 解压
```

然后**双击 `install.bat`**，按提示：

1. 输入要安装的组件序号（如 `1,2,3` 或 `all`）
2. 填写工作区根路径
3. 如选了 GitHub / 远程执行，按提示输入凭据
4. 重启 dsh，完成 🎉

> 💡 也支持把下载的 `.zip` 或解压后的文件夹**直接拖到 `install.bat` 图标上**，自动解压安装。
> 💡 两种安装方式等价：`dsh plugin add` 装全部 9 个插件；`install.bat` 可勾选子集 + 交互填凭据。

### 命令行方式

```powershell
# 交互式
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# 全装，跳过菜单
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Tools all

# 只装远程执行 + 自审，指定 profile 与工作区
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -Tools 1,2 -ProfileName web -WorkspaceRoot "D:\work"
```

| 参数 | 说明 | 默认 |
|---|---|---|
| `-Tools` | 组件序号，如 `1,3,5` 或 `all` | 交互选择 |
| `-ProfileName` | DSH profile 名 | `web` |
| `-ProfileDir` | 显式指定 profile 目录 | 自动 |
| `-WorkspaceRoot` | 工作区根路径 | 交互输入 |

---

## 🧩 组件清单

| # | 组件 | 说明 | 装后工具 |
|---|------|------|---------|
| 1 | 🌐 **远程执行** | 在远程机器执行命令 / 上传文件（需远程端跑 agent） | `remote_exec` `remote_info` `remote_ping` |
| 2 | 🛡️ **执行前自动审核** | AI 执行程序前自动做静态危险扫描 safe/caution/danger + 审计；审批关闭时也生效 | `self_review` |
| 3 | 🐙 **GitHub 工具集** | 13 个 GitHub 工具：仓库 / Issue / PR / 文件 / 下载 | `gh_*` |
| 4 | 🔎 **联网研究** | 搜索 / 抓网页 / 论文检索与下载 | `wr_*` |
| 5 | 🏷️ **本地 Git 发布** | commit + 自动递增版本号 + 推送本地远程 | `git_publish` `git_repo_status` |
| 6 | 🧨 **沙箱逃生** | 带审批门控的宿主级命令执行 + 沙箱状态 | `sandbox_escape` `sandbox_status` |
| 7 | 🐞 **Bug 知识库** | 跨会话 bug 建档 / 根因 / 修复全生命周期 | `bug_*` |
| 8 | 🎨 **Blender 3D** | 建模 / 渲染 / 导出（需本机 Blender） | `blender_*` |
| 9 | 🧠 **上下文压缩** | 长会话自动压缩（默认 200k tokens） | — |
| 10 | 💉 **自愈启动器** | 内核检查 + 故障插件自动禁用继续启动 | `node auto-heal.js`（bundle 安装需 `--profile-dir <profile路径>`） |

---

## 🖥️ 远程端部署（组件 1）

被控端运行独立脚本 `tools/01-remote-exec/remote-agent-server.js` —— 零依赖、纯 Node、自带审计。

```bash
# 在远程机器上
node remote-agent-server.js --port 3788 --token mysecret

# 可选：限制上传目录
node remote-agent-server.js --port 3788 --token mysecret --allow-dir D:\uploads
```

端点：`/exec` `/upload` `/logs` `/ping` `/info`，每次执行写入 `remote-agent-audit.log`（token 自动脱敏）。

> ⚠️ 该服务允许执行任意命令，**务必设置强 token，且不要暴露到公网**。

---

## 🔐 凭据说明

| 组件 | 安装时 | 运行时 |
|------|--------|--------|
| GitHub | 安装后运行 `gh_set_token` 粘贴一次，存入 dsh 凭据服务 | 会话内已保存，`gh_clear_token` 清除 |
| 远程执行 | 输入 host / port / token，写入 patch | 远程端用 `--token` 启动 |

所有凭据只落在**你自己机器**的 profile 目录，**仓库内不保存任何 Token**。

---

## 📁 目录结构

```
dsh-tools/
├── package.json            标准 dsh bundle 清单（声明 dsh.bundle.patch）→ dsh plugin add 用
├── cordis.patch.yml        bundle 插件层：9 行 insert 指向 tools/ 下各插件
├── index.js                包入口占位（bundle 纯 host 插件，无逻辑）
├── install.bat             双击 / 拖拽安装入口（可自选组件）
├── install.ps1             安装主脚本（自选组件 + 凭据交互）
├── README.md
└── tools/
    ├── 01-remote-exec/      remote-agent.js + remote-agent-server.js
    ├── 02-self-review/      self-review.js
    ├── 03-github/           github-manager.js
    ├── 04-web-research/     web-research.js
    ├── 05-git-publish/      git-publish.js
    ├── 06-sandbox-escape/   sandbox-escape.js
    ├── 07-bug-tracker/      bug-tracker.js
    ├── 08-blender/          blender.js
    ├── 09-ctx-compact/      ctx-compact.js
    └── 10-auto-heal/        auto-heal.js（独立启动器，不进 bundle）
```

---

## 🔄 安装行为说明

- 插件 JS → `%USERPROFILE%\.dsh\profiles\<profile>\`（install.bat 方式）
- **bundle 方式**（`dsh plugin add`）：插件装到 `profiles\<profile>\node_modules\dsh-tools\`，卸载/升级包时随包删除
- 生成 / 合并 `cordis.patch.yml`，**原文件自动备份**
- 公共配置写入 patch：`workspaceRoot` / `dataDir` / `host` / `port` / `token`
- **审计日志不随包丢失**：`self_review` / `sandbox_escape` 的审计日志优先写入工作区 `.dsh-audit\`（`<workspaceRoot>\.dsh-audit\`），拿不到工作区才写插件目录
- `auto-heal` 独立启动器：install.bat 复制到 profile 根直接用；bundle 安装时在 node_modules 里，需 `node auto-heal.js --profile-dir <profile路径>`
- 需重启 dsh 生效；卸载 = `dsh plugin remove dsh-tools`（bundle）或删除对应 js + 注释 patch 行（install.bat）
- 全程无需管理员权限

---

## 🛡️ 隐私与安全

- ✅ 源码零个人信息（作者目录 / IP / Token / 会话 ID）
- ✅ 默认值均通用占位（远程 host 默认 `127.0.0.1`）
- ✅ 组件 2 `self-review`：每次执行有副作用命令前先自审 + 审计日志
- ✅ `git-publish` 默认不推公网、不自动 init

---

## 📋 要求

- Windows + [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（`dsh` 可用）
- **dsh 版本兼容性（如实标注）**：
  - **实测验证版本：`0.1.2-rc.1`**（本机运行通过，10 个组件安装/加载正常）
  - **源码级验证版本：`0.1.5-rc.1`（npm latest）**——逐项对比了 0.1.2→0.1.5 的服务目录与方法签名：
    - 全部 8 个本包依赖的服务（`approval` / `credentials` / `fs` / `subprocess` / `timer` / `tools` / `sandboxPolicy` / `systemPrompt`）在 0.1.5 **均存在，无一删除**（0.1.5 仅新增 `fileUploads`/`sessionFeedback`/`workspaceFiles` 3 个）
    - `tools.register` 签名逐字一致（含 `tools/pre-execute` 瀑布）；`approval.request`、`credentials.*`、`timer.*`、`fs.*` 方法签名一致；`subprocess` 3 个方法（`resolveExecutable`/`spawn`/`spawnTerminal`）签名一致
    - ⚠️ 唯一语义差异：0.1.5 的 `subprocess.spawn` 描述为"同步返回 live handle"，terminate 树范围描述有微调——**静态匹配通过，但尚未在 0.1.5 真机冒烟**
  - ⚠️ **dsh 0.1.1 → 0.1.2 是一次破坏性大版本**（1079 commits）：`code-mode` 重命名为 PTC 模式、`ApiProxy` 退役改 Remote controllers、client 模块系统重写、模块解析规则变化——**仅适用于 0.1.1 及更早的插件不保证兼容**
  - 0.1.2 之后的 alpha 迭代（rc.7→alpha.1→alpha.2→alpha.3）还有三次破坏性变更：peer 依赖策略收紧（`autoInstallPeers: false`）、`useSession`→`useChat` 重构、core bundles 改为必须显式声明——这些主要影响 **client 侧 UI 插件**与**依赖管理**
  - **本包为何兼容 0.1.2~0.1.5**：全部 10 个组件是 **host 侧纯工具插件**，零 `@deepseek-ai/*` 依赖、不 import cordis、不注册 client 插槽/UI、不用 `useSession`/`ApiProxy`；只用 `ctx.tools.register` + host 核心服务（上述 8 个，源码对比确认 0.1.5 未删改）
  - **验证方式**：`dsh --version` 查看当前版本；升级 dsh 后建议跑一次冒烟（安装后 `dsh web` 启动正常 + 任意一个工具能被调用）
- PowerShell 5.1+（Windows 自带）
- 组件 8 需本机安装 Blender
- 组件 1 需目标机器有 Node.js

---

## 🧑‍💻 参与

发现问题？欢迎提交 [Issue](../../issues)。

<div align="center">

**Made with ❤️ for DeepSeek Harness users**

</div>