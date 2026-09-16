/**
 * 命令风险评估。两组判定入口：
 * - isReadOnly*Command：严格只读白名单，plan 模式（只读调研）使用，语义不随 Act 放宽变化；
 * - isSafe*Command：Act（智能批准）使用，在只读基础上放宽「工作区内写入」
 *   （mkdir/touch/cp/mv/tee/相对路径重定向/git add·commit/包安装，条件：无绝对路径、
 *   无命令替换、无全局安装、不命中硬黑名单），与 write 工具的免审批特权对齐。
 *
 * 判定原则：白名单 + 黑名单双向判定，未知一律视为不安全（宁可多问一次）。
 * 复合命令按 `&&` `||` `;` `|` 与换行拆段，要求每一段都安全；引号内的分隔符不拆。
 * 白名单命令还须通过 SEGMENT_VETOES 的额外约束（如 find -delete、curl 写文件、
 * sort -o、sed w 等“看似只读实则可写”的参数组合）。
 *
 * 注意：这是启发式判定，不是安全沙箱——shell 仍可通过脚本、别名、编码混淆、
 * 子命令包装等方式绕过；仅用于减少低风险操作的审批打扰，不能替代人工判断。
 */

/** POSIX 破坏性命令（含重定向、写入类命令） */
const BASH_DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|branch\s+-[dD]|stash\s+(push|pop|drop|clear)|cherry-pick|revert|tag\s+-[aAdD]|init|clone|remote\s+(add|remove|set-url|rename)|config\s+(?!.*(--get|--list|-l))|worktree\s+(add|remove|move|prune)|clean)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

/** POSIX 只读命令白名单 */
const BASH_SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*where\b/i,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*free\b/,
  // 文本检视（不含写文件参数，由 SEGMENT_VETOES 兜底）
  /^\s*(nl|cut|tr|column|od|xxd|strings|cmp|comm|paste|fold|rev|tac|expand|unexpand|numfmt|base64|basenc)\b/,
  // 摘要与路径
  /^\s*(md5sum|sha1sum|sha256sum|sha512sum|cksum|sum)\b/,
  /^\s*(realpath|readlink|basename|dirname|pathchk|nproc|arch|hostname|locale|tty)\b/,
  // Windows 常见只读命令（Git Bash 下可用）
  /^\s*(tasklist|ipconfig|netstat|systeminfo)\b/i,
  // git 只读子命令（创建/删除分支、改配置、remote 写入等一律不在列）
  /^\s*git\s+(status|log|diff|show|blame|shortlog|describe|rev-parse|rev-list|cat-file|show-ref|for-each-ref|ls-files|ls-tree|ls-remote|whatchanged|grep)\b/i,
  /^\s*git\s+branch\s*$/i,
  /^\s*git\s+branch\s+(-l\b|--list\b|-a\b|-r\b|-v\b|-vv\b|--contains\b|--merged\b|--no-merged\b|--show-current\b)/i,
  /^\s*git\s+tag\s*$/i,
  /^\s*git\s+tag\s+(-l\b|--list\b|-n\b|-n\d+\b)/i,
  /^\s*git\s+remote\s*$/i,
  /^\s*git\s+remote\s+(-v\b|show\b|get-url\b)/i,
  /^\s*git\s+config\s+(--get\b|--get-all\b|--get-regexp\b|--list\b|-l\b)/i,
  /^\s*git\s+stash\s+list\b/i,
  /^\s*git\s+worktree\s+list\b/i,
  /^\s*git\s+--version\b/i,
  // 包管理器只读查询
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit|why|explain|ping)\b/i,
  /^\s*yarn\s+(list|info|why|audit)\b/i,
  /^\s*pnpm\s+(list|ls|why|outdated)\b/i,
  /^\s*pip3?\s+(list|show|freeze|index)\b/i,
  // 运行时版本（只打印版本号）
  /^\s*(node|python3?|npm|pip3?|java|go|cargo|rustc|dotnet)\s+--version\b/i,
  /^\s*curl\s/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
];

/**
 * 白名单命令的额外安全约束：命令段匹配 command 且命中 deny 时视为不安全。
 * 这些组合“形似只读”，实际会写文件或执行外部程序，必须回到人工确认。
 */
