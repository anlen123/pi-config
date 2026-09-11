#!/usr/bin/env bash
# =============================================================================
# Pi 配置还原脚本 (Linux / macOS)
#
# 用法:
#   bash restore.sh            # 交互合并模式（默认）：逐文件对比"本地 ~/.pi/agent"
#                              # 与"本仓库"，差异处可选 A/B/C（见下）
#   bash restore.sh --fresh    # 全新覆盖模式：备份旧配置后整体替换为仓库版本
#
# 差异文件的三种处理方式:
#   A = 以远程（本仓库）为主，覆盖本地（本地旧版会先备份）
#   B = 以本地为主，保留本地不动
#   C = 两者融合：逐个差异块列出"本地 vs 仓库"，由你逐块挑选；
#       单个文件内剩余冲突可一键 "全部保留本地" 或 "全部采用仓库"
#
# 同步范围（重要）:
#   只同步 脚本 / 插件(extensions) / Skill / MCP 配置 / settings.json 的非模型字段。
#   模型与鉴权相关内容一律不同步（本地已有则跳过；--fresh 也会从备份还原）:
#     agent/models.json        自定义 provider / model 定义
#     agent/models-store.json  模型列表状态
#     agent/auth.json          密钥（本机明文保存）
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
[ "${1:-}" = "--fresh" ] && MODE="fresh"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
MERGE_BAK="$PI_AGENT_DIR.merge-bak-$TIMESTAMP"
MODIFIED_FILES=()
SKIPPED_FILES=()

echo "==> 目标目录: $PI_AGENT_DIR（模式: $MODE）"
[ -d "$HERE/agent" ] || { echo "错误: 当前目录不是 pi-config 仓库（缺少 agent/）"; exit 1; }

# ── 同步范围：模型 / 鉴权类文件一律不同步 ────────────────────────────────────
NO_SYNC_FILES=(
  "agent/models.json"         # 自定义 provider / model 定义
  "agent/models-store.json"   # 模型列表状态
  "agent/auth.json"           # 密钥（本机明文保存）
)
is_no_sync() {
  local rel="$1" x
  for x in "${NO_SYNC_FILES[@]}"; do [ "$rel" = "$x" ] && return 0; done
  return 1
}

# 文件内容比较（有的环境没装 diffutils：cmp/diff 都不存在，会静默全部判定为“有差异”）
files_equal() {
  if command -v cmp >/dev/null 2>&1; then
    cmp -s "$1" "$2"; return $?
  fi
  if command -v diff >/dev/null 2>&1; then
    diff -q "$1" "$2" >/dev/null 2>&1; return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys;sys.exit(0 if open(sys.argv[1],"rb").read()==open(sys.argv[2],"rb").read() else 1)' "$1" "$2"
    return $?
  fi
  # 最后退回逐行读取（纯 bash）
  local a b
  a=$(cksum < "$1" 2>/dev/null) || return 1
  b=$(cksum < "$2" 2>/dev/null) || return 1
  [ "$a" = "$b" ]
}

# settings.json 里属于"模型相关"的字段：同步后保留本地值
SETTINGS_PROTECT_KEYS='["defaultProvider","defaultModel","defaultThinkingLevel","models"]'
PROTECT_PY='import json, sys
new_p, old_p, keys = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
try:
    new = json.load(open(new_p, encoding="utf-8"))
except Exception:
    sys.exit(0)
try:
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
'
# protect_settings <本地旧 settings.json>
protect_settings() {
  local old="$1" t="$PI_AGENT_DIR/settings.json"
  [ -f "$t" ] || return 0
  [ -f "$old" ] || return 0
  command -v python3 >/dev/null 2>&1 || { echo "      ⚠ 未找到 python3，settings.json 的默认模型可能被仓库值覆盖"; return 0; }
  python3 -c "$PROTECT_PY" "$t" "$old" "$SETTINGS_PROTECT_KEYS" || true
}

