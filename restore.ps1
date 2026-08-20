# =============================================================================
# Pi 配置还原脚本 (Windows PowerShell)
#
# 用法: 解压 ZIP 后，在 pi-portable 目录打开 PowerShell 执行:
#   powershell -ExecutionPolicy Bypass -File .\restore.ps1
#
# 会做:
#   1. 备份现有 %USERPROFILE%\.pi\agent 到 .bak-<时间戳>
#   2. 还原 settings.json / auth.json / models.json / 扩展 / Skills / MCP 配置
#   3. 清理备份中 Linux 专用的 bin/ 二进制
#   4. 提示重装 npm packages（需联网；也可直接启动 pi 自动安装）
# =============================================================================
$ErrorActionPreference = "Stop"

$HERE = $PSScriptRoot
$AgentDir = Join-Path $env:USERPROFILE ".pi\agent"

Write-Host "==> 目标目录: $AgentDir"

if (-not (Test-Path (Join-Path $HERE "agent"))) {
    Write-Host "错误: 当前目录不是 pi-portable 解压目录（缺少 agent/）" -ForegroundColor Red
    exit 1
}

# ── 1. 备份现有配置 ─────────────────────────────────────────────────────────
if (Test-Path $AgentDir) {
    $bak = "$AgentDir.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    Move-Item $AgentDir $bak
    Write-Host "  已备份原配置到: $bak"
}

# ── 2. 还原文件 ─────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
Copy-Item (Join-Path $HERE "agent\*") $AgentDir -Recurse -Force
Write-Host "  已还原: settings.json / auth.json / models.json / AGENTS.md / extensions/ / skills/ 等"

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

# 可选：若设置了 AMAP_MCP_KEY 环境变量，把 mcp.json 中的占位符替换为真实 key
$envKey = $env:AMAP_MCP_KEY
$mcpFile = Join-Path $AgentDir "mcp.json"
if ($envKey -and (Test-Path $mcpFile)) {
    $content = (Get-Content $mcpFile -Raw).Replace("{env:AMAP_MCP_KEY}", $envKey)
    Set-Content $mcpFile $content -NoNewline -Encoding UTF8
    Write-Host "  已注入 AMAP_MCP_KEY 到 mcp.json（amap 高德地图）"
} else {
    Write-Host "  提示: 未设置 AMAP_MCP_KEY，mcp.json 保留 {env:AMAP_MCP_KEY} 占位符；" -ForegroundColor Yellow
    Write-Host "        设置环境变量后运行时自动展开，或手动替换为真实 key。" -ForegroundColor Yellow
}

# ── 5. npm 包重装（需联网）──────────────────────────────────────────────────
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
Write-Host "==============================================" -ForegroundColor Green
