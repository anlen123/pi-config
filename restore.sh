#!/usr/bin/env bash
# =============================================================================
# Pi 配置还原脚本 (Linux / macOS)
#
# 用法:
#   bash restore.sh            # 交互合并模式（默认）：逐文件对比"本地 ~/.pi/agent"
#                              # 与"本仓库"，差异处可选 A/B/C（见下），最后手动输入密钥
#   bash restore.sh --fresh    # 全新覆盖模式：备份旧配置后整体替换为仓库版本
#
# 差异文件的三种处理方式:
#   A = 以远程（本仓库）为主，覆盖本地（本地旧版会先备份）
#   B = 以本地为主，保留本地不动
#   C = 两者融合：逐个差异块列出"本地 vs 仓库"，由你逐块挑选；
#       单个文件内剩余冲突可一键 "全部保留本地" 或 "全部采用仓库"
#
# 模型供应商密钥（suixiang/agentrouter/modelflare/deepseek/fluxionai/高德MCP）
# 绝不入库：还原完成后脚本会逐项询问并写入 ~/.pi/secrets/pi-secrets.env
# （目录 700 / 文件 600），并在 ~/.zshrc 与 ~/.bashrc 注入自动 source。
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SECRETS_DIR="$HOME/.pi/secrets"
SECRETS_FILE="$SECRETS_DIR/pi-secrets.env"
MODE="merge"
[ "${1:-}" = "--fresh" ] && MODE="fresh"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
MERGE_BAK="$PI_AGENT_DIR.merge-bak-$TIMESTAMP"
MODIFIED_FILES=()
SKIPPED_FILES=()

echo "==> 目标目录: $PI_AGENT_DIR（模式: $MODE）"
[ -d "$HERE/agent" ] || { echo "错误: 当前目录不是 pi-config 仓库（缺少 agent/）"; exit 1; }

# ── 密钥相关函数 ────────────────────────────────────────────────────────────
ensure_secrets_file() {
  mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR" 2>/dev/null || true
  [ -f "$SECRETS_FILE" ] || { echo "# Pi provider secrets - 由 shell 启动时 source（勿提交到任何仓库）" > "$SECRETS_FILE"; }
  chmod 600 "$SECRETS_FILE" 2>/dev/null || true
}

