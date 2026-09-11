#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pi-config 还原引擎（由 restore.sh 调用，也可单独运行）

相比旧版逐文件询问的改进：
  1. 三方对比：上次同步时的仓库快照(base) / 本地当前 / 仓库当前
     → 区分「仅仓库改」「仅本地改」「两边都改（冲突）」「本地缺失」，默认动作更聪明
  2. 先扫描汇总（按类别给出 新增/仅仓库改/冲突/仅本地改 数量），再一次性选处理方式，
     不必对着几百个文件逐个按键
  3. 支持批量动作（智能推荐 / 全采用仓库 / 全保留本地 / 逐文件 / 只报告）
     + 逐文件时可看 diff、可"本文件剩余全用某侧"、可"剩余文件全部交给某侧"
  4. 支持 --only 类别过滤、--dry-run 预览、--status 只报告、--yes 非交互
  5. 模型 / 鉴权文件（models.json、models-store.json、auth.json）与 settings.json 的
     默认模型字段永不覆盖；每次同步写 .pi-config-sync.json 作为下次对比的基准

用法:
  python3 restore-engine.py --repo-root <仓库根> --agent-dir <~/.pi/agent> [选项]
选项:
  --mode merge|status      默认 merge；status = 只报告
  --only ext,skills,mcp    限定类别（默认全部）
  --dry-run                只报告不写入
  --yes                    非交互：采用"智能推荐"
  --home <dir>             用于 mcp 目标路径映射（默认 $HOME）
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

NO_SYNC = ("agent/models.json", "agent/models-store.json", "agent/auth.json")
PROTECT_KEYS = ("defaultProvider", "defaultModel", "defaultThinkingLevel", "models")
MANIFEST_NAME = ".pi-config-sync.json"
PLACEHOLDER_RE = ("PASTE_YOUR_", "sk-PASTE", "${PI_", "$PI_", "{env:")

CATEGORY_RULES = (
    ("ext", "插件扩展", lambda r: r.startswith("agent/extensions/") or r.startswith("agent/extensions-disabled/")),
    ("skills", "技能 Skill", lambda r: r.startswith("agent/skills/")),
    ("mcp", "MCP 配置", lambda r: r.startswith("mcp/")),
    ("npm", "npm 清单", lambda r: r.startswith("agent/npm/")),
    ("misc", "其他配置", lambda r: True),
)

# 状态 → (标签, 智能推荐动作)
STATUS_INFO = {
    "missing": ("本地缺失", "A"),
    "repo-only": ("仅仓库改", "A"),
    "local-only": ("仅本地改", "B"),
    "conflict": ("冲突", "B"),
    "unknown": ("无基准(首次)", "B"),
    "binary": ("二进制", "B"),
}