const SEGMENT_VETOES: { command: RegExp; deny: RegExp }[] = [
  // curl 写文件 / 上传 / 变更请求
  {
    command: /\bcurl\b/i,
    deny: /\s(-o|-O|--output|--output-dir|--remote-name|-d|--data\S*|-F|--form\S*|-T|--upload-file|-c|--cookie-jar|--request\s+(POST|PUT|PATCH|DELETE)|-X\s*(POST|PUT|PATCH|DELETE))/i,
  },
  // find 的删除 / 执行 / 写文件动作
  { command: /\bfind\b/i, deny: /\s-(delete|exec|execdir|ok|okdir|fprint0?|fls)\b/i },
  // sort -o / tree -o 写文件
  { command: /\bsort\b/i, deny: /\s(-o\b|--output)/i },
  { command: /\btree\b/i, deny: /\s-o\s/i },
  // sed 的 w 命令（把替换结果写入文件）
  { command: /\bsed\b/i, deny: /(\bs\/[^/]*\/[^/]*\/w\b|\bw\s+\S)/i },
  // awk 的 system()/print 管道
  { command: /\bawk\b/i, deny: /\bsystem\s*\(/i },
  // git diff --output=<file> 等写出参数
  { command: /\bgit\b/i, deny: /\s--output\b/i },
];

/** PowerShell 破坏性/写入/执行类命令（大小写不敏感） */
const POWERSHELL_DESTRUCTIVE_PATTERNS = [
  /\bRemove-/i,
  /\bSet-/i,
  /\bNew-/i,
  /\bMove-/i,
  /\bCopy-/i,
  /\bRename-/i,
  /\bClear-/i,
  /\bAdd-Content\b/i,
  /\bSet-Content\b/i,
  /\bOut-File\b/i,
  /\bExport-/i,
  /\bImport-/i,
  /\bStart-Process\b/i,
  /\bStop-Process\b/i,
  /\bStart-Job\b/i,
  /\bStop-Job\b/i,
  /\bStart-Service\b/i,
  /\bStop-Service\b/i,
  /\bRestart-/i,
  /\bSuspend-/i,
  /\bResume-/i,
  /\bEnable-/i,
  /\bDisable-/i,
  /\bRegister-/i,
  /\bUnregister-/i,
  /\bInstall-/i,
  /\bUninstall-/i,
  /\bUpdate-/i,
  /\bInvoke-Expression\b/i,
  /\biex\b/i,
  /\bInvoke-Command\b/i,
  /\bInvoke-WebRequest\b/i,
  /\bInvoke-RestMethod\b/i,
  /\bAdd-Type\b/i,
  /\bNew-Object\b/i,
  /\bSet-ExecutionPolicy\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bcmd(\.exe)?\s/i,
  /\bwsl\b/i,
  /\bpowershell(\.exe)?\s/i,
  // 常见别名：白名单按 cmdlet 名匹配，脚本块内用别名写操作时靠这里兜住
  /\b(del|erase|rd|ri|rmdir|rm)\b/i,
  /\b(ni|tee|kill|spps|saps)\b/i,
];

/** PowerShell 只读 cmdlet 白名单（参数中出现破坏性 token 由上面的黑名单兜住） */
const POWERSHELL_SAFE_PATTERNS = [
  /^\s*Get-ChildItem\b/i,
  /^\s*Get-Content\b/i,
  /^\s*Get-Item\b/i,
  /^\s*Get-ItemProperty\b/i,
  /^\s*Get-Location\b/i,
  /^\s*Get-Process\b/i,
  /^\s*Get-Date\b/i,
  /^\s*Get-Help\b/i,
  /^\s*Get-Command\b/i,
  /^\s*Get-Member\b/i,
  /^\s*Get-Module\b/i,
  /^\s*Get-Service\b/i,
  /^\s*Get-FileHash\b/i,
  /^\s*Get-Acl\b/i,
  /^\s*Get-PSDrive\b/i,
  /^\s*Get-Volume\b/i,
  /^\s*Get-WinEvent\b/i,
  /^\s*Get-EventLog\b/i,
  /^\s*Get-Host\b/i,
  /^\s*Get-Culture\b/i,
  /^\s*Get-TimeZone\b/i,
  /^\s*Get-Variable\b/i,
  /^\s*Get-Alias\b/i,
  /^\s*Get-Random\b/i,
  /^\s*Get-History\b/i,
  /^\s*Get-Error\b/i,
  /^\s*Get-ComputerInfo\b/i,
  /^\s*Get-CimInstance\b/i,
  /^\s*Get-PSCallStack\b/i,
  /^\s*Test-Path\b/i,
  /^\s*Test-Connection\b/i,
  /^\s*Test-NetConnection\b/i,
  /^\s*Resolve-Path\b/i,
  /^\s*Resolve-DnsName\b/i,
  /^\s*Split-Path\b/i,
  /^\s*Join-Path\b/i,
  /^\s*ConvertFrom-Json\b/i,
  /^\s*ConvertTo-Json\b/i,
  /^\s*ConvertFrom-Csv\b/i,
  /^\s*ConvertTo-Csv\b/i,
  /^\s*ConvertFrom-StringData\b/i,
  /^\s*Measure-Object\b/i,
  /^\s*Measure-Command\b/i,
  /^\s*Select-Object\b/i,
  /^\s*Select-String\b/i,
  /^\s*Where-Object\b/i,
  /^\s*Sort-Object\b/i,
  /^\s*Group-Object\b/i,
  /^\s*Compare-Object\b/i,
  /^\s*ForEach-Object\b/i,
  /^\s*Format-Table\b/i,
  /^\s*Format-List\b/i,
  /^\s*Format-Wide\b/i,
  /^\s*Format-Custom\b/i,
  /^\s*Out-String\b/i,
  /^\s*Out-Host\b/i,
  /^\s*Out-Null\b/i,
  /^\s*Out-Default\b/i,
  /^\s*Write-Output\b/i,
  /^\s*Write-Host\b/i,
];

/** 按 `&&` `||` `;` `|` 与换行拆段（引号内不拆），供复合命令逐段判定 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/**
 * Act（智能批准）下的硬黑名单：BASH_DESTRUCTIVE_PATTERNS 去掉可放宽条目
 * （mkdir/touch/cp/mv/tee、重定向、包安装、git add/commit）——这些改由下方
 * 「工作区写」通道按条件放行（无绝对路径/无命令替换/无全局安装），条件不满足仍人工确认。
 */
const BASH_HARD_DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /\bnpm\s+(uninstall|update|link|publish)\b/i,
  /\byarn\s+(remove|publish)\b/i,
  /\bpnpm\s+(remove|publish)\b/i,
  /\bpip\s+uninstall\b/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(push|pull|merge|rebase|reset|checkout|switch|branch\s+-[dD]|stash\s+(push|pop|drop|clear)|cherry-pick|revert|tag\s+-[aAdD]|init|clone|remote\s+(add|remove|set-url|rename)|config\s+(?!.*(--get|--list|-l))|worktree\s+(add|remove|move|prune)|clean)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

/** Act（智能批准）的「工作区写」形态：命中且整段满足安全条件时放行（与 write 工具特权对齐） */
const BASH_WORKSPACE_WRITE_PATTERNS = [
  /^\s*mkdir\b/,
  /^\s*touch\b/,
  /^\s*cp\b/,
  /^\s*mv\b/,
  /^\s*tee\b/,
  /^\s*git\s+(add|commit)\b/i,
  /^\s*npm\s+(install|i|ci|add)\b/i,
  /^\s*yarn\s+(add|install)\b/i,
  /^\s*pnpm\s+(add|install)\b/i,
  /^\s*pip3?\s+install\b/i,
  /^\s*python3?\s+-m\s+pip\s+install\b/i,
];

/** token 是否为绝对路径（POSIX /x、Windows 盘符、UNC \\\\server） */
function isAbsolutePathToken(token: string): boolean {
  return token.startsWith("/") || token.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(token);
}

/** 段内是否出现绝对路径、`$(...)`/反引号命令替换（写入范围必须留在工作区内） */
function hasAbsolutePathOrSubstitution(segment: string): boolean {
  if (/\$\(|`/.test(segment)) return true;
  return /(^|[\s="'(\[{])(\/[^\s]*|\\\\[^\s]*|[A-Za-z]:[\\/][^\s]*)/.test(segment);
}

/** 段内是否有全局安装标志（npm -g / --global 会写到系统目录，保留人工确认） */
function hasGlobalInstallFlag(segment: string): boolean {
  return /(^|\s)(-g|--global)\b/.test(segment);
}

/** 段内是否为「重定向到相对路径」的写文件形态（> 或 >>，排除 2>&1 合并型） */
function hasRelativeRedirect(segment: string): boolean {
  const match = segment.match(/(^|[^<>])>{1,2}\s*([^\s|;&"']+)/);
  return !!match && !isAbsolutePathToken(match[2]);
}

/**
 * 剥掉丢弃型重定向 token（>/dev/null、2>&1、>$null）：对审批语义无影响，
 * 避免 shell-guard 改写出的 /dev/null 触发绝对路径否决（改写前 `2>nul` 按相对
 * 重定向放行，改写后若被判绝对路径反而弹审批卡，行为倒退）。
 */
function stripDiscardRedirects(segment: string): string {
  return segment
    .replace(/\d?>{1,2}\s*(\/dev\/null|\$null)\b/g, " ")
    .replace(/\d?>&\s*\d\b/g, " ");
}

/** POSIX 命令是否只读安全（plan 模式判定）：每一段都必须在只读白名单内，且不含破坏性模式与写文件参数 */
export function isReadOnlyBashCommand(command: string): boolean {
  const segments = splitSegments(command).map(stripDiscardRedirects);
  if (!segments.length) return false;
  return segments.every(isReadOnlyBashSegment);
}

function isReadOnlyBashSegment(segment: string): boolean {
  return (
    !BASH_DESTRUCTIVE_PATTERNS.some((p) => p.test(segment)) &&
    !SEGMENT_VETOES.some((v) => v.command.test(segment) && v.deny.test(segment)) &&
    BASH_SAFE_PATTERNS.some((p) => p.test(segment))
  );
}

/**
 * Act（智能批准）下的放行判定：只读命令，或「工作区内写入」——
 * mkdir/touch/cp/mv/tee/相对路径重定向/git add·commit/包安装，且整段无绝对路径、
 * 无命令替换、无全局安装、不命中硬黑名单（与 write 工具免审批特权对齐）。
 */
export function isSafeBashCommand(command: string): boolean {
  const segments = splitSegments(command).map(stripDiscardRedirects);
  if (!segments.length) return false;
  return segments.every(
    (segment) =>
      isReadOnlyBashSegment(segment) ||
      ((BASH_WORKSPACE_WRITE_PATTERNS.some((p) => p.test(segment)) || hasRelativeRedirect(segment)) &&
        !BASH_HARD_DESTRUCTIVE_PATTERNS.some((p) => p.test(segment)) &&
        !SEGMENT_VETOES.some((v) => v.command.test(segment) && v.deny.test(segment)) &&
        !hasAbsolutePathOrSubstitution(segment) &&
        !hasGlobalInstallFlag(segment))
  );
}

/** PowerShell 命令是否只读安全（plan 模式判定）：整串不含破坏性模式，且每一段为只读 cmdlet 或安全的外部命令 */
export function isReadOnlyPowerShellCommand(command: string): boolean {
  if (POWERSHELL_DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return false;
  const segments = splitSegments(command).map(stripDiscardRedirects);
  if (!segments.length) return false;
  return segments.every(
    (segment) =>
      POWERSHELL_SAFE_PATTERNS.some((p) => p.test(segment)) || isReadOnlyBashCommand(segment)
  );
}

/** PowerShell 的 Act（智能批准）判定：只读，或经 bash 回退通道获得工作区写放宽（PS 原生写 cmdlet 不放宽） */
export function isSafePowerShellCommand(command: string): boolean {
  if (POWERSHELL_DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return false;
  const segments = splitSegments(command).map(stripDiscardRedirects);
  if (!segments.length) return false;
  return segments.every(
    (segment) =>
      POWERSHELL_SAFE_PATTERNS.some((p) => p.test(segment)) || isSafeBashCommand(segment)
  );
}
