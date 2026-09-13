# ============================================================
# dsh-tools 一键安装脚本（PowerShell 5.1+）
#
# 用法：
#   1) 解压/克隆本包后，双击 install.bat（或：
#      powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1）
#   2) 也可把本包 zip / 文件夹 直接拖到 install.bat 上安装
#
# 特点：
#   - 交互菜单：逐个列出可用工具，用户自选安装哪些
#   - 需要凭据的工具（GitHub / 远程机器）在安装时询问输入
#   - 自动把选中的插件 JS 复制到目标 profile，并生成/合并 cordis.patch.yml
#   - 已有配置自动备份，不覆盖破坏
#   - 全程无需管理员权限；安装后重启 dsh 生效
#
# 参数：
#   -ProfileName  dsh profile 名（默认 web，即 %USERPROFILE%\.dsh\profiles\<名>）
#   -ProfileDir   显式指定 profile 目录（更优先）
#   -Tools        直接指定要安装的工具序号，如 "1,3,5" 或 "all"（跳过菜单）
#   -WorkspaceRoot 工作区根路径（跳过询问）
# ============================================================

param(
  [string]$ProfileName   = 'web',
  [string]$ProfileDir    = '',
  [string]$Tools         = '',
  [string]$WorkspaceRoot = ''
)

$ErrorActionPreference = 'Stop'
$script:PkgRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------- patch 片段（独立 here-string，避免 hashtable 内嵌套解析问题） ----------
$PATCH_REMOTE = @'
- insert:
    - id: remote-agent
      name: './remote-agent.js'
      config:
        host: {{REMOTE_HOST}}
        port: {{REMOTE_PORT}}
        token: {{REMOTE_TOKEN}}
'@

$PATCH_SELF_REVIEW = @'
- insert:
    - id: self-review
      name: './self-review.js'
      config:
        workspaceRoot: {{WORKSPACE_ROOT}}
'@

$PATCH_GITHUB = @'
- insert:
    - id: github-manager
      name: './github-manager.js'
      config:
        workspaceRoot: {{WORKSPACE_ROOT}}
'@

$PATCH_WEB = @'
- insert:
    - id: web-research
      name: './web-research.js'
      config:
        workspaceRoot: {{WORKSPACE_ROOT}}
'@

$PATCH_GIT = @'
- insert:
    - id: git-publish
      name: './git-publish.js'
      config:
        workspaceRoot: {{WORKSPACE_ROOT}}
        initialVersion: '1.0.0'
        defaultBranch: 'main'
        autoInit: false
        localRemote: ''
        allowPublicRemote: false
'@

$PATCH_SANDBOX = @'
- insert:
    - id: sandbox-escape
      name: './sandbox-escape.js'
      config:
        workspaceRoot: {{WORKSPACE_ROOT}}
'@

$PATCH_BUG = @'
- insert:
    - id: bug-tracker
      name: './bug-tracker.js'
      config:
        workspaceRoot: {{WORKSPACE_ROOT}}
        dataDir: {{DATA_DIR}}
'@

$PATCH_BLENDER = @'
- insert:
    - id: blender
      name: './blender.js'
      config:
        blenderPath: ''
        workspace: {{WORKSPACE_ROOT}}\.dsh-blender
        defaultSession: 'main'
        guard: 'block'
        restrictedMode: false
'@

$PATCH_CTX = @'
- insert:
    - id: ctx-compact
      name: './ctx-compact.js'
      config:
        enabled: true
        thresholdTokens: 200000
'@