# auth.json 缺失时从 example 生成（明文模板，Key 为 PASTE_YOUR_... 占位符）
ensure_auth_json() {
  if [ ! -f "$PI_AGENT_DIR/auth.json" ] && [ -f "$PI_AGENT_DIR/auth.json.example" ]; then
    cp "$PI_AGENT_DIR/auth.json.example" "$PI_AGENT_DIR/auth.json"
    chmod 600 "$PI_AGENT_DIR/auth.json"
    echo "  已从 auth.json.example 生成 auth.json（明文模板，需填真实 Key）"
  fi
}

# 占位符检查：仓库里只有 PASTE_YOUR_... 占位符（明文直填策略）
PLACEHOLDER_RE='PASTE_YOUR_|PASTE_|sk-PASTE|[$][{]PI_|[$]PI_[A-Z_]+_API_KEY|[{]env:[A-Z_]+[}]'
check_placeholders() {
  local f found=0
  for f in "$PI_AGENT_DIR/models.json" "$PI_AGENT_DIR/auth.json" "$PI_AGENT_DIR/mcp.json"; do
    [ -f "$f" ] || continue
    if grep -qE "$PLACEHOLDER_RE" "$f" 2>/dev/null; then
      echo "  ⚠ $f 中仍有未填的占位符："
      grep -nE "$PLACEHOLDER_RE" "$f" | sed 's/^/      /'
      found=1
    fi
  done
  if [ "$found" = "1" ]; then
    echo "    → 现在用明文：把真实 Key 直接粘贴替换掉这些占位符即可（不需要环境变量 / pi-secrets.env）。"
  fi
}

# ── 差异块交互合并（python3）─────────────────────────────────────────────────────
# 脚本经 -c 传入，保留 stdin 给 input() 交互；避免 heredoc 占用 stdin 导致选择失效
MERGE_PY='import sys, difflib
local_path, repo_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
local = open(local_path, encoding="utf-8").read().splitlines()
repo = open(repo_path, encoding="utf-8").read().splitlines()
sm = difflib.SequenceMatcher(None, local, repo, autojunk=False)
out, mode_all = [], None
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == "equal":
        out.extend(local[i1:i2]); continue
    if mode_all == "local":
        out.extend(local[i1:i2]); continue
    if mode_all == "repo":
        out.extend(repo[j1:j2]); continue
    a, b = local[i1:i2], repo[j1:j2]
    ln = i1 + 1
    print(f"\n----- 差异块 @ 本地第 {ln} 行 -----")
    print("--- 本地 ---");  print("\n".join(a) if a else "(本地无此内容)")
    print("--- 仓库 ---");  print("\n".join(b) if b else "(仓库无此内容)")
    while True:
        try:
            c = input("选择 [1]保留本地 [2]采用仓库 [3]两者都要(本地在前) [s]本文件剩余全用本地 [a]本文件剩余全用仓库: ").strip().lower()
        except EOFError:
            c = "1"
        if c in ("1", "2", "3", "s", "a"):
            break
    if c == "1": out.extend(a)
    elif c == "2": out.extend(b)
    elif c == "3": out.extend(a + b)
    elif c == "s": mode_all = "local"; out.extend(a)
    elif c == "a": mode_all = "repo"; out.extend(b)
open(out_path, "w", encoding="utf-8").write("\n".join(out) + "\n")'

# 用法: merge_file <本地文件> <仓库文件> <输出文件>
merge_file() {
  python3 -c "$MERGE_PY" "$1" "$2" "$3"
}
HAS_PY_MERGE=1
command -v python3 >/dev/null 2>&1 || HAS_PY_MERGE=0

# mcp/ 下文件的还原目标路径映射
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