# ── 基础工具 ────────────────────────────────────────────────────────────────
def md5(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def is_text(path: str) -> bool:
    try:
        with open(path, "rb") as fh:
            return b"\0" not in fh.read(4096)
    except OSError:
        return False


def read_text(path: str):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read().splitlines()


def same_file(a: str, b: str) -> bool:
    try:
        if os.path.getsize(a) != os.path.getsize(b):
            return False
        return md5(a) == md5(b)
    except OSError:
        return False


def category_of(rel: str):
    for key, label, test in CATEGORY_RULES:
        if test(rel):
            return key, label
    return "misc", "其他配置"


def mcp_target(rel: str, agent_dir: str, home: str):
    mapping = {
        "mcp/agent-mcp.json": os.path.join(agent_dir, "mcp.json"),
        "mcp/pi-mcp.json": os.path.join(home, ".pi", "mcp.json"),
        "mcp/config-mcp.json": os.path.join(home, ".config", "mcp", "mcp.json"),
        "mcp/agents-mcp.json": os.path.join(home, ".agents", "mcp.json"),
        "mcp/agents-mcp-mcp.json": os.path.join(home, ".agents", "mcp", "mcp.json"),
    }
    return mapping.get(rel)


def ask(prompt: str, valid, default: str = "") -> str:
    while True:
        try:
            ans = input(prompt).strip().lower()
        except EOFError:
            ans = ""
        if not ans and default:
            return default
        if ans in valid:
            return ans
        print("    输入无效，请重选。")


def repo_files(root: str):
    try:
        out = subprocess.run(["git", "-C", root, "ls-files", "agent", "mcp"],
                             capture_output=True, text=True, check=True).stdout
        files = [ln for ln in out.splitlines() if ln.strip()]
        if files:
            return sorted(files)
    except Exception:
        pass
    files = []
    for base in ("agent", "mcp"):
        root_dir = os.path.join(root, base)
        for dirpath, _dirs, names in os.walk(root_dir):
            for name in names:
                files.append(os.path.relpath(os.path.join(dirpath, name), root))
    return sorted(files)


# ── 差异块融合（C 选项）─────────────────────────────────────────────────────
def merge_blocks(local_path: str, repo_path: str, out_path: str, name: str) -> bool:
    local = read_text(local_path)
    repo = read_text(repo_path)
    sm = difflib.SequenceMatcher(None, local, repo, autojunk=False)
    out, mode_all = [], None
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out.extend(local[i1:i2])
            continue
        if mode_all == "local":
            out.extend(local[i1:i2])
            continue
        if mode_all == "repo":
            out.extend(repo[j1:j2])
            continue
        a, b = local[i1:i2], repo[j1:j2]
        print("\n  ── 差异块 @ 本地第 %d 行 ──" % (i1 + 1))
        print("  ▸ 本地 ──")
        for ln in (a or ["(本地无此内容)"]):
            print("    | " + ln)
        print("  ▸ 仓库 ──")
        for ln in (b or ["(仓库无此内容)"]):
            print("    | " + ln)
        c = ask("    选 [1]保留本地 [2]采用仓库 [3]两者都要(本地在前) "
                "[s]本文件剩余全用本地 [a]本文件剩余全用仓库: ",
                ("1", "2", "3", "s", "a"), "1")
        if c == "1":
            out.extend(a)
        elif c == "2":
            out.extend(b)
        elif c == "3":
            out.extend(a + b)
        elif c == "s":
            mode_all = "local"
            out.extend(a)
        else:
            mode_all = "repo"
            out.extend(b)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out) + "\n")
    return True


def show_diff(local_path: str, repo_path: str, name: str, limit: int = 60):
    a, b = read_text(local_path), read_text(repo_path)
    diff = list(difflib.unified_diff(a, b, "本地/" + name, "仓库/" + name, lineterm="", n=3))
    print("  ── diff（- 本地 / + 仓库）──")
    for ln in diff[:limit]:
        print("    " + ln)
    if len(diff) > limit:
        print("    ... 共 %d 行差异（已截断）" % len(diff))