# ---------- 工具清单（patch 用上面的变量引用） ----------
$script:ToolsList = @(
  @{
    id = 1; dir = '01-remote-exec'; name = 'remote-exec 远程执行'
    desc = '在远程机器上执行命令/上传文件（需在远程机器先运行 remote-agent-server.js）'
    files = @('remote-agent.js', 'remote-agent-server.js')
    ask = 'remote'
    patch = $PATCH_REMOTE
  }
  @{
    id = 2; dir = '02-self-review'; name = 'self-review 执行前自动审核'
    desc = 'AI 执行程序前自动给自己做静态危险扫描（safe/caution/danger）+ 审计日志；完全权限下也生效'
    files = @('self-review.js')
    ask = 'none'
    patch = $PATCH_SELF_REVIEW
  }
  @{
    id = 3; dir = '03-github'; name = 'github-manager GitHub 工具集'
    desc = '13 个 gh_* 工具（仓库/Issue/PR/文件/下载）。Token 安装后请运行 gh_set_token'
    files = @('github-manager.js')
    ask = 'github'
    patch = $PATCH_GITHUB
  }
  @{
    id = 4; dir = '04-web-research'; name = 'web-research 联网研究'
    desc = '5 个 wr_* 工具（搜索/抓网页/论文检索与下载）'
    files = @('web-research.js')
    ask = 'none'
    patch = $PATCH_WEB
  }
  @{
    id = 5; dir = '05-git-publish'; name = 'git-publish 本地发布'
    desc = 'git_publish / git_repo_status：提交+自动递增版本号+推送本地 git 远程'
    files = @('git-publish.js')
    ask = 'none'
    patch = $PATCH_GIT
  }
  @{
    id = 6; dir = '06-sandbox-escape'; name = 'sandbox-escape 沙箱逃生'
    desc = 'sandbox_escape / sandbox_status：带审批门控的宿主级命令执行'
    files = @('sandbox-escape.js')
    ask = 'none'
    patch = $PATCH_SANDBOX
  }
  @{
    id = 7; dir = '07-bug-tracker'; name = 'bug-tracker Bug 知识库'
    desc = '9 个 bug_* 工具：跨会话 bug 建档/根因/修复 全生命周期管理'
    files = @('bug-tracker.js')
    ask = 'none'
    patch = $PATCH_BUG
  }
  @{
    id = 8; dir = '08-blender'; name = 'blender 3D 控制'
    desc = '6 个 blender_* 工具（建模/渲染/导出）。需本机安装 Blender 并配置 blenderPath'
    files = @('blender.js')
    ask = 'none'
    patch = $PATCH_BLENDER
  }
  @{
    id = 9; dir = '09-ctx-compact'; name = 'ctx-compact 上下文压缩'
    desc = '长会话自动压缩（阈值 200000 tokens），防上下文爆炸'
    files = @('ctx-compact.js')
    ask = 'none'
    patch = $PATCH_CTX
  }
  @{
    id = 10; dir = '10-auto-heal'; name = 'auto-heal 自愈启动器'
    desc = '带内核检查的 dsh 启动包装：内核 OK 则自动禁用故障插件继续启动。用 node auto-heal.js 启动'
    files = @('auto-heal.js')
    ask = 'none'
    patch = ''
  }
)

# ---------- 工具函数 ----------
function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# 实测验证的 dsh 版本（README「要求」章节有完整兼容性说明）
$script:DshCompat = '实测 0.1.2-rc.1；host 侧插件，0.1.2+ 通用'

function Read-Answer([string]$prompt, [string]$default = '') {
  $q = $prompt
  if ($default) { $q = "$prompt [$default]" }
  $v = Read-Host $q
  if ([string]::IsNullOrWhiteSpace($v)) { $v = $default }
  return $v.Trim()
}

function Resolve-ProfileDir {
  if ($ProfileDir) { return [System.IO.Path]::GetFullPath($ProfileDir) }
  $base = Join-Path $env:USERPROFILE '.dsh\profiles'
  $dir = Join-Path $base $ProfileName
  if (-not (Test-Path $base)) {
    Write-Warning "未找到 $base —— 看起来本机还没装 dsh？请确认已安装 DeepSeek Harness。继续将尝试创建。"
  }
  return $dir
}

function Confirm-CopyPlugin([string]$dir, [string]$profile) {
  $src = Join-Path $script:PkgRoot "tools\$dir"
  $files = @(Get-ChildItem -Path $src -Filter '*.js' -File | ForEach-Object { $_.Name })
  foreach ($f in $files) {
    Copy-Item (Join-Path $src $f) (Join-Path $profile $f) -Force
    Write-Host "  + $f"
  }
}