# =============================================================================
# 模式一：交互合并（默认）
# =============================================================================
if [ "$MODE" = "merge" ]; then
  INTERACTIVE=1; [ -t 0 ] || INTERACTIVE=0
  # 测试/自动化覆写：强制启用交互分支（stdin 为管道时默认禁用）
  [ "${PI_RESTORE_FORCE_INTERACTIVE:-0}" = "1" ] && INTERACTIVE=1
  mkdir -p "$PI_AGENT_DIR"
  [ "$INTERACTIVE" = "1" ] || echo "  ⚠ 非交互终端：仅安装本地缺失的文件，有差异的文件保留本地（重跑 bash restore.sh 可交互合并）"
  [ -d "$MERGE_BAK" ] || mkdir -p "$MERGE_BAK"

  backup_local() {  # backup_local <目标文件>
    local t="$1" rel
    rel="${t#"$PI_AGENT_DIR"/}"
    mkdir -p "$MERGE_BAK/$(dirname "$rel")"
    cp -a "$t" "$MERGE_BAK/$rel" 2>/dev/null || true
  }

  # 注意：文件列表走 fd3，避免占用 stdin —— 循环体内的交互式 read
  # 与 python 融合器的 input() 必须能读到用户的终端输入
  while IFS= read -r rel <&3; do
    case "$rel" in
      agent/*) target="$PI_AGENT_DIR/${rel#agent/}" ;;
      mcp/*)   target="$(mcp_target "$rel")" ;;
      *) continue ;;
    esac
    [ -n "$target" ] || continue
    src="$HERE/$rel"

    # 模型 / 鉴权类文件不同步：本地已有就一律不动（新机器上本地没有，仍会安装模板）
    if is_no_sync "$rel" && [ -f "$target" ]; then
      SKIPPED_FILES+=("$rel（模型/鉴权，不同步）")
      continue
    fi

    if [ ! -f "$target" ]; then
      if [ "$INTERACTIVE" = "1" ]; then
        printf "  [新增] %s 仓库有、本地没有。安装? [Y/n] " "$rel"
        read -r ans || ans="Y"
        case "$ans" in [nN]*) SKIPPED_FILES+=("$rel"); continue ;; esac
      fi
      mkdir -p "$(dirname "$target")"; cp -a "$src" "$target"
      MODIFIED_FILES+=("新增 $rel"); echo "    ✅ 已安装 $target"
      case "$rel" in agent/models.json|agent/auth.json|*/agent-mcp.json) echo "       ℹ 该文件里是 PASTE_YOUR_... 占位符，记得填真实 Key（明文）" ;; esac
      continue
    fi

    if files_equal "$src" "$target"; then continue; fi

    # 二进制文件（如 fff 索引）不做逐块融合，只允许 A/B
    if ! grep -qI "" "$target" 2>/dev/null || ! grep -qI "" "$src" 2>/dev/null; then
      if [ "$INTERACTIVE" = "1" ]; then
        printf "  [二进制差异] %s\n    [A]以仓库为主 [B]以本地为主 (默认A): " "$rel"
        read -r ans || ans="A"
        case "$ans" in [bB]*) echo "    ⏭ 保留本地"; continue ;; esac
        backup_local "$target"; cp -a "$src" "$target"; MODIFIED_FILES+=("二进制覆盖 $rel")
        echo "    ✅ 已覆盖 $target（旧版在 $MERGE_BAK）"
      fi
      continue
    fi

    if [ "$INTERACTIVE" = "1" ]; then
      echo ""
      echo "  [差异] $rel（本地 与 仓库 不一致）"
      echo "    [A]以远程为主 [B]以本地为主 [C]两者融合（逐个差异块挑选） [s]稍后处理（保留本地）"
      printf "    请选择 (默认B): "
      read -r ans || ans="B"
      case "$ans" in
        [aA])
          backup_local "$target"; cp -a "$src" "$target"
          MODIFIED_FILES+=("A/仓库 $rel"); echo "    ✅ 已采用仓库版本（本地旧版备份于 $MERGE_BAK）"
          ;;
        [cC])
          if [ "$HAS_PY_MERGE" != "1" ]; then
            echo "    ⚠ 未找到 python3，无法逐块融合；请选 A 或 B"
            SKIPPED_FILES+=("$rel"); echo "    ⏭ 保留本地"
          else
            backup_local "$target"
            if merge_file "$target" "$src" "$target.merged"; then
              mv "$target.merged" "$target"
              MODIFIED_FILES+=("C/融合 $rel"); echo "    ✅ 已融合写入 $target（合并前版本备份于 $MERGE_BAK）"
            else
              [ -f "$target.merged" ] && { mv "$target.merged" "$target"; MODIFIED_FILES+=("C/融合 $rel"); } \
                || { echo "    ⚠ 融合失败，保留本地"; SKIPPED_FILES+=("$rel"); }
            fi
          fi
          ;;
        [sS]|"")
          SKIPPED_FILES+=("$rel"); echo "    ⏭ 保留本地"
          ;;
        *)
          SKIPPED_FILES+=("$rel"); echo "    ⏭ 保留本地（B）"
          ;;
      esac
    fi
  done 3< <(cd "$HERE" && git ls-files agent mcp 2>/dev/null || find agent mcp -type f | sort)

  # 仅本地存在的文件提示（不会删除）
  echo ""
  echo "==> 仅本地存在的文件/目录（已保留，不受还原影响）:"
  comm -23 \
    <(cd "$PI_AGENT_DIR" && find . -path ./sessions -prune -o -type f -print | sed 's|^\./|agent/|' | sort) \
    <(cd "$HERE" && git ls-files agent | sort) | head -20 | sed 's/^/    /' || true

  protect_settings "$MERGE_BAK/settings.json"
  ensure_auth_json
  check_placeholders

  echo ""
  echo "=============================================="
  echo " ✅ 交互合并还原完成"
  [ "${#MODIFIED_FILES[@]}" -gt 0 ] && printf '    变更 %d 项:\n%s\n' "${#MODIFIED_FILES[@]}" "$(printf '      %s\n' "${MODIFIED_FILES[@]}")"
  [ "${#SKIPPED_FILES[@]}" -gt 0 ] && printf '    保留本地 %d 项（如需采用仓库可重跑并选 A）:\n%s\n' "${#SKIPPED_FILES[@]}" "$(printf '      %s\n' "${SKIPPED_FILES[@]}")"
  echo "    合并前备份: $MERGE_BAK"
  echo "    模型/鉴权文件未同步（保留本机版本）: ${NO_SYNC_FILES[*]}"
  echo "    重启 pi 后生效。"
  echo "=============================================="
  exit 0
