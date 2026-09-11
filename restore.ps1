# =============================================================================
# Pi 配置还原脚本 (Windows PowerShell)
#
# 用法: 解压 ZIP 后，在 pi-portable 目录打开 PowerShell 执行:
#   powershell -ExecutionPolicy Bypass -File .\restore.ps1
#
# 会做:
#   1. 备份现有 %USERPROFILE%\.pi\agent 到 .bak-<时间戳>
#   2. 还原 settings.json / 扩展 / Skills / MCP 配置
#   3. 模型与鉴权相关文件（models.json / models-store.json / auth.json）
#      以及 settings.json 的默认模型字段不参与同步，一律保留本机版本
#   4. 清理备份中 Linux 专用的 bin/ 二进制
#   5. 提示重装 npm packages（需联网；也可直接启动 pi 自动安装）
#
# 密钥策略：明文。Key 直接写在 models.json / auth.json / mcp.json 里，
# 不用环境变量、不写 secrets 文件；仓库里只有 PASTE_YOUR_... 占位符。
#
# 参数:
#   -Status        只做三方对比报告，不写入（需 Python）
#   -DryRun        预览变更，不写入（需 Python）
#   -Yes           非交互：按智能推荐处理（需 Python）
#   -TakeRepo      非交互：全部采用仓库版本（模型/鉴权仍跳过）
#   -KeepLocal     非交互：全部保留本地，只补缺失文件
#   -Only ext,skills,mcp   只同步指定类别
#   -Mode fresh    强制使用“全新覆盖”逻辑（不动 python 引擎）
#   装 Python 时会调用跨平台的 restore-engine.py，获得与 Linux 一致的三方对比/批量合并能力。
# =============================================================================
param(
    [ValidateSet("merge", "fresh")][string]$Mode = "merge",
    [switch]$Status,
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$TakeRepo,
    [switch]$KeepLocal,
    [string]$Only = ""
)
$ErrorActionPreference = "Stop"

$HERE = $PSScriptRoot
$AgentDir = Join-Path $env:USERPROFILE ".pi\agent"

Write-Host "==> 目标目录: $AgentDir"

if (-not (Test-Path (Join-Path $HERE "agent"))) {
    Write-Host "错误: 当前目录不是 pi-config 仓库（缺少 agent/）" -ForegroundColor Red
    exit 1
}

# ── 0. 装了 Python 就走跨平台引擎（三方对比 / 批量合并 / 融合）───────────────
$PyExe = $null
foreach ($cand in @("python", "python3", "py")) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { $PyExe = $cmd.Source; break }
}
if ($PyExe -and $Mode -ne "fresh" -and (Test-Path (Join-Path $HERE "restore-engine.py"))) {
    $engineMode = if ($Status) { "status" } else { "merge" }
    $engineArgs = @((Join-Path $HERE "restore-engine.py"), "--repo-root", $HERE,
                    "--agent-dir", $AgentDir, "--home", $env:USERPROFILE, "--mode", $engineMode)
    if ($DryRun)    { $engineArgs += "--dry-run" }
    if ($Yes)       { $engineArgs += "--yes" }
    if ($TakeRepo)  { $engineArgs += "--take-repo" }
    if ($KeepLocal) { $engineArgs += "--keep-local" }
    if ($Only)      { $engineArgs += @("--only", $Only) }
    & $PyExe @engineArgs
    exit $LASTEXITCODE
}
if (-not $PyExe) {
    Write-Host "  ⚠ 未找到 Python：降级为 PowerShell 内置的“全新覆盖”逻辑（装 Python 可获得三方对比/批量合并）" -ForegroundColor Yellow
}

# ── 1. 备份现有配置 ─────────────────────────────────────────────────────────
# 注意：sessions/ 是运行中的 pi 正在写入的会话目录，必须保留在原位，
#       否则 Move-Item 之后运行中的 pi 追加会话日志会报 ENOENT（文件路径已不存在）。
$bak = $null
if (Test-Path $AgentDir) {
    $bak = "$AgentDir.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    Move-Item $AgentDir $bak
    New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
    $sessionsDir = Join-Path $bak "sessions"
    if (Test-Path $sessionsDir) {
        Move-Item $sessionsDir (Join-Path $AgentDir "sessions")
        Write-Host "  已备份原配置到: $bak（sessions/ 保留在原位，避免运行中的 pi 写会话报 ENOENT）"
    } else {
        Write-Host "  已备份原配置到: $bak"
    }
}

# ── 2. 还原文件 ─────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
Copy-Item (Join-Path $HERE "agent\*") $AgentDir -Recurse -Force
Write-Host "  已还原: settings.json / AGENTS.md / extensions/ / skills/ / npm 等"