# YAML 单引号安全引用：值含 ' : # 换行 等特殊字符时防止破坏 cordis.patch.yml（防 YAML 注入）
function ConvertTo-YamlScalar([string]$value) {
  if ([string]::IsNullOrEmpty($value)) { return "''" }
  $escaped = $value.Replace("'", "''")
  return "'$escaped'"
}

# ---------- 主流程 ----------
Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  dsh-tools 一键安装   |   包目录: $script:PkgRoot" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan

# 1) 目标 profile
Write-Step "确定目标 dsh profile"
$profileDir = Resolve-ProfileDir
Write-Host "  目标目录: $profileDir"
if (-not (Test-Path $profileDir)) {
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  Write-Host "  已创建 $profileDir"
}

# 2) 工具选择
$selectedIds = @()
if ($Tools) {
  if ($Tools -ieq 'all') { $selectedIds = @($script:ToolsList | ForEach-Object { $_.id }) }
  else { $selectedIds = @($Tools -split '[,\s]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }) }
} else {
  Write-Step "选择要安装的工具（多个用逗号分隔，或输入 all 全装）"
  foreach ($t in $script:ToolsList) {
    Write-Host ("  {0,2}) {1}" -f $t.id, $t.name) -ForegroundColor Yellow
    Write-Host "      $($t.desc)"
  }
  $choice = (Read-Answer '请输入序号').ToLower()
  if ($choice -ieq 'all') { $selectedIds = @($script:ToolsList | ForEach-Object { $_.id }) }
  else { $selectedIds = @($choice -split '[,\s]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }) }
}

$chosen = @($script:ToolsList | Where-Object { $_.id -in $selectedIds })
if ($chosen.Count -eq 0) { Write-Warning '没有选中任何工具，退出。'; exit 1 }
Write-Host ("  已选 {0} 个: {1}" -f $chosen.Count, (($chosen | ForEach-Object { $_.name }) -join ' / '))

# 3) 公共配置：工作区根
if (-not $WorkspaceRoot) {
  Write-Step "配置工作区根（各插件输出/路径解析的基准目录）"
  $WorkspaceRoot = Read-Answer '工作区根路径' ''
}
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
  Write-Host '  （未输入，插件将回退到 dsh 启动目录）'
  $WorkspaceRoot = ''
}

# 4) 按需询问凭据/参数
$REMOTE_HOST = '127.0.0.1'; $REMOTE_PORT = '3788'; $REMOTE_TOKEN = ''
if (@($chosen | Where-Object { $_.id -eq 1 }).Count -gt 0) {
  Write-Step "配置远程机器（remote-exec 需要；不填 host 则用 127.0.0.1）"
  $REMOTE_HOST = Read-Answer '远程机器 IP' '127.0.0.1'
  $REMOTE_PORT = Read-Answer '远程 agent 端口' '3788'
  $REMOTE_TOKEN = Read-Answer '远程连接令牌（可回车跳过，之后设环境变量 REMOTE_AGENT_TOKEN）' ''
}
$GITHUB_TOKEN = ''
if (@($chosen | Where-Object { $_.id -eq 3 }).Count -gt 0) {
  Write-Step "GitHub 配置"
  Write-Host '  提示：gh_* 工具的 token 存 dsh 凭据存储，请在此输入后由脚本写入 profile\github-token.txt；'
  Write-Host '  安装完成后在 dsh 里运行 gh_set_token 并粘贴同一 token 一次即可。'
  $GITHUB_TOKEN = Read-Answer 'GitHub Personal Access Token（可回车跳过）' ''
}
$DATA_DIR = ''
if (@($chosen | Where-Object { $_.id -eq 7 }).Count -gt 0) {
  if ($WorkspaceRoot) { $DATA_DIR = Join-Path $WorkspaceRoot '.bugtrack' }
  $DATA_DIR = Read-Answer 'Bug 知识库数据目录' $DATA_DIR
}

# 5) 复制插件
Write-Step "复制插件到 profile"
foreach ($t in $chosen) {
  Write-Host ("  [{0}] {1}" -f $t.id, $t.name)
  Confirm-CopyPlugin $t.dir $profileDir
}

# 6) 生成/合并 cordis.patch.yml（备份再写）
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path $patchFile) {
  $bak = "$patchFile.bak-$(Get-Date -Format yyyyMMddHHmmss)"
  Copy-Item $patchFile $bak -Force
  Write-Host "  已备份原配置 -> $bak"
}
$vars = @{
  WORKSPACE_ROOT = $WorkspaceRoot
  DATA_DIR       = $DATA_DIR
  REMOTE_HOST    = $REMOTE_HOST
  REMOTE_PORT    = $REMOTE_PORT
  REMOTE_TOKEN   = $REMOTE_TOKEN
}
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('# ============================================================')
[void]$sb.AppendLine('# cordis.patch.yml — 由 dsh-tools install.ps1 生成')
[void]$sb.AppendLine('# 覆盖 base 层的插件默认/新增条目；改动需重启 dsh 生效。')
[void]$sb.AppendLine('# ============================================================')
$writePatch = @($chosen | Where-Object { -not [string]::IsNullOrWhiteSpace($_.patch) })
foreach ($t in $writePatch) {
  $block = $t.patch
  foreach ($k in $vars.Keys) {
    # YAML 安全替换：值先做单引号转义（防 ' : # 换行等破坏 YAML / 注入）
    $safeValue = ConvertTo-YamlScalar ([string]$vars[$k])
    $block = $block.Replace("{{" + $k + "}}", $safeValue)
  }
  [void]$sb.AppendLine($block.TrimEnd())
  [void]$sb.AppendLine('')
}
# 安全基线：保持 ask（用户在需要时自行改成 never）
[void]$sb.AppendLine('- id: approval')
[void]$sb.AppendLine('  config:')
[void]$sb.AppendLine("    policy: 'ask'")
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($patchFile, $sb.ToString(), $utf8Bom)
Write-Host "  已写入 $patchFile"

# 7) 收尾提示
Write-Step "安装完成"
Write-Host ""
Write-Host '  [OK] 插件已复制到 profile:' -ForegroundColor Green
Write-Host "        $profileDir"
Write-Host '  [OK] 配置已写入：cordis.patch.yml（原文件已备份）'
Write-Host ''
Write-Host '  下一步：' -ForegroundColor Yellow
Write-Host "    0) 适配 dsh 版本：$script:DshCompat（dsh --version 可查看当前版本）"
Write-Host '    1) 重启 dsh（配置在启动时加载）'
if (@($chosen | Where-Object { $_.id -eq 1 }).Count -gt 0) {
  Write-Host '    2) [remote-exec] 把 tools\01-remote-exec\remote-agent-server.js 拷到远程机器并运行：'
  Write-Host "        node remote-agent-server.js --port $REMOTE_PORT --token <你的令牌>"
  Write-Host "        远程机器需安装 Node.js。"
}
if (@($chosen | Where-Object { $_.id -eq 3 }).Count -gt 0 -and $GITHUB_TOKEN) {
  Write-Host '    3) [GitHub] 打开 dsh 对话框输入：gh_set_token 并粘贴你的 token'
  Write-Host "        （token 已暂存到 $profileDir\github-token.txt 供你复制）"
  Set-Content -Path (Join-Path $profileDir 'github-token.txt') -Value $GITHUB_TOKEN -Encoding UTF8
  Write-Host '        安全提示：复制完成后请手动删除该文件（或设置好 gh_set_token 后删除），'
  Write-Host '        避免 PAT 明文长期留在磁盘上。'
}
if (@($chosen | Where-Object { $_.id -eq 8 }).Count -gt 0) {
  Write-Host "    4) [Blender] 编辑 $patchFile 中 blender 的 config.blenderPath 为 blender.exe 完整路径"
}
Write-Host ''