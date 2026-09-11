#!/usr/bin/env bash
# =============================================================================
# Pi 配置还原脚本 (Linux / macOS)
#
# 用法:
#   bash restore.sh                 # 交互合并（默认）：先汇总差异，再选处理方式
#   bash restore.sh --status [--list]  # 只做三方对比报告（--list 逐条列出），不写入
#   bash restore.sh --dry-run       # 预览将要发生的变更，不写入
#   bash restore.sh --yes           # 非交互：按智能推荐处理（CI/自动化可用）
#   bash restore.sh --take-repo     # 非交互：全部采用仓库版本（模型/鉴权仍跳过）
#   bash restore.sh --keep-local    # 非交互：全部保留本地，只补缺失文件
#   bash restore.sh --only ext,skills,mcp    # 只同步指定类别
#   bash restore.sh --fresh         # 全新覆盖：备份旧配置后整体替换为仓库版本
#
# 合并逻辑（restore-engine.py）:
#   三方对比 = 上次同步时的仓库快照(.pi-config-sync.json) / 本地当前 / 仓库当前
#     · 仅仓库改  → 智能推荐直接采用仓库版本
#     · 仅本地改  → 保留本地（不会被覆盖）
#     · 两边都改  → 标记为冲突，默认保留本地，可逐文件选 A/B/C
#     · 本地缺失  → 直接安装
#   交互模式可选：智能推荐 / 全部采用仓库 / 全部保留本地 / 逐文件(A/B/C, d 看 diff)
#                / 只报告不写入
#
# 同步范围（重要）:
#   只同步 脚本 / 插件(extensions) / Skill / MCP 配置 / npm 清单 / settings.json 非模型字段。
#   模型与鉴权相关内容一律不同步（本地已有则永不覆盖；--fresh 也会从备份还原）:
#     agent/models.json、agent/models-store.json、agent/auth.json，
#     settings.json 的 defaultProvider / defaultModel / defaultThinkingLevel
#
# 密钥策略（明文，简单直接）:
#   各机器把 Key 明文写在自己的 models.json / auth.json / mcp.json 即可；
#   不用环境变量中转、不写 ~/.pi/secrets、还原时也不再询问密钥。
#   仓库中这些位置只有 PASTE_YOUR_... 占位符，真 Key 绝不入库。
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MODE="merge"
ONLY=""
ENGINE_ARGS=()

usage() {
  sed -n '3,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --fresh)      MODE="fresh" ;;
    --status)     MODE="status" ;;
    --list)       ENGINE_ARGS+=(--list) ;;
    --dry-run)    ENGINE_ARGS+=(--dry-run) ;;
    --yes)        ENGINE_ARGS+=(--yes) ;;
    --take-repo)  ENGINE_ARGS+=(--take-repo) ;;
    --keep-local) ENGINE_ARGS+=(--keep-local) ;;
    --only)       shift; ONLY="${1:-}"; ENGINE_ARGS+=(--only "$ONLY") ;;
    --only=*)     ONLY="${1#--only=}"; ENGINE_ARGS+=(--only "$ONLY") ;;
    -h|--help)    usage; exit 0 ;;
    *)            echo "未知参数: $1"; echo; usage; exit 1 ;;
  esac
  shift
done

[ -d "$HERE/agent" ] || { echo "错误: 当前目录不是 pi-config 仓库（缺少 agent/）"; exit 1; }

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

# 模型 / 鉴权文件（--fresh 时从备份还原）
NO_SYNC_FILES=(
  "agent/models.json"
  "agent/models-store.json"
  "agent/auth.json"
  "agent/fff/frecency/data.mdb"
  "agent/fff/frecency/lock.mdb"
  "agent/fff/history/lock.mdb"
)
SETTINGS_PROTECT_KEYS='["defaultProvider","defaultModel","defaultThinkingLevel","models"]'

echo "==> 目标目录: $PI_AGENT_DIR（模式: $MODE）"

