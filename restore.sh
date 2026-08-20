#!/usr/bin/env bash
# =============================================================================
# Pi 配置还原脚本 (Linux / macOS)
#
# 用法: 解压 ZIP 后，进入 pi-portable 目录执行:
#   bash restore.sh
#
# 会做:
#   1. 备份现有 ~/.pi/agent 到 ~/.pi/agent.bak-<时间戳>
#   2. 还原 settings.json / auth.json / models.json / 扩展 / Skills / MCP 配置
#   3. 平台不匹配时清理 bin/ 下的 Linux 二进制
#   4. 尝试 npm ci 重装 packages（需联网；也可直接启动 pi 自动安装）
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

echo "==> 目标目录: $PI_AGENT_DIR"
[ -d "$HERE/agent" ] || { echo "错误: 当前目录不是 pi-portable 解压目录（缺少 agent/）"; exit 1; }

# ── 1. 备份现有配置 ─────────────────────────────────────────────────────────
if [ -d "$PI_AGENT_DIR" ] && [ -n "$(ls -A "$PI_AGENT_DIR" 2>/dev/null)" ]; then
  BAK="$PI_AGENT_DIR.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$PI_AGENT_DIR" "$BAK"
  echo "  已备份原配置到: $BAK"
fi

# ── 2. 还原文件 ─────────────────────────────────────────────────────────────
mkdir -p "$PI_AGENT_DIR"
cp -a "$HERE/agent/." "$PI_AGENT_DIR/"
echo "  已还原: settings.json / auth.json / models.json / AGENTS.md / extensions/ / skills/ 等"

# ── 3. bin/ 平台检测（fd/rg 是 Linux x86-64 二进制）─────────────────────────
if [ -d "$PI_AGENT_DIR/bin" ]; then
  PLATFORM="$(uname -s)-$(uname -m)"
  if [ "$PLATFORM" != "Linux-x86_64" ]; then
    rm -rf "$PI_AGENT_DIR/bin"
    echo "  ⚠ 备份中的 fd/rg 是 Linux-x86_64 二进制，当前平台是 $PLATFORM，已清理。"
    echo "    pi 启动时会按需重新获取（或从系统包管理器安装 fd、ripgrep）。"
  fi
fi

# ── 4. MCP 配置还原 ─────────────────────────────────────────────────────────
restore_mcp() {
  local src="$HERE/mcp/$1" dst="$2"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
    echo "  已还原 MCP 配置: $dst"
  fi
}
restore_mcp agent-mcp.json      "$PI_AGENT_DIR/mcp.json"
restore_mcp pi-mcp.json         "$HOME/.pi/mcp.json"
restore_mcp config-mcp.json     "$HOME/.config/mcp/mcp.json"
restore_mcp agents-mcp.json     "$HOME/.agents/mcp.json"
restore_mcp agents-mcp-mcp.json "$HOME/.agents/mcp/mcp.json"

# 可选：若设置了 AMAP_MCP_KEY 环境变量，把 mcp.json 中的占位符替换为真实 key
# ── 4b. 密钥手动输入（还原后提示）──────────────────────────────────────
# 高德 MCP key：环境变量 AMAP_MCP_KEY 优先，未设置时交互询问用户输入
if [ -f "$PI_AGENT_DIR/mcp.json" ] && grep -q '{env:AMAP_MCP_KEY}' "$PI_AGENT_DIR/mcp.json"; then
  if [ -n "${AMAP_MCP_KEY:-}" ]; then
    python3 - "$PI_AGENT_DIR/mcp.json" "$AMAP_MCP_KEY" <<'PY'
import sys
p, key = sys.argv[1], sys.argv[2]
s = open(p, encoding="utf-8").read()
s = s.replace("{env:AMAP_MCP_KEY}", key)
open(p, "w", encoding="utf-8").write(s)
PY
    echo "  ✅ 已注入 AMAP_MCP_KEY 到 mcp.json（amap 高德地图）"
  elif [ -t 0 ]; then
    echo ""
    echo "==> 检测到高德地图 MCP key 未配置（mcp.json 中为 {env:AMAP_MCP_KEY} 占位符）。"
    printf "    是否现在手动输入高德 Web服务 key？[y/N] "
    read -r ans
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      printf "    请输入高德 Web服务 key（输入不回显）: "
      read -r -s AMAP_KEY_INPUT
      echo ""
      if [ -n "$AMAP_KEY_INPUT" ]; then
        python3 - "$PI_AGENT_DIR/mcp.json" "$AMAP_KEY_INPUT" <<'PY'