# ── 2b. 模型 / 鉴权文件不参与同步（从备份还原本机版本）─────────────────────
$NoSync = @("models.json", "models-store.json", "auth.json")
if ($bak -and (Test-Path $bak)) {
    foreach ($name in $NoSync) {
        $src = Join-Path $bak $name
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $AgentDir $name) -Force
            Write-Host "  已保留本机 $name（模型/鉴权文件不同步）"
        }
    }
    # settings.json 中模型相关字段保持本地值
    $oldSet = Join-Path $bak "settings.json"
    $newSet = Join-Path $AgentDir "settings.json"
    if ((Test-Path $oldSet) -and (Test-Path $newSet)) {
        try {
            $o = Get-Content $oldSet -Raw | ConvertFrom-Json
            $n = Get-Content $newSet -Raw | ConvertFrom-Json
            $changed = @()
            foreach ($k in @("defaultProvider", "defaultModel", "defaultThinkingLevel", "models")) {
                if ($o.PSObject.Properties.Name -contains $k) {
                    if ($n.PSObject.Properties.Name -contains $k) {
                        if ($n.$k -ne $o.$k) { $n.$k = $o.$k; $changed += $k }
                    } else {
                        $n | Add-Member -NotePropertyName $k -NotePropertyValue $o.$k
                        $changed += $k
                    }
                }
            }
            if ($changed.Count -gt 0) {
                $n | ConvertTo-Json -Depth 20 | Set-Content $newSet -Encoding UTF8
                Write-Host "      ↳ 模型相关字段保持本地值: $($changed -join ', ')" -ForegroundColor DarkGray
            }
        } catch {
            Write-Host "  ⚠ 解析 settings.json 失败，默认模型可能被仓库值覆盖：$($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "  ℹ 未发现旧配置：models.json / auth.json 使用仓库模板（Key 为占位符，需自行填明文）"
}

# ── 3. 清理 Linux 二进制（fd/rg 为 Linux x86-64 ELF）────────────────────────
$binDir = Join-Path $AgentDir "bin"
if (Test-Path $binDir) {
    Remove-Item $binDir -Recurse -Force
    Write-Host "  ⚠ 已清理备份中的 Linux 版 fd/rg 二进制（Windows 上无法使用）。" -ForegroundColor Yellow
}

# ── 4. MCP 配置还原 ─────────────────────────────────────────────────────────
function Restore-Mcp([string]$name, [string]$dst) {
    $src = Join-Path $HERE "mcp\$name"
    if (Test-Path $src) {
        $dir = Split-Path $dst -Parent
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Copy-Item $src $dst -Force
        Write-Host "  已还原 MCP 配置: $dst"
    }
}
Restore-Mcp "agent-mcp.json"      (Join-Path $AgentDir "mcp.json")
Restore-Mcp "pi-mcp.json"         (Join-Path $env:USERPROFILE ".pi\mcp.json")
Restore-Mcp "config-mcp.json"     (Join-Path $env:USERPROFILE ".config\mcp\mcp.json")
Restore-Mcp "agents-mcp.json"     (Join-Path $env:USERPROFILE ".agents\mcp.json")
Restore-Mcp "agents-mcp-mcp.json" (Join-Path $env:USERPROFILE ".agents\mcp\mcp.json")

# ── 4b. 明文密钥检查（不再交互询问）────────────────────────────────────────
# 策略：Key 明文写在 models.json / auth.json / mcp.json 里，无环境变量中转。
# auth.json 缺失时从 example 生成明文模板
$authFile = Join-Path $AgentDir "auth.json"
$authExample = Join-Path $AgentDir "auth.json.example"
if ((-not (Test-Path $authFile)) -and (Test-Path $authExample)) {
    Copy-Item $authExample $authFile -Force
    Write-Host "  已从 auth.json.example 生成 auth.json（明文模板，需填真实 Key）"
}

$placeholderPattern = 'PASTE_YOUR_|sk-PASTE|\$\{PI_|\$PI_[A-Z_]+_API_KEY|\{env:'
foreach ($f in @((Join-Path $AgentDir "models.json"), $authFile, (Join-Path $AgentDir "mcp.json"))) {
    if (-not (Test-Path $f)) { continue }
    $hits = Select-String -Path $f -Pattern $placeholderPattern -ErrorAction SilentlyContinue
    if ($hits) {
        Write-Host "  ⚠ $f 中仍有未填的占位符：" -ForegroundColor Yellow
        $hits | ForEach-Object { Write-Host ("      " + $_.LineNumber + ": " + $_.Line.Trim()) }
        Write-Host "    → 现在用明文：把真实 Key 直接粘贴替换掉占位符即可（不需要环境变量 / secrets 文件）。" -ForegroundColor Yellow
    }
}

# ── 5. npm 包重装（需联网）──────────────────────────────────────────────────
$bashGuardDir = Join-Path $AgentDir "extensions\bash-guard"
if (Test-Path (Join-Path $bashGuardDir "package.json")) {
    Write-Host "==> 安装 bash-guard 扩展依赖（shell-quote）..."
    Push-Location $bashGuardDir
    try {
        npm install --omit=dev | Select-Object -Last 2
        Write-Host "  ✅ bash-guard 扩展依赖已安装"
    } catch {
        Write-Host "  ⚠ bash-guard npm install 失败（需联网）。缺失时 bash-guard 扩展会报 shell-quote 找不到。" -ForegroundColor Yellow
    } finally {
        Pop-Location
    }
}

$pkgJson = Join-Path $AgentDir "npm\package.json"
if (Test-Path $pkgJson) {
    Write-Host "==> 尝试重装 npm packages（需联网）..."
    Push-Location (Join-Path $AgentDir "npm")
    try {
        npm ci | Select-Object -Last 3
        Write-Host "  ✅ npm 依赖安装完成"
    } catch {
        Write-Host "  ⚠ npm ci 失败（无网络或无 npm 时正常）。直接启动 pi 即可自动安装 packages。" -ForegroundColor Yellow
    } finally {
        Pop-Location
    }
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host " ✅ 还原完成！现在启动 pi 即可。" -ForegroundColor Green
Write-Host "    首次启动会自动安装 settings.json 中声明的全部 packages。" -ForegroundColor Green
Write-Host "    模型/鉴权文件已保留本机版本（不同步）；仓库只提供带 PASTE_YOUR_... 占位符的模板。" -ForegroundColor Green
if ($PyExe) {
    & $PyExe (Join-Path $HERE "restore-engine.py") --repo-root $HERE --agent-dir $AgentDir `
        --home $env:USERPROFILE --mode manifest | Out-Null
    Write-Host "    已写入同步基准（下次可用 -Status 做三方对比）。" -ForegroundColor Green
}
Write-Host "==============================================" -ForegroundColor Green