# =============================================================================
# 模式一/二：合并 / 只报告 —— 交给 restore-engine.py
# =============================================================================
if [ "$MODE" != "fresh" ]; then
  if command -v python3 >/dev/null 2>&1; then
    if [ "${#ENGINE_ARGS[@]}" -gt 0 ]; then
      exec python3 "$HERE/restore-engine.py" --repo-root "$HERE" \
        --agent-dir "$PI_AGENT_DIR" --home "$HOME" --mode "$MODE" "${ENGINE_ARGS[@]}"
    fi
    exec python3 "$HERE/restore-engine.py" --repo-root "$HERE" \
      --agent-dir "$PI_AGENT_DIR" --home "$HOME" --mode "$MODE"
  fi
  echo "  ⚠ 未找到 python3：降级为「只补齐本地缺失文件」（装 python3 可获得三方对比/批量合并/融合）"
fi

# ── 降级路径（无 python3，且非 --fresh）─────────────────────────────────────
if [ "$MODE" = "status" ]; then
  echo "  ⚠ 无 python3，--status 不可用。"
  exit 0
fi

files_equal() {
  if command -v cmp >/dev/null 2>&1; then cmp -s "$1" "$2"; return $?; fi
  if command -v diff >/dev/null 2>&1; then diff -q "$1" "$2" >/dev/null 2>&1; return $?; fi
  [ "$(cksum < "$1" 2>/dev/null)" = "$(cksum < "$2" 2>/dev/null)" ]
}

mcp_target() {
  case "$1" in
    mcp/agent-mcp.json)      echo "$PI_AGENT_DIR/mcp.json" ;;
    mcp/pi-mcp.json)         echo "$HOME/.pi/mcp.json" ;;
    mcp/config-mcp.json)     echo "$HOME/.config/mcp/mcp.json" ;;
    mcp/agents-mcp.json)     echo "$HOME/.agents/mcp.json" ;;
    mcp/agents-mcp-mcp.json) echo "$HOME/.agents/mcp/mcp.json" ;;
    *) echo "" ;;
  esac
}