# ensure_key <VAR名> <中文说明>：已配置则提示回车跳过，否则不回显输入
ensure_key() {
  local var="$1" desc="$2" val=""
  if grep -q "^export ${var}=" "$SECRETS_FILE" 2>/dev/null; then
    printf "  %-26s 已配置 ✅（直接回车保留；输入新值则覆盖）: " "$var"
    read -r -s val || val=""
    echo ""
    [ -n "$val" ] || return 0
  else
    printf "  %-26s 未配置，请输入（不回显，回车跳过）: " "$var"
    read -r -s val || val=""
    echo ""
    [ -n "$val" ] || { echo "    ⚠ 跳过 $var（对应功能在配置前不可用）"; return 0; }
  fi
  # 误输入防护：过短的值多半是误按，需确认后才写入（防止污染已配置的密钥）
  if [ ${#val} -lt 16 ]; then
    printf "    ⚠ 输入长度 %d 过短，疑似误输入。确认写入? [y/N] " ${#val}
    read -r c || c=""
    case "$c" in [yY]*) ;; *) echo "    ⏭ 未写入，保留原值"; return 0 ;; esac
  fi
  # 转义替换（值仅限常规密钥字符）
  local esc; esc=$(printf '%s' "$val" | sed 's/[&|]/\\&/g')
  if grep -q "^export ${var}=" "$SECRETS_FILE" 2>/dev/null; then
    sed -i "s#^export ${var}=.*#export ${var}=${esc}#" "$SECRETS_FILE"
  else
    echo "export ${var}=${esc}" >> "$SECRETS_FILE"
  fi
  echo "    ✅ $desc 已写入 $SECRETS_FILE"
}

ensure_shell_source() {
  local block="# Pi provider secrets（models.json / auth.json / mcp.json 的环境变量引用）
if [ -f \"\$HOME/.pi/secrets/pi-secrets.env\" ]; then
  . \"\$HOME/.pi/secrets/pi-secrets.env\"
fi"
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    [ -f "$rc" ] || continue
    if ! grep -q "pi-secrets.env" "$rc"; then
      printf '\n%s\n' "$block" >> "$rc"
      echo "  ✅ 已在 $rc 注入 secrets 自动加载"
    fi
  done
}

input_all_keys() {
  echo ""
  echo "==> 模型供应商密钥（手动输入，写入 $SECRETS_FILE，权限 600，绝不入库）"
  ensure_secrets_file
  ensure_key PI_SUIXIANG_API_KEY    "suixiang（sui-xiang.com）"
  ensure_key PI_AGENTROUTER_API_KEY "agentrouter（agentrouter.org）"
  ensure_key PI_MODELFLARE_API_KEY  "modelflare（modelflare.dev）"
  ensure_key PI_DEEPSEEK_API_KEY    "deepseek 官方 API"
  ensure_key PI_FLUXIONAI_API_KEY   "fluxionai"
  ensure_key PI_ZHIJI_API_KEY       "zhiji（api.zhiji.pro）"
  ensure_key PI_AMAP_MCP_KEY        "高德地图 MCP key"
  ensure_shell_source
  echo "  密钥轮换方法：编辑 $SECRETS_FILE 对应行，重启 shell/pi 即可（旧 Key 请到供应商后台吊销）。"
}

# 兼容旧版 mcp.json 的 {env:AMAP_MCP_KEY} 占位符
fix_legacy_mcp_placeholder() {
  local f="$PI_AGENT_DIR/mcp.json"
  [ -f "$f" ] && grep -q '{env:AMAP_MCP_KEY}' "$f" || return 0
  ensure_secrets_file
  local key=""; grep -q '^export PI_AMAP_MCP_KEY=' "$SECRETS_FILE" && key=$(grep '^export PI_AMAP_MCP_KEY=' "$SECRETS_FILE" | head -1 | sed 's/^export PI_AMAP_MCP_KEY=//')
  if [ -z "$key" ] && [ -n "${AMAP_MCP_KEY:-}" ]; then key="$AMAP_MCP_KEY"; fi
  if [ -n "$key" ]; then
    sed -i "s#{env:AMAP_MCP_KEY}#$key#g" "$f"; echo "  ✅ 已注入高德 key 到 $f"
  else
    echo "  ⚠ $f 仍含 {env:AMAP_MCP_KEY} 旧占位符；建议改用 \${PI_AMAP_MCP_KEY} 并配置 pi-secrets.env"
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

    if [ ! -f "$target" ]; then
      if [ "$INTERACTIVE" = "1" ]; then
        printf "  [新增] %s 仓库有、本地没有。安装? [Y/n] " "$rel"
        read -r ans || ans="Y"
        case "$ans" in [nN]*) SKIPPED_FILES+=("$rel"); continue ;; esac
      fi
      mkdir -p "$(dirname "$target")"; cp -a "$src" "$target"
      MODIFIED_FILES+=("新增 $rel"); echo "    ✅ 已安装 $target"
      continue
    fi

    if cmp -s "$src" "$target"; then continue; fi

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

  input_all_keys
  fix_legacy_mcp_placeholder

  echo ""
  echo "=============================================="
  echo " ✅ 交互合并还原完成"
  [ "${#MODIFIED_FILES[@]}" -gt 0 ] && printf '    变更 %d 项:\n%s\n' "${#MODIFIED_FILES[@]}" "$(printf '      %s\n' "${MODIFIED_FILES[@]}")"
  [ "${#SKIPPED_FILES[@]}" -gt 0 ] && printf '    保留本地 %d 项（如需采用仓库可重跑并选 A）:\n%s\n' "${#SKIPPED_FILES[@]}" "$(printf '      %s\n' "${SKIPPED_FILES[@]}")"
  echo "    合并前备份: $MERGE_BAK"
  echo "    重启 pi / 新开终端后生效（密钥环境变量需重新 source）。"
  echo "=============================================="
  exit 0
fi

# =============================================================================
# 模式二：全新覆盖（--fresh，旧行为）
# =============================================================================
echo "==> 全新覆盖模式：备份现有配置后整体替换"
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
echo "  已还原: settings.json / models.json / extensions / extensions-disabled / skills 等"

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

# auth.json：不存在时从 example 生成（$PI_*_API_KEY 环境变量引用，无明文）
if [ ! -f "$PI_AGENT_DIR/auth.json" ] && [ -f "$PI_AGENT_DIR/auth.json.example" ]; then
  cp "$PI_AGENT_DIR/auth.json.example" "$PI_AGENT_DIR/auth.json"
  chmod 600 "$PI_AGENT_DIR/auth.json"
  echo "  已从 auth.json.example 生成 auth.json（\$PI_*_API_KEY 环境变量引用）"
fi

chmod 600 "$PI_AGENT_DIR/models.json" "$PI_AGENT_DIR/mcp.json" "$PI_AGENT_DIR/auth.json" 2>/dev/null || true

# 兼容旧占位符
fix_legacy_mcp_placeholder

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

# 密钥手动输入
input_all_keys

echo ""
echo "=============================================="
echo " ✅ 全新覆盖还原完成！现在启动 pi 即可。"
echo "    首次启动会自动安装 settings.json 中声明的全部 packages，"
echo "    并加载扩展 / Skills / MCP 配置。"
echo "    密钥位于 $SECRETS_FILE（如跳过输入可稍后补填）。"
echo "=============================================="