import sys
p, key = sys.argv[1], sys.argv[2]
s = open(p, encoding="utf-8").read()
s = s.replace("{env:AMAP_MCP_KEY}", key)
open(p, "w", encoding="utf-8").write(s)
PY
        unset AMAP_KEY_INPUT
        echo "  ✅ 已写入高德 Web服务 key 到 mcp.json（amap）"
      else
        echo "  ⚠ 未输入 key，保留占位符。可设置环境变量 AMAP_MCP_KEY 后重跑 restore.sh，或手动编辑 mcp.json。"
      fi
    else
      echo "  已跳过。可设置环境变量 AMAP_MCP_KEY 后重跑 restore.sh，或手动编辑 mcp.json。"
    fi
  else
    echo "  提示: AMAP_MCP_KEY 未设置（非交互终端）。mcp.json 保留 {env:AMAP_MCP_KEY} 占位符，"
    echo "        设置环境变量后运行时自动展开，或手动替换为真实 key。"
  fi
fi

# auth.json（deepseek / sensenova API 密钥）：不存在时提示/询问用户
if [ ! -f "$PI_AGENT_DIR/auth.json" ]; then
  if [ -t 0 ]; then
    echo ""
    echo "==> auth.json 不存在（含 deepseek / sensenova API 密钥）。"
    printf "    是否现在手动输入？[y/N] "
    read -r ans
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      printf "    deepseek API key（输入不回显）: "; read -r -s DK; echo ""
      printf "    sensenova API key（输入不回显）: "; read -r -s SK; echo ""
      python3 - "$PI_AGENT_DIR/auth.json" "$DK" "$SK" <<'PY'
import json, sys
p, dk, sk = sys.argv[1], sys.argv[2], sys.argv[3]
auth = {}
if dk: auth["deepseek"] = {"type": "api_key", "key": dk}
if sk: auth["sensenova"] = {"type": "api_key", "key": sk}
open(p, "w", encoding="utf-8").write(json.dumps(auth, ensure_ascii=False, indent=2) + "\n")
PY
      unset DK SK
      [ -s "$PI_AGENT_DIR/auth.json" ] && echo "  ✅ 已写入 auth.json" || echo "  ⚠ 未输入任何 key，auth.json 未生成"
    else
      echo "  已跳过。还原后请手动补充 auth.json（参考 agent/auth.json.example 或从原电脑复制）。"
    fi
  else
    echo "  提示: auth.json 不存在。还原后请手动补充（参考 agent/auth.json.example）。"
  fi
fi

# ── 5. npm 包重装（需联网）──────────────────────────────────────────────────
if [ -f "$PI_AGENT_DIR/npm/package.json" ]; then
  echo "==> 尝试重装 npm packages（需联网，包清单: $(grep -c ':' "$PI_AGENT_DIR/npm/package.json" || true) 项依赖）..."
  if command -v npm >/dev/null 2>&1; then
    (cd "$PI_AGENT_DIR/npm" && npm ci 2>&1 | tail -3) \
      && echo "  ✅ npm 依赖安装完成" \
      || echo "  ⚠ npm ci 失败（无网络或无 npm 时正常）。直接启动 pi 即可，它会自动安装 settings.json 中声明的 packages。"
  else
    echo "  ⚠ 未找到 npm。直接启动 pi 即可自动安装 packages。"
  fi
fi

echo ""
echo "=============================================="
echo " ✅ 还原完成！现在启动 pi 即可。"
echo "    首次启动会自动安装 settings.json 中声明的全部 packages，"
echo "    并加载扩展 / Skills / MCP 配置。"
echo "=============================================="