if [ "$MODE" = "merge" ]; then
  ADDED=0
  while IFS= read -r rel <&3; do
    case "$rel" in
      agent/*) target="$PI_AGENT_DIR/${rel#agent/}" ;;
      mcp/*)   target="$(mcp_target "$rel")" ;;
      *) continue ;;
    esac
    [ -n "$target" ] || continue
    [ -f "$target" ] && continue
    mkdir -p "$(dirname "$target")"
    cp -a "$HERE/$rel" "$target"
    echo "    ✅ 已安装 $target"
    ADDED=$((ADDED + 1))
  done 3< <(git -C "$HERE" ls-files agent mcp 2>/dev/null || find "$HERE/agent" "$HERE/mcp" -type f 2>/dev/null)
  echo "    安装缺失文件 $ADDED 个；其余差异保留本地。"
  exit 0
fi

# =============================================================================
# 模式三：全新覆盖（--fresh）
# =============================================================================
protect_settings() {   # protect_settings <本地旧 settings.json>
  local old="$1" t="$PI_AGENT_DIR/settings.json"
  [ -f "$t" ] && [ -f "$old" ] || return 0
  command -v python3 >/dev/null 2>&1 || { echo "      ⚠ 未找到 python3，settings.json 默认模型可能被仓库值覆盖"; return 0; }
  python3 - "$t" "$old" "$SETTINGS_PROTECT_KEYS" <<'PYEOF' || true
import json, sys
new_p, old_p, keys = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
try:
    new = json.load(open(new_p, encoding="utf-8"))
    old = json.load(open(old_p, encoding="utf-8"))
except Exception:
    sys.exit(0)
changed = [k for k in keys if k in old and new.get(k) != old[k]]
for k in changed:
    new[k] = old[k]
if changed:
    with open(new_p, "w", encoding="utf-8") as fh:
        json.dump(new, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print("      ↳ 模型相关字段保持本地值: " + ", ".join(changed))
PYEOF
}

ensure_auth_json() {
  if [ ! -f "$PI_AGENT_DIR/auth.json" ] && [ -f "$PI_AGENT_DIR/auth.json.example" ]; then
    cp "$PI_AGENT_DIR/auth.json.example" "$PI_AGENT_DIR/auth.json"
    chmod 600 "$PI_AGENT_DIR/auth.json"
    echo "  已从 auth.json.example 生成 auth.json（明文模板，需填真实 Key）"
  fi
}

echo "==> 全新覆盖模式：备份现有配置后整体替换"
BAK=""
if [ -d "$PI_AGENT_DIR" ] && [ -n "$(ls -A "$PI_AGENT_DIR" 2>/dev/null)" ]; then
  BAK="$PI_AGENT_DIR.bak-$TIMESTAMP"
  mv "$PI_AGENT_DIR" "$BAK"
  mkdir -p "$PI_AGENT_DIR"
  if [ -d "$BAK/sessions" ]; then
    mv "$BAK/sessions" "$PI_AGENT_DIR/sessions"
    echo "  已备份原配置到: $BAK（sessions/ 保留在原位，避免运行中的 pi 写会话报 ENOENT）"
  else
    echo "  已备份原配置到: $BAK"
  fi
fi

mkdir -p "$PI_AGENT_DIR"
cp -a "$HERE/agent/." "$PI_AGENT_DIR/"
echo "  已还原: settings.json / extensions / extensions-disabled / skills / npm 等"

# 模型 / 鉴权文件不参与同步：从备份还原本机版本（无备份则保留仓库模板）
if [ -n "$BAK" ] && [ -d "$BAK" ]; then
  for rel in "${NO_SYNC_FILES[@]}"; do
    name="${rel#agent/}"
    if [ -f "$BAK/$name" ]; then
      cp -a "$BAK/$name" "$PI_AGENT_DIR/$name"
      echo "  已保留本机 $name（模型/鉴权文件不同步）"
    fi
  done
  protect_settings "$BAK/settings.json"
else
  echo "  ℹ 未发现旧配置：models.json / auth.json 使用仓库模板（Key 为占位符，需自行填明文）"
fi

# bin/ 平台检测（fd/rg 是 Linux x86-64 二进制）
if [ -d "$PI_AGENT_DIR/bin" ]; then
  PLATFORM="$(uname -s)-$(uname -m)"
  if [ "$PLATFORM" != "Linux-x86_64" ]; then
    rm -rf "$PI_AGENT_DIR/bin"
    echo "  ⚠ 备份中的 fd/rg 是 Linux-x86_64 二进制，当前平台是 $PLATFORM，已清理。"
  fi
fi

# MCP 配置还原（按原路径映射）
for name in agent-mcp.json pi-mcp.json config-mcp.json agents-mcp.json agents-mcp-mcp.json; do
  src="$HERE/mcp/$name"
  [ -f "$src" ] || continue
  dst="$(mcp_target "mcp/$name")"
  [ -n "$dst" ] || continue
  mkdir -p "$(dirname "$dst")"
  cp -a "$src" "$dst"
  echo "  已还原 MCP 配置: $dst"
done

ensure_auth_json
chmod 600 "$PI_AGENT_DIR/models.json" "$PI_AGENT_DIR/mcp.json" "$PI_AGENT_DIR/auth.json" 2>/dev/null || true

# 写入同步基准（下次合并即可做三方对比）
if command -v python3 >/dev/null 2>&1; then
  python3 "$HERE/restore-engine.py" --repo-root "$HERE" --agent-dir "$PI_AGENT_DIR" \
    --home "$HOME" --mode manifest >/dev/null 2>&1 || true
fi

# npm 包重装（需联网）
if [ -f "$PI_AGENT_DIR/extensions/bash-guard/package.json" ]; then
  echo "==> 安装 bash-guard 扩展依赖（shell-quote）..."
  if command -v npm >/dev/null 2>&1; then
    (cd "$PI_AGENT_DIR/extensions/bash-guard" && npm install --omit=dev 2>&1 | tail -2) \
      && echo "  ✅ bash-guard 扩展依赖已安装" \
      || echo "  ⚠ bash-guard npm install 失败（需联网）。缺失时 bash-guard 扩展会报 shell-quote 找不到。"
  else
    echo "  ⚠ 未找到 npm，跳过 bash-guard 依赖安装。"
  fi
fi

if [ -f "$PI_AGENT_DIR/npm/package.json" ]; then
  echo "==> 尝试重装 npm packages（需联网）..."
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
echo " ✅ 全新覆盖还原完成！现在启动 pi 即可。"
echo "    首次启动会自动安装 settings.json 中声明的全部 packages，"
echo "    并加载扩展 / Skills / MCP 配置。"
echo "    模型/鉴权文件已保留本机版本；仓库只提供带 PASTE_YOUR_... 占位符的模板。"
echo "    检查未填占位符： bash restore.sh --status"
echo "=============================================="
