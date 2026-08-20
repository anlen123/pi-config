---
name: win-bat-script
description: >
  Windows .bat 文件创建规范。当用户要求在 Windows 上创建 .bat/.cmd 批处理脚本、
  一键部署脚本、自动化脚本，或需要修正已有的 .bat 文件时使用。适用于涉及中文
  输出、Git 操作、npm/npx 命令等场景的批处理脚本。
  TRIGGER: 用户说"写个bat"、"bat脚本"、"批处理"、"一键脚本"、"双击运行"、
  ".bat文件"、"cmd脚本"、或提到 Windows 批处理。
---

# Windows .bat 脚本创建规范

在 Windows（特别是中文 Windows 10/11）上编写 `.bat` 文件时，编码和格式决定了脚本
能不能跑。本规范总结踩过的坑和正确的做法。

## 核心规则

### 1. 编码：UTF-8 with BOM

**必须**使用 UTF-8 with BOM（`EF BB BF` 开头）。cmd.exe 需要 BOM 来识别 UTF-8 文件。

**不要**使用 UTF-8 without BOM —— `chcp 65001` 激活后，非 BOM 的 UTF-8 文件可能因为
字节对齐问题导致首行命令被截断（如 `@echo off` 变成 `echo off`）。

纯 ASCII 内容（无中文）对 BOM 的要求较宽松，但加了 BOM 更安全。

### 2. 换行符：CRLF (`\r\n`)

**必须**使用 Windows 风格换行符 CRLF。LF-only 的 `.bat` 文件在 cmd.exe 中可能导致
命令被截断或合并，表现极其诡异（如 `git commit` 变成 `t commit`）。

### 3. 空行：用 `echo/` 而非 `echo.`

中文 Windows 上 `echo.` 可能报错 `'echo.' 不是内部或外部命令`。原因：cmd 会在当前目录
查找名为 `echo` 的文件（无扩展名），找不到就报错。替换方案（按可靠性排序）：

| 写法 | 说明 |
|------|------|
| `echo/` | **推荐**，最可靠 |
| `echo(` | 也可，略丑 |
| `echo;` | 也可 |

### 4. 重定向到 stderr：用 `>nul` 而非 `>/dev/null`

Windows 的空设备是 `nul`，不是 `/dev/null`。Git Bash 下写脚本容易顺手写成后者。

```batch
:: 正确
git commit -m "msg" 2>nul

:: 错误——在 .bat 里不成立
git commit -m "msg" 2>/dev/null
```

### 5. 中文输出：先 `chcp 65001`

脚本中如果有中文 echo，必须在最开头（`@echo off` 之后）切到 UTF-8 代码页：

```batch
@echo off
chcp 65001 >nul
```

> **注意**：如果脚本内容全是 ASCII（echo 用英文），可以不用 `chcp 65001`，省去一个
> 编码隐患。能用 ASCII 就用 ASCII。

### 6. 日期时间：用子串截取

中文 Windows 的 `%date%` 包含星期几（如 `2026/06/29 周一`），`%time%` 包含毫秒
（如 `16:39:03.67`）。做 commit message 时要用子串截取：

```batch
git commit -m "deploy: %date:~0,10% %time:~0,8%" 2>nul
```

`%date:~0,10%` 取前 10 个字符 = `2026/06/29`
`%time:~0,8%` 取前 8 个字符 = `16:39:03`

## 推荐模板

最小化中文、最小化问题的模板：

```batch
@echo off
cd /d "%~dp0"

echo ============================================
echo    My Script
echo ============================================
echo/

echo [1/3] Step one...
<your command here>

echo/
echo [2/3] Step two...
<your command here>

echo/
echo [3/3] Step three...
<your command here>

echo/
echo ============================================
echo    Done!
echo ============================================
pause
```

如果有中文，加上 `chcp 65001`：

```batch
@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 开始执行...
```

## 写入方法

**用 Python 写入**，不要用 bash heredoc 或 Write 工具。Python 能精确控制 BOM 和 CRLF：

```python
import codecs

content = '''@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 你好
pause
'''

with open('script.bat', 'w', encoding='utf-8-sig', newline='\r\n') as f:
    f.write(content.lstrip())
```

关键参数：
- `encoding='utf-8-sig'` → 写入 UTF-8 with BOM
- `newline='\r\n'` → 使用 CRLF 换行符
- `.lstrip()` → 去除模板字符串开头的空行

**不要**用 `encoding='utf-8'`（缺 BOM）或省略 `newline` 参数（会随平台变化）。

## 常见问题速查

| 错误信息 | 原因 | 修复 |
|---------|------|------|
| `'锘緻echo' 不是内部...` | BOM 字节被当成字符 | BOM + CRLF 同存，或检查是否重复写了 BOM |
| `'e' 不是内部...` / `'ho.' 不是...` | `echo.` 触发了文件查找 | 改用 `echo/` |
| `'t commit' 不是内部...` | LF 换行导致命令截断 | 确保 CRLF |
| `'/dev/null' 找不到` | Unix 路径泄露到 .bat | 改用 `>nul` |
| 中文乱码 | 无 BOM 或未 `chcp 65001` | 加 BOM + 加 `chcp 65001` |

## 如果 .bat 实在搞不定

改用 PowerShell 脚本（`.ps1`）。PowerShell 原生支持 UTF-8，没有 BOM/CRLF 的坑：

```powershell
Set-Location $PSScriptRoot
Write-Host '[1/3] 正在执行...'
npx hexo deploy
pause
```

运行时让用户右键 → "使用 PowerShell 运行"，或写一个存根 `.bat`：

```batch
@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
```