fi

# =============================================================================
# 模式二：全新覆盖（--fresh，旧行为）
# =============================================================================
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
    echo "    pi 启动时会按需重新获取（或从系统包管理器安装 fd、ripgrep）。"
  fi
fi

# MCP 配置还原（按原路径映射）
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

ensure_auth_json

chmod 600 "$PI_AGENT_DIR/models.json" "$PI_AGENT_DIR/mcp.json" "$PI_AGENT_DIR/auth.json" 2>/dev/null || true

check_placeholders

# 密钥不再询问：明文策略下直接把 Key 写进 models.json / auth.json / mcp.json 即可

# npm 包重装（需联网）
if [ -f "$PI_AGENT_DIR/extensions/bash-guard/package.json" ]; then
  echo "==> 安装 bash-guard 扩展依赖（shell-quote）..."
  if command -v npm >/dev/null 2>&1; then
    (cd "$PI_AGENT_DIR/extensions/bash-guard" && npm install --omit=dev 2>&1 | tail -2) \
      && echo "  ✅ bash-guard 扩展依赖已安装" \
      || echo "  ⚠ bash-guard npm install 失败（需联网）。缺失时 bash-guard 扩展会报 shell-quote 找不到。"
  else
    echo "  ⚠ 未找到 npm，跳过 bash-guard 依赖安装（pi 启动后扩展可能报错）。"
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

# 密钥不再询问：明文策略下直接把 Key 写进 models.json / auth.json / mcp.json 即可

echo ""
echo "=============================================="
echo " ✅ 全新覆盖还原完成！现在启动 pi 即可。"
echo "    首次启动会自动安装 settings.json 中声明的全部 packages，"
echo "    并加载扩展 / Skills / MCP 配置。"
echo "    模型/鉴权文件已保留本机版本；仓库只提供带 PASTE_YOUR_... 占位符的模板。"
echo "=============================================="