def protect_settings_values(target: str, old_local: str):
    """把本地 settings.json 的模型相关字段写回（同步不覆盖默认模型）"""
    if not (os.path.isfile(target) and os.path.isfile(old_local)):
        return []
    try:
        with open(target, encoding="utf-8") as fh:
            new = json.load(fh)
        with open(old_local, encoding="utf-8") as fh:
            old = json.load(fh)
    except Exception:
        return []
    changed = [k for k in PROTECT_KEYS if k in old and new.get(k) != old[k]]
    for k in changed:
        new[k] = old[k]
    if changed:
        with open(target, "w", encoding="utf-8") as fh:
            json.dump(new, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    return changed


# ── 主流程 ─────────────────────────────────────────────────────────────────
class Entry:
    __slots__ = ("rel", "cat", "cat_label", "src", "target", "status", "protected")

    def __init__(self, rel, cat, cat_label, src, target, status, protected):
        self.rel, self.cat, self.cat_label = rel, cat, cat_label
        self.src, self.target = src, target
        self.status, self.protected = status, protected


def build_entries(repo_root, agent_dir, home, manifest, only):
    base = (manifest or {}).get("base") or {}
    entries, protected_notes = [], []
    for rel in repo_files(repo_root):
        cat, label = category_of(rel)
        if only and cat not in only:
            continue
        target = mcp_target(rel, agent_dir, home) if rel.startswith("mcp/") \
            else os.path.join(agent_dir, rel[len("agent/"):]) if rel.startswith("agent/") else None
        if not target:
            continue
        src = os.path.join(repo_root, rel)
        if not os.path.isfile(src):
            continue
        is_nosync = rel in NO_SYNC
        protected = False
        if not os.path.exists(target):
            status = "missing"          # 本机没有 → 装仓库模板（即使它是模型/鉴权文件）
        elif same_file(src, target):
            status = "same"
        elif is_nosync:
            protected = True            # 模型/鉴权：本地有就永不覆盖
            protected_notes.append(rel)
            status = "same"
        elif not is_text(src) or not is_text(target):
            status = "binary"
        elif rel not in base:
            status = "unknown"
        else:
            local_changed = md5(target) != base[rel]
            repo_changed = md5(src) != base[rel]
            if repo_changed and not local_changed:
                status = "repo-only"
            elif local_changed and not repo_changed:
                status = "local-only"
            elif local_changed and repo_changed:
                status = "conflict"
            else:
                status = "same"
        if status == "same":
            continue
        entries.append(Entry(rel, cat, label, src, target, status, protected))
    return entries, protected_notes


def print_summary(entries, only, dry=False, protected_notes=()):
    order = [c[0] for c in CATEGORY_RULES]
    print("")
    print("==> 差异汇总" + ("（dry-run，不会写入）" if dry else "")
          + ("，类别: " + ",".join(only) if only else ""))
    if not entries:
        print("    ✅ 仓库与本地已一致，无需处理。")
        if protected_notes:
            print("    （另有 %d 个模型/鉴权文件按策略跳过：%s）"
                  % (len(protected_notes), ", ".join(sorted(protected_notes))))
        return
    print("    %-12s %6s %8s %8s %8s" % ("类别", "新增", "仅仓库改", "冲突", "仅本地改"))
    for key in order:
        rows = [e for e in entries if e.cat == key]
        if not rows:
            continue
        label = next(l for k, l, _ in CATEGORY_RULES if k == key)
        cnt = lambda s: len([e for e in rows if e.status == s])
        print("    %-12s %6d %8d %8d %8d" % (label, cnt("missing"), cnt("repo-only"),
                                             cnt("conflict") + cnt("binary") + cnt("unknown"),
                                             cnt("local-only")))
    print("    " + "-" * 46)
    cnt = lambda s: len([e for e in entries if e.status == s])
    print("    合计: 新增 %d，仅仓库改 %d，冲突/无基准 %d，仅本地改 %d"
          % (cnt("missing"), cnt("repo-only"),
             cnt("conflict") + cnt("binary") + cnt("unknown"), cnt("local-only")))
    if protected_notes:
        print("    另有 %d 个模型/鉴权文件按策略跳过（本地已有，永不覆盖）: %s"
              % (len(protected_notes), ", ".join(sorted(protected_notes))))


def process(entries, agent_dir, backup_dir, dry, interactive, bulk=None):
    """返回 (changed, kept) 两个列表"""
    changed, kept = [], []
    mode_all = bulk          # "S"=按状态推荐，"A"/"B"=剩余全交给某一侧
    total = len(entries)
    for idx, e in enumerate(entries, 1):
        if e.protected:
            kept.append((e, "模型/鉴权，不参与同步"))
            continue
        action = None
        if mode_all == "S":
            action = STATUS_INFO[e.status][1]
        elif mode_all:
            action = mode_all
        elif e.status == "missing":
            action = "A"
        elif not interactive:
            action = STATUS_INFO[e.status][1]
        else:
            label = STATUS_INFO[e.status][0]
            print("\n  [%d/%d] %s   —— %s" % (idx, total, e.rel, label))
            while action is None:
                opts = "[A]用仓库 [B]保留本地%s [d]看diff [a]剩余全用仓库 [l]剩余全保留本地 [q]中止" \
                       % (" [C]逐块融合" if e.status != "binary" else "")
                c = ask("    %s: " % opts, ("a", "b", "c", "d", "l", "q"),
                        STATUS_INFO[e.status][1].lower())
                if c == "d":
                    show_diff(e.target, e.src, e.rel)
                elif c == "c" and e.status == "binary":
                    print("    二进制文件不支持逐块融合，请选 A/B。")
                elif c in ("a", "l"):
                    mode_all = "A" if c == "a" else "B"
                    action = mode_all
                elif c == "q":
                    print("    ⏹ 用户中止；已处理的文件不会回滚（备份见 %s）" % backup_dir)
                    return changed, kept
                else:
                    action = c.upper()
        if action == "B":
            kept.append((e, "保留本地"))
            continue
        if action == "C":
            if dry:
                changed.append((e, "融合(dry-run)"))
                continue
            backup_file(e.target, agent_dir, backup_dir)
            merged = e.target + ".merged"
            try:
                merge_blocks(e.target, e.src, merged, e.rel)
                shutil.move(merged, e.target)
                changed.append((e, "融合"))
            except Exception as exc:  # 融合失败不破坏本地
                if os.path.exists(merged):
                    os.remove(merged)
                kept.append((e, "融合失败，保留本地: %s" % exc))
            continue
        # action == "A"
        if dry:
            changed.append((e, "采用仓库(dry-run)" if e.status != "missing" else "安装(dry-run)"))
            continue
        os.makedirs(os.path.dirname(e.target), exist_ok=True)
        if os.path.exists(e.target):
            backup_file(e.target, agent_dir, backup_dir)
        shutil.copy2(e.src, e.target)
        if e.rel == "agent/settings.json":
            kept_keys = protect_settings_values(e.target, os.path.join(backup_dir, "settings.json"))
            if kept_keys:
                print("      ↳ settings.json 模型字段保持本地值: " + ", ".join(kept_keys))
        changed.append((e, "安装" if e.status == "missing" else "采用仓库"))
    return changed, kept


def backup_file(target, agent_dir, backup_dir):
    if not backup_dir or not os.path.exists(target):
        return
    rel = os.path.relpath(target, agent_dir) if target.startswith(agent_dir) else \
        os.path.join("_external", os.path.basename(target))
    dst = os.path.join(backup_dir, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(target, dst)


def placeholder_report(agent_dir, home):
    targets = [os.path.join(agent_dir, "models.json"), os.path.join(agent_dir, "auth.json"),
               os.path.join(agent_dir, "mcp.json")]
    hits = []
    for path in targets:
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                for num, line in enumerate(fh, 1):
                    if any(tok in line for tok in PLACEHOLDER_RE):
                        hits.append("      %s:%d %s" % (path, num, line.strip()))
        except OSError:
            continue
    if hits:
        print("")
        print("  ⚠ 以下位置仍是占位符 / 环境变量引用（明文策略下直接填真实 Key 即可）：")
        print("\n".join(hits[:20]))
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--repo-root", required=True)
    ap.add_argument("--agent-dir", required=True)
    ap.add_argument("--home", default=os.path.expanduser("~"))
    ap.add_argument("--mode", default="merge", choices=("merge", "status", "manifest"))
    ap.add_argument("--only", default="")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--take-repo", action="store_true", help="非交互：全部采用仓库（除模型/鉴权文件）")
    ap.add_argument("--keep-local", action="store_true", help="非交互：全部保留本地，只补齐缺失文件")
    ap.add_argument("--no-color", action="store_true")
    args = ap.parse_args()

    repo_root = os.path.abspath(args.repo_root)
    agent_dir = os.path.abspath(args.agent_dir)
    only = [x.strip() for x in args.only.split(",") if x.strip()]
    manifest_path = os.path.join(agent_dir, MANIFEST_NAME)
    manifest = None
    if os.path.isfile(manifest_path):
        try:
            with open(manifest_path, encoding="utf-8") as fh:
                manifest = json.load(fh)
        except Exception:
            manifest = None

    print("==> 仓库: %s" % repo_root)
    print("==> 目标: %s" % agent_dir)

    if args.mode == "manifest":
        write_manifest(repo_root, agent_dir, manifest_path)
        print("==> 已写入同步基准: %s" % manifest_path)
        return 0
    if manifest:
        print("==> 上次同步基准: %s（commit %s）"
              % (manifest.get("synced_at", "?"), str(manifest.get("repo_commit", "?"))[:7]))
    else:
        print("==> 无同步基准（首次同步）：只区分「本地缺失 / 有差异」，差异一律默认保留本地")

    entries, protected_notes = build_entries(repo_root, agent_dir, args.home, manifest, only)
    print_summary(entries, only, dry=args.dry_run or args.mode == "status",
                  protected_notes=protected_notes)

    # 仅本地有的文件（只报告，不删）
    try:
        tracked = set(repo_files(repo_root))
        local_extra = []
        for dirpath, dirs, names in os.walk(agent_dir):
            dirs[:] = [d for d in dirs if d not in ("sessions", "node_modules", ".git")]
            for name in names:
                rel = "agent/" + os.path.relpath(os.path.join(dirpath, name), agent_dir)
                if rel not in tracked and MANIFEST_NAME not in rel:
                    local_extra.append(rel)
        if local_extra:
            print("    仅本地存在的文件（保留，不受影响）: %d 个，例如 %s"
                  % (len(local_extra), ", ".join(sorted(local_extra)[:3])))
    except Exception:
        pass

    if args.mode == "status":
        print("")
        print("==> status 模式：只报告，未写入任何文件。")
        return 0

    if not entries:
        if not args.dry_run:
            write_manifest(repo_root, agent_dir, manifest_path)
        placeholder_report(agent_dir, args.home)
        return 0

    bulk = None
    if args.take_repo:
        bulk = "A"
        print("    --take-repo：非交互，全部采用仓库版本（模型/鉴权文件仍跳过）")
    elif args.keep_local:
        bulk = "B"
        print("    --keep-local：非交互，全部保留本地，只补齐缺失文件")
    elif args.yes:
        bulk = "S"
        print("    --yes：非交互，按智能推荐处理（新增/仅仓库改→用仓库，其余保留本地）")
    elif args.dry_run:
        pass
    elif not sys.stdin.isatty():
        print("    ⚠ 非交互终端：新增与「仅仓库改」采用仓库版本，冲突/仅本地改的保留本地。")
        bulk = "S"
    else:
        print("")
        print("  处理方式：")
        print("    [1] 智能推荐（新增/仅仓库改→用仓库；冲突/仅本地改→保留本地）  ← 默认")
        print("    [2] 全部采用仓库版本（模型/鉴权文件仍跳过）")
        print("    [3] 全部保留本地（只补齐缺失文件）")
        print("    [4] 逐文件选择（A/B/C/s，可 d 看 diff）")
        print("    [5] 只报告不写入（等于 --dry-run）")
        print("    [q] 退出")
        choice = ask("  请选择 [1/2/3/4/5/q]: ", ("1", "2", "3", "4", "5", "q"), "1")
        if choice == "q":
            print("  已退出，未做任何修改。")
            return 0
        if choice == "2":
            bulk = "A"
        elif choice == "3":
            bulk = "B"
        elif choice == "4":
            bulk = None
        elif choice == "5":
            args.dry_run = True
        else:
            bulk = "S"

    interactive = (bulk is None) and not args.dry_run and sys.stdin.isatty()
    backup_dir = os.path.join(agent_dir + ".merge-bak-" + time.strftime("%Y%m%d-%H%M%S"))
    if not args.dry_run:
        os.makedirs(backup_dir, exist_ok=True)

    changed, kept = process(entries, agent_dir, backup_dir, args.dry_run, interactive, bulk)

    if not args.dry_run:
        ensure_auth_json(agent_dir)
        write_manifest(repo_root, agent_dir, manifest_path)

    print("")
    print("==============================================")
    if args.dry_run:
        print(" 🔍 dry-run 结束：预计变更 %d 项，保留本地 %d 项（未写入）" % (len(changed), len(kept)))
    else:
        print(" ✅ 合并完成：变更 %d 项，保留本地 %d 项" % (len(changed), len(kept)))
    for e, why in changed[:40]:
        print("      ✔ %s（%s）" % (e.rel, why))
    if len(changed) > 40:
        print("      ... 其余 %d 项略" % (len(changed) - 40))
    for e, why in kept[:20]:
        print("      ⏸ %s（%s）" % (e.rel, why))
    if len(kept) > 20:
        print("      ... 其余 %d 项略" % (len(kept) - 20))
    if not args.dry_run:
        print("    合并前备份: %s" % backup_dir)
        print("    同步基准已更新: %s" % manifest_path)
    placeholder_report(agent_dir, args.home)
    print("==============================================")
    return 0


def ensure_auth_json(agent_dir):
    auth = os.path.join(agent_dir, "auth.json")
    example = os.path.join(agent_dir, "auth.json.example")
    if not os.path.exists(auth) and os.path.isfile(example):
        shutil.copy2(example, auth)
        try:
            os.chmod(auth, 0o600)
        except OSError:
            pass
        print("  已从 auth.json.example 生成 auth.json（明文模板，需填真实 Key）")


def write_manifest(repo_root, agent_dir, manifest_path):
    base = {}
    for rel in repo_files(repo_root):
        src = os.path.join(repo_root, rel)
        if os.path.isfile(src):
            base[rel] = md5(src)
    commit = "unknown"
    try:
        commit = subprocess.run(["git", "-C", repo_root, "rev-parse", "--short", "HEAD"],
                                capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        pass
    data = {"repo_commit": commit, "synced_at": time.strftime("%Y-%m-%d %H:%M:%S"), "base": base}
    try:
        os.makedirs(agent_dir, exist_ok=True)
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
    except OSError as exc:
        print("  ⚠ 无法写入同步基准 %s：%s" % (manifest_path, exc))


if __name__ == "__main__":
    sys.exit(main())
