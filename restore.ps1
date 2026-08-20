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

# ── 4b. 密钥手动输入（还原后提示）──────────────────────────────────────
# 高德 MCP key：环境变量 AMAP_MCP_KEY 优先，未设置时交互询问用户输入
$mcpFile = Join-Path $AgentDir "mcp.json"
if ((Test-Path $mcpFile) -and (Get-Content $mcpFile -Raw).Contains("{env:AMAP_MCP_KEY}")) {
    if ($env:AMAP_MCP_KEY) {
        $content = (Get-Content $mcpFile -Raw).Replace("{env:AMAP_MCP_KEY}", $env:AMAP_MCP_KEY)
        Set-Content $mcpFile $content -NoNewline -Encoding UTF8
        Write-Host "  ✅ 已注入 AMAP_MCP_KEY 到 mcp.json（amap 高德地图）" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "==> 检测到高德地图 MCP key 未配置（mcp.json 中为 {env:AMAP_MCP_KEY} 占位符）。"
        $ans = Read-Host "    是否现在手动输入高德 Web服务 key？[y/N]"
        if ($ans -match '^[Yy]') {
            $secure = Read-Host "    请输入高德 Web服务 key（输入不回显）" -AsSecureString
            if ($secure) {
                $plain = (New-Object System.Net.NetworkCredential('', $secure)).Password
                $content = (Get-Content $mcpFile -Raw).Replace("{env:AMAP_MCP_KEY}", $plain)
                Set-Content $mcpFile $content -NoNewline -Encoding UTF8
                Write-Host "  ✅ 已写入高德 Web服务 key 到 mcp.json（amap）" -ForegroundColor Green
            } else {
                Write-Host "  ⚠ 未输入 key，保留占位符。可设置环境变量 AMAP_MCP_KEY 后重跑 restore.ps1，或手动编辑 mcp.json。" -ForegroundColor Yellow
            }
        } else {
            Write-Host "  已跳过。可设置环境变量 AMAP_MCP_KEY 后重跑 restore.ps1，或手动编辑 mcp.json。" -ForegroundColor Yellow
        }
    }
}

# auth.json（deepseek / sensenova API 密钥）：不存在时提示/询问用户
$authFile = Join-Path $AgentDir "auth.json"
if (-not (Test-Path $authFile)) {
    Write-Host ""
    Write-Host "==> auth.json 不存在（含 deepseek / sensenova API 密钥）。"
    $ans = Read-Host "    是否现在手动输入？[y/N]"
    if ($ans -match '^[Yy]') {
        $dk = Read-Host "    deepseek API key（输入不回显）" -AsSecureString
        $sk = Read-Host "    sensenova API key（输入不回显）" -AsSecureString
        $auth = @{}
        if ($dk) { $auth["deepseek"] = @{ type = "api_key"; key = (New-Object System.Net.NetworkCredential('', $dk)).Password } }
        if ($sk) { $auth["sensenova"] = @{ type = "api_key"; key = (New-Object System.Net.NetworkCredential('', $sk)).Password } }
        if ($auth.Count -gt 0) {
            $auth | ConvertTo-Json | Set-Content $authFile -Encoding UTF8
            Write-Host "  ✅ 已写入 auth.json" -ForegroundColor Green
        } else {
            Write-Host "  ⚠ 未输入任何 key，auth.json 未生成" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  已跳过。还原后请手动补充 auth.json（参考 agent/auth.json.example 或从原电脑复制）。" -ForegroundColor Yellow
    }
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
