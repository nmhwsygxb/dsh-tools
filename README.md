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

## 🚀 快速开始（30 秒）

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
| 10 | 💉 **自愈启动器** | 内核检查 + 故障插件自动禁用继续启动 | `node auto-heal.js` |

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
| GitHub | 输入 PAT，保存到 `profile\github-token.txt` | 在 dsh 对话执行 `gh_set_token` 粘贴一次 |
| 远程执行 | 输入 host / port / token，写入 patch | 远程端用 `--token` 启动 |

所有凭据只落在**你自己机器**的 profile 目录，**仓库内不保存任何 Token**。

---

## 📁 目录结构

```
dsh-tools/
├── install.bat              双击 / 拖拽安装入口
├── install.ps1              安装主脚本（自选组件 + 凭据交互）
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
    └── 10-auto-heal/        auto-heal.js（启动器）
```

---

## 🔄 安装行为说明

- 插件 JS → `%USERPROFILE%\.dsh\profiles\<profile>\`
- 生成 / 合并 `cordis.patch.yml`，**原文件自动备份**
- 公共配置写入 patch：`workspaceRoot` / `dataDir` / `host` / `port` / `token`
- 需重启 dsh 生效；卸载 = 删除对应 js + 注释 patch 行
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
- PowerShell 5.1+（Windows 自带）
- 组件 8 需本机安装 Blender
- 组件 1 需目标机器有 Node.js

---

## 🧑‍💻 参与

发现问题？欢迎提交 [Issue](../../issues)。

<div align="center">

**Made with ❤️ for DeepSeek Harness users**

</div>