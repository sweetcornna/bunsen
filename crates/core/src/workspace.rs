//! 工作区：文件浏览、读文件、git 状态与差异、科研面板。路径相对会话的 workdir，也接受绝对路径和 `~`。

use crate::core::{Core, OP_TIMEOUT};
use crate::error::{git_error_summary, Code, Error, Result};
use crate::model::*;
use crate::shell::{quote, quote_path};
use crate::util::{rfc3339_from_unix, short_id};

pub const MAX_ENTRIES: usize = 2000;
pub const MAX_TEXT: usize = 512 * 1024;
pub const MAX_RAW: u64 = 32 * 1024 * 1024;

const LIST_PY: &str = r#"import os, json
out = []
with os.scandir('.') as it:
    for e in it:
        try:
            if e.is_symlink():
                k = 'link'
            elif e.is_dir():
                k = 'dir'
            else:
                k = 'file'
            st = e.stat(follow_symlinks=False)
            n = e.name.encode('utf-8', 'surrogateescape').decode('utf-8', 'replace')
            out.append([n, k, st.st_size, int(st.st_mtime)])
        except OSError:
            pass
print(json.dumps(out))
"#;

fn cd_workdir(workdir: &str) -> String {
    format!("cd {} 2>/dev/null || {{ echo __OP_NOWD__; exit 0; }}\n", quote_path(workdir))
}

fn nowd(workdir: &str) -> Error {
    Error::not_found(format!("工作目录 {workdir} 在服务器上不存在"))
}

/// 目录在前、按名排序，最多 2000 项。
pub fn sort_entries(mut v: Vec<FileEntry>) -> Vec<FileEntry> {
    v.sort_by(|a, b| (a.kind != "dir", &a.name).cmp(&(b.kind != "dir", &b.name)));
    v.truncate(MAX_ENTRIES);
    v
}

/// `stat -c '%F|%s|%Y|%n'` 的输出（没有 python3 时的退路）。
pub fn parse_stat_lines(out: &str) -> Vec<FileEntry> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(4, '|').collect();
            if f.len() < 4 {
                return None;
            }
            let kind = match f[0] {
                "directory" => "dir",
                "symbolic link" => "link",
                _ => "file",
            };
            Some(FileEntry {
                name: f[3].to_string(),
                kind: kind.into(),
                size: f[1].parse().unwrap_or(0),
                mtime: rfc3339_from_unix(f[2].parse().unwrap_or(0)),
            })
        })
        .filter(|e| e.name != "." && e.name != "..")
        .collect()
}

fn parent_of(path: &str) -> Option<String> {
    if path == "/" || path.is_empty() {
        return None;
    }
    let p = path.trim_end_matches('/');
    match p.rfind('/') {
        Some(0) => Some("/".into()),
        Some(i) => Some(p[..i].to_string()),
        None => None,
    }
}

/// 解析 `git status --porcelain=v1 -z` 输出；去掉 `prefix`（工作目录相对仓库根的前缀）。
pub fn parse_porcelain_z(data: &[u8], prefix: &str) -> Vec<GitChange> {
    let mut out = Vec::new();
    let mut fields = data.split(|&b| b == 0).filter(|f| !f.is_empty());
    while let Some(f) = fields.next() {
        if f.len() < 4 {
            continue;
        }
        let status = String::from_utf8_lossy(&f[..2]).into_owned();
        let path = String::from_utf8_lossy(&f[3..]).into_owned();
        if status.starts_with('R') || status.starts_with('C') || status.ends_with('R') || status.ends_with('C') {
            fields.next(); // 原路径
        }
        let path = path.strip_prefix(prefix).map(str::to_string).unwrap_or(path);
        out.push(GitChange { path, status });
    }
    out
}

/// 字节 → 文本；含 NUL 或不是 UTF-8 视为二进制。被截断时允许结尾半个字符。
pub fn decode_text(bytes: &[u8], truncated: bool) -> Option<String> {
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return None;
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => Some(s.to_string()),
        Err(e) if truncated && e.error_len().is_none() => Some(String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned()),
        Err(_) => None,
    }
}

fn cut_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut i = max;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    &s[..i]
}

impl Core {
    async fn ws_ctx(&self, id: &str) -> Result<(Session, Server)> {
        let rec = self
            .store
            .sessions()?
            .into_iter()
            .find(|r| r.session.id == id)
            .ok_or_else(|| Error::not_found(format!("没有 id 为 {id} 的会话")))?;
        let sv = self.server_by_id(&rec.session.server_id)?;
        Ok((rec.session, sv))
    }

    pub async fn files(&self, id: &str, path: Option<&str>) -> Result<DirListing> {
        let (s, sv) = self.ws_ctx(id).await?;
        let p = path.map(str::trim).filter(|p| !p.is_empty()).unwrap_or(".");
        let script = format!(
            "{cd}cd {p} 2>/dev/null || {{ echo __OP_NODIR__; exit 0; }}\n\
             printf '__OP_PWD__\\t%s\\n' \"$(pwd)\"\n\
             if command -v python3 >/dev/null 2>&1; then echo __OP_PY__; python3 -c {py}; else echo __OP_STAT__; stat -c '%F|%s|%Y|%n' -- * .[!.]* ..?* 2>/dev/null; fi\n",
            cd = cd_workdir(&s.workdir),
            p = quote_path(p),
            py = quote(LIST_PY),
        );
        let out = self.exec(&sv, &script, OP_TIMEOUT).await?;
        let text = out.text();
        if text.contains("__OP_NOWD__") {
            return Err(nowd(&s.workdir));
        }
        if text.starts_with("__OP_NODIR__") || text.contains("\n__OP_NODIR__") {
            return Err(Error::not_found(format!("目录 {p} 不存在或无法进入")));
        }
        let pwd = text
            .lines()
            .find_map(|l| l.strip_prefix("__OP_PWD__\t"))
            .ok_or_else(|| Error::new(Code::SshFailed, format!("列目录失败：{}", out.err_line())))?
            .to_string();
        let entries = if let Some((_, body)) = text.split_once("__OP_PY__\n") {
            let rows: Vec<(String, String, u64, i64)> = serde_json::from_str(body.trim())
                .map_err(|e| Error::new(Code::SshFailed, format!("列目录输出无法解析：{e}；{}", out.err_line())))?;
            rows.into_iter().map(|(name, kind, size, mtime)| FileEntry { name, kind, size, mtime: rfc3339_from_unix(mtime) }).collect()
        } else if let Some((_, body)) = text.split_once("__OP_STAT__\n") {
            parse_stat_lines(body)
        } else {
            vec![]
        };
        Ok(DirListing { parent: parent_of(&pwd), path: pwd, entries: sort_entries(entries) })
    }

    /// 读服务器上的文件：返回 (绝对路径, 大小, 最多 `limit` 字节)。`max_size` 有值时超过就报 bad_request。
    async fn read_remote(&self, id: &str, path: &str, limit: usize, max_size: Option<u64>) -> Result<(String, u64, Vec<u8>)> {
        let path = path.trim();
        if path.is_empty() {
            return Err(Error::bad_request("缺少 path"));
        }
        let (s, sv) = self.ws_ctx(id).await?;
        let too_big = match max_size {
            Some(m) => format!("if [ \"${{sz:-0}}\" -gt {m} ] 2>/dev/null; then printf '__OP_TOOBIG__\\t%s\\n' \"$sz\"; exit 0; fi\n"),
            None => String::new(),
        };
        let script = format!(
            "{cd}f={p}\n\
             [ -e \"$f\" ] || {{ echo __OP_NOFILE__; exit 0; }}\n\
             [ -d \"$f\" ] && {{ echo __OP_ISDIR__; exit 0; }}\n\
             [ -r \"$f\" ] || {{ echo __OP_NOREAD__; exit 0; }}\n\
             abs=\"$(cd \"$(dirname -- \"$f\")\" && pwd)/$(basename -- \"$f\")\"\n\
             sz=$(stat -c %s -- \"$f\" 2>/dev/null || stat -f %z -- \"$f\" 2>/dev/null || wc -c < \"$f\" | tr -d ' ')\n\
             {too_big}\
             printf '__OP_FILE__\\t%s\\t%s\\n' \"$sz\" \"$abs\"\n\
             head -c {limit} < \"$f\"\n",
            cd = cd_workdir(&s.workdir),
            p = quote_path(path),
        );
        let timeout = if limit > MAX_TEXT * 2 { std::time::Duration::from_secs(300) } else { OP_TIMEOUT };
        let out = self.exec(&sv, &script, timeout).await?;
        let raw = &out.stdout;
        let marker = b"__OP_FILE__\t";
        let Some(pos) = raw.windows(marker.len()).position(|w| w == marker) else {
            let t = out.text();
            return Err(if t.contains("__OP_NOWD__") {
                nowd(&s.workdir)
            } else if t.contains("__OP_NOFILE__") {
                Error::not_found(format!("文件 {path} 不存在"))
            } else if t.contains("__OP_ISDIR__") {
                Error::bad_request(format!("{path} 是目录")).with_hint("用 files 接口浏览目录")
            } else if t.contains("__OP_NOREAD__") {
                Error::bad_request(format!("没有权限读取 {path}"))
            } else if let Some(sz) = t.lines().find_map(|l| l.strip_prefix("__OP_TOOBIG__\t")) {
                Error::bad_request(format!("文件 {path} 有 {} 字节，超过上限 {} MB", sz.trim(), max_size.unwrap_or(0) / 1024 / 1024))
            } else {
                Error::new(Code::SshFailed, format!("读取文件失败：{}", out.err_line()))
            });
        };
        let rest = &raw[pos + marker.len()..];
        let nl = rest.iter().position(|&b| b == b'\n').unwrap_or(rest.len());
        let header = String::from_utf8_lossy(&rest[..nl]).into_owned();
        let (size, abs) = header.split_once('\t').unwrap_or((header.as_str(), path));
        let size: u64 = size.trim().parse().unwrap_or(0);
        let content = rest.get(nl + 1..).unwrap_or(&[]).to_vec();
        Ok((abs.to_string(), size, content))
    }

    pub async fn file(&self, id: &str, path: &str) -> Result<FileContent> {
        let (abs, size, mut content) = self.read_remote(id, path, MAX_TEXT + 1, None).await?;
        let truncated = content.len() > MAX_TEXT || (size as usize) > MAX_TEXT;
        content.truncate(MAX_TEXT);
        let text = decode_text(&content, truncated);
        Ok(FileContent { path: abs, size, binary: text.is_none(), truncated, text })
    }

    /// 原始字节（v1.1），上限 32 MB。
    pub async fn raw(&self, id: &str, path: &str) -> Result<Vec<u8>> {
        let (_, size, content) = self.read_remote(id, path, MAX_RAW as usize + 1, Some(MAX_RAW)).await?;
        if content.len() as u64 > MAX_RAW || size > MAX_RAW {
            return Err(Error::bad_request(format!("文件 {} 超过上限 32 MB", path.trim())));
        }
        Ok(content)
    }

    pub async fn git(&self, id: &str) -> Result<GitStatus> {
        let (s, sv) = self.ws_ctx(id).await?;
        let script = format!(
            "{cd}command -v git >/dev/null 2>&1 || {{ echo __OP_NOREPO__; exit 0; }}\n\
             [ \"$(git rev-parse --is-inside-work-tree 2>/dev/null)\" = true ] || {{ echo __OP_NOREPO__; exit 0; }}\n\
             b=$(git symbolic-ref --short -q HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)\n\
             printf '__OP_BRANCH__\\t%s\\t%s\\n' \"$b\" \"$(git rev-parse --show-prefix 2>/dev/null)\"\n\
             git status --porcelain=v1 -z --untracked-files=normal -- . 2>/dev/null | head -c 2000000\n",
            cd = cd_workdir(&s.workdir),
        );
        let out = self.exec(&sv, &script, OP_TIMEOUT).await?;
        let raw = &out.stdout;
        let marker = b"__OP_BRANCH__\t";
        let Some(pos) = raw.windows(marker.len()).position(|w| w == marker) else {
            let t = out.text();
            if t.contains("__OP_NOREPO__") || t.contains("__OP_NOWD__") {
                return Ok(GitStatus { is_repo: false, branch: None, changes: vec![] });
            }
            return Err(Error::new(Code::SshFailed, format!("读取 git 状态失败：{}", git_error_summary(&out.stderr))));
        };
        let rest = &raw[pos + marker.len()..];
        let nl = rest.iter().position(|&b| b == b'\n').unwrap_or(rest.len());
        let header = String::from_utf8_lossy(&rest[..nl]).into_owned();
        let (branch, prefix) = header.split_once('\t').unwrap_or((header.as_str(), ""));
        let changes = parse_porcelain_z(rest.get(nl + 1..).unwrap_or(&[]), prefix);
        let branch = Some(branch.trim().to_string()).filter(|b| !b.is_empty());
        Ok(GitStatus { is_repo: true, branch, changes })
    }

    pub async fn git_diff(&self, id: &str, path: Option<&str>) -> Result<GitDiff> {
        let (s, sv) = self.ws_ctx(id).await?;
        let path = path.map(str::trim).filter(|p| !p.is_empty());
        let diff_cmd = match path {
            Some(p) => format!(
                "p={p}\nif git ls-files --error-unmatch -- \"$p\" >/dev/null 2>&1; then git diff --no-color --no-ext-diff \"$base\" -- \"$p\"; \
                 elif [ -f \"$p\" ]; then git diff --no-color --no-ext-diff --no-index -- /dev/null \"$p\"; fi\n",
                p = quote_path(p)
            ),
            None => "git diff --no-color --no-ext-diff \"$base\"\n".to_string(),
        };
        let script = format!(
            "{cd}command -v git >/dev/null 2>&1 || {{ echo __OP_NOREPO__; exit 0; }}\n\
             [ \"$(git rev-parse --is-inside-work-tree 2>/dev/null)\" = true ] || {{ echo __OP_NOREPO__; exit 0; }}\n\
             if git rev-parse --verify -q HEAD >/dev/null 2>&1; then base=HEAD; else base=$(git hash-object -t tree /dev/null); fi\n\
             echo __OP_DIFF__\n\
             {{ {diff_cmd} }} 2>/dev/null | head -c {lim}\n",
            cd = cd_workdir(&s.workdir),
            lim = MAX_TEXT + 4,
        );
        let out = self.exec(&sv, &script, OP_TIMEOUT).await?;
        let text = out.text();
        if text.contains("__OP_NOWD__") {
            return Err(nowd(&s.workdir));
        }
        if text.contains("__OP_NOREPO__") {
            return Err(Error::bad_request("工作目录不是 git 仓库"));
        }
        let Some((_, body)) = text.split_once("__OP_DIFF__\n") else {
            return Err(Error::new(Code::SshFailed, format!("读取差异失败：{}", git_error_summary(&out.stderr))));
        };
        Ok(GitDiff { diff: cut_utf8(body, MAX_TEXT).to_string() })
    }

    pub async fn research(&self, id: &str) -> Result<ResearchPanel> {
        let (s, sv) = self.ws_ctx(id).await?;
        let m = format!("__OPR_{}__", short_id());
        let script = format!(
            "M={m}\n{cd}{home}\
             printf '%s home\\t%s\\n' \"$M\" \"$rel\"\n\
             [ -f \"$h/PROJECT.md\" ] || {{ echo \"$M absent\"; exit 0; }}\n\
             echo \"$M present\"\n\
             if [ -f \"$h/.loop/active\" ]; then printf '%s loop\\t%s\\n' \"$M\" \"$(sed -n 's/^started: *//p' \"$h/.loop/active\" | head -n 1)\"; fi\n\
             if [ -s \"$h/.loop/blocked\" ]; then printf '%s blocked\\t%s\\n' \"$M\" \"$(head -c 2000 \"$h/.loop/blocked\" | tr '\\n\\t' '  ')\"; fi\n\
             for f in STATE SUMMARY IDEAS LEDGER OVERVIEW LESSONS; do if [ -f \"$h/$f.md\" ]; then echo \"$M file $f\"; head -c 262144 \"$h/$f.md\"; echo; fi; done\n\
             if [ -f \"$h/LOG.md\" ]; then echo \"$M logtail\"; tail -n 120 \"$h/LOG.md\"; echo; fi\n\
             for k in prereg results; do for f in \"$h/$k\"/*.md; do\n\
               [ -f \"$f\" ] || continue; n=$(basename \"$f\"); [ \"$n\" = TEMPLATE.md ] && continue\n\
               t=$(grep -m 1 '^#' \"$f\" 2>/dev/null | sed 's/^#*[[:space:]]*//' | tr '\\t\\r' '  ')\n\
               printf '%s doc %s\\t%s\\t%s\\n' \"$M\" \"$k\" \"$n\" \"$t\"\n\
             done; done\n\
             __op_n=0\n\
             for d in \"$h\"/runs/*/; do\n\
               [ -f \"$d/meta.json\" ] || continue\n\
               __op_n=$((__op_n + 1)); [ $__op_n -gt 2000 ] && break\n\
               i=$(basename \"$d\")\n\
               echo \"$M runmeta $i\"; head -c 65536 \"$d/meta.json\"; echo\n\
               if [ -f \"$d/metrics.json\" ]; then echo \"$M flag metrics $i\"; fi\n\
               if [ -f \"$h/results/$i.md\" ]; then echo \"$M flag result $i\"; fi\n\
             done\n\
             if [ -f \"$h/tools/rk.py\" ] && command -v python3 >/dev/null 2>&1; then\n\
               echo \"$M runs\"\n\
               if command -v timeout >/dev/null 2>&1; then T='timeout 20'; else T=''; fi\n\
               RESEARCH_HOME=\"$h\" $T python3 \"$h/tools/rk.py\" status --json 2>/dev/null | head -c 2000000; echo\n\
             fi\n\
             echo \"$M end\"\n",
            m = quote(&m),
            cd = cd_workdir(&s.workdir),
            home = RESOLVE_HOME,
        );
        let out = self.exec(&sv, &script, OP_TIMEOUT).await?;
        Ok(parse_research(&out.text(), &m))
    }

    /// 一次运行的详情（v1.1）。`run_id` 只接受 `[A-Za-z0-9._-]{1,64}`（且不能全是点）。
    pub async fn research_run(&self, id: &str, run_id: &str, lines: Option<u32>) -> Result<RunDetail> {
        if !valid_run_id(run_id) {
            return Err(
                Error::bad_request(format!("run_id“{run_id}”不合法")).with_hint("只能包含字母、数字、点、下划线和连字符，最长 64 个字符")
            );
        }
        let n = lines.unwrap_or(200).clamp(1, 2000);
        let (s, sv) = self.ws_ctx(id).await?;
        let m = format!("__OPR_{}__", short_id());
        let script = format!(
            "M={m}\n{cd}{home}\
             d=\"$h/runs/\"{rid}\n\
             [ -f \"$d/meta.json\" ] || {{ echo \"$M nometa\"; exit 0; }}\n\
             echo \"$M meta\"; head -c 1048576 \"$d/meta.json\"; echo\n\
             echo \"$M log\"; if [ -f \"$d/log.txt\" ]; then tail -n {n} \"$d/log.txt\"; fi; echo\n\
             if [ -f \"$d/metrics.json\" ]; then echo \"$M metrics\"; head -c 65537 \"$d/metrics.json\"; echo; fi\n\
             if [ -f \"$h/results/\"{rid}.md ]; then echo \"$M result\"; head -c 524288 \"$h/results/\"{rid}.md; echo; fi\n\
             echo \"$M end\"\n",
            m = quote(&m),
            cd = cd_workdir(&s.workdir),
            home = RESOLVE_HOME,
            rid = quote(run_id),
        );
        let out = self.exec(&sv, &script, OP_TIMEOUT).await?;
        let text = out.text();
        if text.contains("__OP_NOWD__") {
            return Err(nowd(&s.workdir));
        }
        if text.lines().any(|l| l == format!("{m} nometa")) {
            return Err(Error::not_found(format!("没有运行 {run_id}（找不到 runs/{run_id}/meta.json）")));
        }
        let secs = parse_sections(&text, &m);
        let get = |k: &str| secs.iter().find(|(h, _)| h == k).map(|(_, b)| b.clone());
        let meta_text = get("meta").ok_or_else(|| Error::new(Code::SshFailed, format!("读取运行记录失败：{}", out.err_line())))?;
        let meta: serde_json::Value = serde_json::from_str(meta_text.trim())
            .map_err(|e| Error::bad_request(format!("runs/{run_id}/meta.json 不是合法 JSON：{e}")))?;
        let metrics =
            get("metrics").filter(|t| t.len() <= 64 * 1024).and_then(|t| serde_json::from_str::<serde_json::Value>(t.trim()).ok());
        Ok(RunDetail { run_id: run_id.to_string(), meta, log_tail: get("log").unwrap_or_default(), metrics, result_md: get("result") })
    }

    /// 产物（v1.1）：workdir 下递归（深度 ≤ 8）找图、PDF、表格、notebook、html、报告，按修改时间倒序。
    pub async fn artifacts(&self, id: &str, limit: Option<u32>) -> Result<ArtifactList> {
        let limit = limit.unwrap_or(300).clamp(1, 1000) as usize;
        let (s, sv) = self.ws_ctx(id).await?;
        let script = format!(
            "{cd}echo __OP_ART__\n\
             if {py}; then python3 -c {code}\n\
             elif stat -c %s . >/dev/null 2>&1; then find . -mindepth 1 -maxdepth {d} {expr} -exec stat -c '%s|%Y|%n' {{}} + 2>/dev/null | head -n {cap}\n\
             else find . -mindepth 1 -maxdepth {d} {expr} -exec stat -f '%z|%m|%N' {{}} + 2>/dev/null | head -n {cap}\n\
             fi\n",
            cd = cd_workdir(&s.workdir),
            py = python_test(),
            code = quote(&artifact_py()),
            d = ART_DEPTH,
            expr = find_expr(),
            cap = ART_SCAN_CAP,
        );
        let out = self.exec(&sv, &script, std::time::Duration::from_secs(90)).await?;
        let text = out.text();
        if text.contains("__OP_NOWD__") {
            return Err(nowd(&s.workdir));
        }
        let Some((_, body)) = text.split_once("__OP_ART__\n") else {
            return Err(Error::new(Code::SshFailed, format!("查找产物失败：{}", out.err_line())));
        };
        Ok(collect_artifacts(body, limit))
    }
}

/// 研究目录：默认 `research`；项目里有 `.claude/research-home` 时以它的第一行为准（与 research 插件一致）。
/// 执行前已经 cd 到 workdir；结果在 `$rel`（原样）与 `$h`（绝对路径）。
const RESOLVE_HOME: &str = "rel=research\n\
if [ -f .claude/research-home ]; then r=$(head -n 1 .claude/research-home | tr -d '\\r'); [ -n \"$r\" ] && rel=$r; fi\n\
case \"$rel\" in /*) h=$rel ;; *) h=\"$PWD/$rel\" ;; esac\n";

pub fn valid_run_id(r: &str) -> bool {
    !r.is_empty() && r.len() <= 64 && r.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) && !r.bytes().all(|b| b == b'.')
}

/// 远程脚本里“能不能用 python3”的判断。`BUNSEN_REMOTE_NO_PYTHON=1` 强制走 find/stat 退路（测试与排障用）。
fn python_test() -> &'static str {
    if std::env::var("BUNSEN_REMOTE_NO_PYTHON").ok().as_deref() == Some("1") {
        "false"
    } else {
        "command -v python3 >/dev/null 2>&1"
    }
}

pub const ART_DEPTH: usize = 8;
const ART_SCAN_CAP: usize = 50_000;
const ART_SKIP_DIRS: &[&str] = &["node_modules", "__pycache__", "venv", "env", "site-packages", "wandb", "checkpoints"];
const ART_KINDS: &[(&str, &[&str])] = &[
    ("image", &["png", "jpg", "jpeg", "gif", "webp", "svg"]),
    ("pdf", &["pdf"]),
    ("table", &["csv", "tsv", "xlsx", "parquet"]),
    ("notebook", &["ipynb"]),
    ("html", &["html", "htm"]),
    ("doc", &["md", "tex", "docx"]),
];
const DOC_DIRS: &[&str] = &["results", "reports", "report", "paper", "papers", "figures", "outputs", "output"];

/// `find` 的表达式（BusyBox 也支持的选项）：跳过目录、只要候选扩展名的普通文件。
fn find_expr() -> String {
    let skip: Vec<String> = std::iter::once("-name '.*'".to_string()).chain(ART_SKIP_DIRS.iter().map(|d| format!("-name {d}"))).collect();
    let exts: Vec<String> = ART_KINDS.iter().flat_map(|(_, e)| e.iter()).map(|e| format!("-iname '*.{e}'")).collect();
    format!("\\( -type d \\( {} \\) -prune \\) -o \\( -type f \\( {} \\)", skip.join(" -o "), exts.join(" -o ")) + " \\)"
}

const ARTIFACT_PY: &str = r#"import os
EXTS = {__EXTS__}
SKIP = {__SKIP__}
n = 0
for root, dirs, files in os.walk('.'):
    rel = os.path.relpath(root, '.')
    depth = 0 if rel == '.' else rel.count(os.sep) + 1
    dirs[:] = [] if depth + 1 >= __DEPTH__ else [d for d in dirs if not d.startswith('.') and d not in SKIP]
    for f in files:
        if '.' not in f or '\n' in f:
            continue
        if f.rsplit('.', 1)[1].lower() not in EXTS:
            continue
        p = os.path.join(root, f)
        try:
            st = os.stat(p)
        except OSError:
            continue
        name = p.encode('utf-8', 'surrogateescape').decode('utf-8', 'replace')
        print('%d|%d|%s' % (st.st_size, int(st.st_mtime), name))
        n += 1
        if n >= __CAP__:
            raise SystemExit(0)
"#;

fn artifact_py() -> String {
    let exts: Vec<String> = ART_KINDS.iter().flat_map(|(_, e)| e.iter()).map(|e| format!("'{e}'")).collect();
    let skip: Vec<String> = ART_SKIP_DIRS.iter().map(|d| format!("'{d}'")).collect();
    ARTIFACT_PY
        .replace("__EXTS__", &exts.join(", "))
        .replace("__SKIP__", &skip.join(", "))
        .replace("__DEPTH__", &ART_DEPTH.to_string())
        .replace("__CAP__", &ART_SCAN_CAP.to_string())
}

pub fn artifact_kind(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    let kind = ART_KINDS.iter().find(|(_, es)| es.contains(&ext.as_str()))?.0;
    if kind == "doc" {
        let segs: Vec<&str> = path.split('/').collect();
        let dirs = &segs[..segs.len().saturating_sub(1)];
        if !dirs.iter().any(|d| DOC_DIRS.contains(&d.to_ascii_lowercase().as_str())) {
            return None;
        }
    }
    Some(kind)
}

/// `大小|修改时间|路径` 行 → 归类、排序、截断。
pub fn collect_artifacts(body: &str, limit: usize) -> ArtifactList {
    let mut items: Vec<(i64, Artifact)> = Vec::new();
    let mut lines = 0usize;
    for line in body.lines() {
        lines += 1;
        let f: Vec<&str> = line.splitn(3, '|').collect();
        if f.len() < 3 {
            continue;
        }
        let path = f[2].trim_start_matches("./").to_string();
        let Some(kind) = artifact_kind(&path) else { continue };
        let mtime: i64 = f[1].trim().parse().unwrap_or(0);
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        items.push((
            mtime,
            Artifact { name, kind: kind.into(), size: f[0].trim().parse().unwrap_or(0), mtime: rfc3339_from_unix(mtime), path },
        ));
    }
    items.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.path.cmp(&b.1.path)));
    let truncated = items.len() > limit || lines >= ART_SCAN_CAP;
    items.truncate(limit);
    ArtifactList { items: items.into_iter().map(|(_, a)| a).collect(), truncated }
}

/// 按 `<marker> <标题>` 行切段。段内容是两个标记之间的行（去掉脚本补的最后一个换行）。
pub fn parse_sections(text: &str, m: &str) -> Vec<(String, String)> {
    let prefix = format!("{m} ");
    let mut out: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        if let Some(h) = line.strip_prefix(&prefix) {
            out.push((h.to_string(), String::new()));
        } else if let Some((_, b)) = out.last_mut() {
            b.push_str(line);
            b.push('\n');
        }
    }
    for (_, b) in out.iter_mut() {
        if b.ends_with('\n') {
            b.pop();
        }
    }
    out
}

/// 研究目录不存在时的返回值：`present=false`，其余为 null / 空。
pub fn empty_panel(home: String) -> ResearchPanel {
    ResearchPanel {
        present: false,
        home,
        loop_: LoopInfo { on: false, started: None, blocked: None },
        state_md: None,
        summary_md: None,
        ideas_md: None,
        ledger_md: None,
        runs: vec![],
        overview_md: None,
        lessons_md: None,
        log_tail: None,
        prereg: vec![],
        results: vec![],
    }
}

pub fn parse_research(text: &str, m: &str) -> ResearchPanel {
    let mut p = empty_panel("research".into());
    let mut metas: Vec<(String, serde_json::Value)> = Vec::new();
    let mut flags: Vec<(String, String)> = Vec::new();
    let mut rk_rows: Option<Vec<serde_json::Value>> = None;
    for (h, body) in parse_sections(text, m) {
        let (key, arg) = h.split_once(['\t', ' ']).unwrap_or((h.as_str(), ""));
        match key {
            "home" => p.home = arg.to_string(),
            "present" => p.present = true,
            "loop" => {
                p.loop_.on = true;
                p.loop_.started = Some(arg.trim().to_string()).filter(|v| !v.is_empty());
            }
            "blocked" => p.loop_.blocked = Some(arg.trim().to_string()).filter(|v| !v.is_empty()),
            "file" => match arg {
                "STATE" => p.state_md = Some(body),
                "SUMMARY" => p.summary_md = Some(body),
                "IDEAS" => p.ideas_md = Some(body),
                "LEDGER" => p.ledger_md = Some(body),
                "OVERVIEW" => p.overview_md = Some(body),
                "LESSONS" => p.lessons_md = Some(body),
                _ => {}
            },
            "logtail" => p.log_tail = Some(body),
            "doc" => {
                let f: Vec<&str> = arg.splitn(3, '\t').collect();
                if f.len() >= 2 {
                    let d = NamedDoc { name: f[1].to_string(), title: f.get(2).map(|t| t.trim().to_string()).unwrap_or_default() };
                    if f[0] == "prereg" {
                        p.prereg.push(d);
                    } else {
                        p.results.push(d);
                    }
                }
            }
            "runmeta" => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(body.trim()) {
                    metas.push((arg.to_string(), v));
                }
            }
            "flag" => {
                if let Some((what, rid)) = arg.split_once(' ') {
                    flags.push((what.to_string(), rid.to_string()));
                }
            }
            "runs" => {
                if let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(body.trim()) {
                    rk_rows = Some(rows);
                }
            }
            _ => {}
        }
    }
    if !p.present {
        return empty_panel(p.home);
    }
    let s = |r: &serde_json::Value, k: &str| match r.get(k) {
        Some(serde_json::Value::String(x)) => x.clone(),
        Some(serde_json::Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let opt_s = |r: &serde_json::Value, k: &str| r.get(k).and_then(|v| v.as_str()).map(str::to_string).filter(|v| !v.is_empty());
    let has = |what: &str, rid: &str| flags.iter().any(|(w, r)| w == what && r == rid);
    let enrich = |run: &mut ResearchRun| {
        if let Some((_, meta)) = metas.iter().find(|(id, _)| *id == run.run_id) {
            run.cmd = match meta.get("cmd") {
                Some(serde_json::Value::Array(a)) if !a.is_empty() => {
                    Some(a.iter().map(|x| x.as_str().map(quote).unwrap_or_else(|| x.to_string())).collect::<Vec<_>>().join(" "))
                }
                Some(serde_json::Value::String(c)) if !c.is_empty() => Some(c.clone()),
                _ => None,
            };
            run.cwd = opt_s(meta, "cwd");
            run.ended_at = opt_s(meta, "ended_at");
            run.prereg = meta
                .get("prereg")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter().filter_map(|x| x.get("path").and_then(|p| p.as_str()).or_else(|| x.as_str()).map(str::to_string)).collect()
                })
                .unwrap_or_default();
            run.commit = opt_s(meta, "git_commit");
            run.dirty = meta.get("git_dirty").and_then(|v| v.as_bool());
        }
        run.has_metrics = has("metrics", &run.run_id);
        run.has_result = has("result", &run.run_id);
    };
    let blank = |run_id: String| ResearchRun {
        run_id,
        kind: String::new(),
        state: String::new(),
        exit_code: None,
        host: String::new(),
        started_at: String::new(),
        elapsed: String::new(),
        note: String::new(),
        cmd: None,
        cwd: None,
        ended_at: None,
        prereg: vec![],
        commit: None,
        dirty: None,
        has_metrics: false,
        has_result: false,
    };
    let mut runs: Vec<ResearchRun> = match &rk_rows {
        Some(rows) => rows
            .iter()
            .map(|r| ResearchRun {
                kind: s(r, "kind"),
                state: s(r, "state"),
                exit_code: r.get("exit_code").and_then(|x| x.as_i64()),
                host: s(r, "host"),
                started_at: s(r, "started_at"),
                elapsed: s(r, "elapsed"),
                note: s(r, "note"),
                ..blank(s(r, "run_id"))
            })
            .collect(),
        // 没有 rk.py 或 python3：直接用 meta.json。
        None => metas
            .iter()
            .map(|(id, meta)| {
                let code = meta.get("exit_code").and_then(|x| x.as_i64());
                ResearchRun {
                    kind: s(meta, "kind"),
                    state: match code {
                        Some(0) => "ok".into(),
                        Some(_) => "failed".into(),
                        None => "unknown".into(),
                    },
                    exit_code: code,
                    host: s(meta, "host"),
                    started_at: s(meta, "started_at"),
                    note: s(meta, "note"),
                    ..blank(id.clone())
                }
            })
            .collect(),
    };
    for r in runs.iter_mut() {
        enrich(r);
    }
    p.runs = runs;
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain() {
        let data = b" M src/a.rs\0?? new file.txt\0R  sub/new.rs\0sub/old.rs\0A  sub/x\0";
        let v = parse_porcelain_z(data, "");
        let got: Vec<(&str, &str)> = v.iter().map(|c| (c.status.as_str(), c.path.as_str())).collect();
        assert_eq!(got, [(" M", "src/a.rs"), ("??", "new file.txt"), ("R ", "sub/new.rs"), ("A ", "sub/x")]);
        let v = parse_porcelain_z(b" M sub/a\0", "sub/");
        assert_eq!(v[0].path, "a");
    }

    #[test]
    fn stat_lines_and_sort() {
        let e = parse_stat_lines("directory|4096|1700000000|src\nregular file|12|1700000000|b.txt\nsymbolic link|7|1700000000|ln|odd\nregular empty file|0|1|.a\n");
        let s = sort_entries(e);
        let names: Vec<(&str, &str)> = s.iter().map(|e| (e.kind.as_str(), e.name.as_str())).collect();
        assert_eq!(names, [("dir", "src"), ("file", ".a"), ("file", "b.txt"), ("link", "ln|odd")]);
        assert_eq!(s[0].mtime, "2023-11-14T22:13:20Z");
    }

    #[test]
    fn parents() {
        assert_eq!(parent_of("/"), None);
        assert_eq!(parent_of("/home"), Some("/".into()));
        assert_eq!(parent_of("/home/dev/w"), Some("/home/dev".into()));
    }

    #[test]
    fn text_decoding() {
        assert_eq!(decode_text(b"hello", false).as_deref(), Some("hello"));
        assert_eq!(decode_text(b"a\0b", false), None);
        assert_eq!(decode_text(&[0xff, 0xfe], false), None);
        let mut cut = "中文".as_bytes().to_vec();
        cut.pop();
        assert_eq!(decode_text(&cut, true).as_deref(), Some("中"));
        assert_eq!(decode_text(&cut, false), None);
        assert_eq!(cut_utf8("中文", 4), "中");
    }

    #[test]
    fn research_output() {
        let m = "__R__";
        let absent = parse_research(&format!("{m} home\tresearch\n{m} absent\n"), m);
        assert!(!absent.present);
        assert!(absent.state_md.is_none() && absent.runs.is_empty() && !absent.loop_.on);
        let t = format!(
            "{m} home\tresearch\n{m} present\n{m} loop\t2026-11-01T10:00:00\n{m} blocked\t等用户确认数据集\n\
{m} file STATE\n# 状态\n\n第二段\n\n{m} file LEDGER\nx\n\n{m} runs\n[{{\"run_id\":\"r1\",\"kind\":\"explore\",\"state\":\"running\",\"exit_code\":null,\"host\":\"gpu1\",\"started_at\":\"t\",\"elapsed\":\"1m\",\"note\":\"\",\"prereg\":\"-\"}}]\n\n{m} end\n"
        );
        let p = parse_research(&t, m);
        assert!(p.present);
        assert!(p.loop_.on);
        assert_eq!(p.loop_.started.as_deref(), Some("2026-11-01T10:00:00"));
        assert_eq!(p.loop_.blocked.as_deref(), Some("等用户确认数据集"));
        assert_eq!(p.state_md.as_deref(), Some("# 状态\n\n第二段\n"));
        assert_eq!(p.ledger_md.as_deref(), Some("x\n"));
        assert!(p.summary_md.is_none());
        assert_eq!(p.runs.len(), 1);
        assert_eq!(p.runs[0].exit_code, None);
        assert_eq!(p.runs[0].host, "gpu1");
    }

    #[test]
    fn run_ids() {
        assert!(valid_run_id("20261101-r01-baseline"));
        assert!(valid_run_id("a.b_c-1"));
        for bad in ["", ".", "..", "...", "a/b", "../x", "a b", "a;b", "$(x)", &"x".repeat(65)] {
            assert!(!valid_run_id(bad), "{bad}");
        }
    }

    #[test]
    fn artifact_kinds() {
        assert_eq!(artifact_kind("figs/loss.PNG"), Some("image"));
        assert_eq!(artifact_kind("a.svg"), Some("image"));
        assert_eq!(artifact_kind("paper/main.pdf"), Some("pdf"));
        assert_eq!(artifact_kind("data/x.parquet"), Some("table"));
        assert_eq!(artifact_kind("nb/a.ipynb"), Some("notebook"));
        assert_eq!(artifact_kind("report.htm"), Some("html"));
        assert_eq!(artifact_kind("results/r1.md"), Some("doc"));
        assert_eq!(artifact_kind("x/Paper/main.tex"), Some("doc"));
        assert_eq!(artifact_kind("README.md"), None, "不在报告类目录里的 md 不收");
        assert_eq!(artifact_kind("src/results.md"), None, "只看目录段，不看文件名");
        assert_eq!(artifact_kind("main.rs"), None);
        assert_eq!(artifact_kind("noext"), None);
    }

    #[test]
    fn artifacts_sorted_and_limited() {
        let body = "10|100|./a.png\n20|300|./results/r.md\n30|200|./README.md\n40|300|./b.csv\nbad line\n";
        let l = collect_artifacts(body, 10);
        let got: Vec<(&str, &str)> = l.items.iter().map(|a| (a.path.as_str(), a.kind.as_str())).collect();
        assert_eq!(got, [("b.csv", "table"), ("results/r.md", "doc"), ("a.png", "image")]);
        assert!(!l.truncated);
        assert_eq!(l.items[0].name, "b.csv");
        assert_eq!(l.items[0].mtime, "1970-01-01T00:05:00Z");
        let l = collect_artifacts(body, 2);
        assert_eq!(l.items.len(), 2);
        assert!(l.truncated);
    }

    /// 在本机临时目录里跑 find/stat 退路与 python 版本（本机是 BSD find/stat），结果应一致。
    #[cfg(unix)]
    #[test]
    fn artifact_scripts_run_locally() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("bunsen-unit-art-{}", short_id()));
        for d in ["figs", "results", ".hidden", "node_modules/x", "a/b/c/d/e/f/g/h/i"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        for f in [
            "figs/loss.png",
            "figs/Plot.SVG",
            "results/r1.md",
            ".hidden/x.png",
            "node_modules/x/y.png",
            "README.md",
            "t.csv",
            "a/b/c/d/e/f/g/deep.png",
            "a/b/c/d/e/f/g/h/i/too-deep.png",
        ] {
            std::fs::write(dir.join(f), "x").unwrap();
        }
        let run = |script: String| {
            let out = Command::new("bash").arg("-c").arg(script).current_dir(&dir).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            let l = collect_artifacts(&String::from_utf8_lossy(&out.stdout), 100);
            let mut v: Vec<String> = l.items.into_iter().map(|a| a.path).collect();
            v.sort();
            v
        };
        let expect = ["a/b/c/d/e/f/g/deep.png", "figs/Plot.SVG", "figs/loss.png", "results/r1.md", "t.csv"];
        let find = format!(
            "if stat -c %s . >/dev/null 2>&1; then find . -mindepth 1 -maxdepth {d} {e} -exec stat -c '%s|%Y|%n' {{}} +; \
             else find . -mindepth 1 -maxdepth {d} {e} -exec stat -f '%z|%m|%N' {{}} +; fi",
            d = ART_DEPTH,
            e = find_expr()
        );
        assert_eq!(run(find), expect);
        if Command::new("python3").arg("-c").arg("import os").output().map(|o| o.status.success()).unwrap_or(false) {
            assert_eq!(run(format!("python3 -c {}", quote(&artifact_py()))), expect);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn research_v11_fields() {
        let m = "__R__";
        let t = format!(
            "{m} home\tresearch\n{m} present\n{m} file OVERVIEW\n# 总览\n\n{m} file LESSONS\n- 教训\n\n{m} logtail\nl1\nl2\n\n\
{m} doc prereg\th1.md\t预登记：H1\n{m} doc results\t20261101-r01-x.md\t20261101-r01-x：结果\n\
{m} runmeta 20261101-r01-x\n{{\"run_id\":\"20261101-r01-x\",\"kind\":\"prereg\",\"cmd\":[\"python\",\"train.py\",\"--lr\",\"1e-3 x\"],\"cwd\":\"/w\",\"git_commit\":\"abc\",\"git_dirty\":false,\"prereg\":[{{\"path\":\"research/prereg/h1.md\",\"sha256\":\"0\"}}],\"ended_at\":\"2026-11-01T10:00:00+08:00\",\"exit_code\":0,\"host\":\"g1\",\"started_at\":\"s\"}}\n\
{m} flag metrics 20261101-r01-x\n{m} flag result 20261101-r01-x\n{m} end\n"
        );
        let p = parse_research(&t, m);
        assert!(p.present);
        assert_eq!(p.overview_md.as_deref(), Some("# 总览\n"));
        assert_eq!(p.lessons_md.as_deref(), Some("- 教训\n"));
        assert_eq!(p.log_tail.as_deref(), Some("l1\nl2\n"));
        assert_eq!(p.prereg, [NamedDoc { name: "h1.md".into(), title: "预登记：H1".into() }]);
        assert_eq!(p.results[0].name, "20261101-r01-x.md");
        // 没有 rk.py 输出：直接用 meta.json。
        assert_eq!(p.runs.len(), 1);
        let r = &p.runs[0];
        assert_eq!((r.state.as_str(), r.exit_code), ("ok", Some(0)));
        assert_eq!(r.cmd.as_deref(), Some("python train.py --lr '1e-3 x'"));
        assert_eq!(r.cwd.as_deref(), Some("/w"));
        assert_eq!(r.prereg, ["research/prereg/h1.md"]);
        assert_eq!((r.commit.as_deref(), r.dirty), (Some("abc"), Some(false)));
        assert!(r.has_metrics && r.has_result);
        // 有 rk.py 输出时以它为准，再用 meta.json 补字段。
        let t2 = t.replace(&format!("{m} end\n"), &format!("{m} runs\n[{{\"run_id\":\"20261101-r01-x\",\"kind\":\"prereg\",\"state\":\"running\",\"exit_code\":null,\"host\":\"g1\",\"started_at\":\"s\",\"elapsed\":\"3m\",\"note\":\"\"}}]\n\n{m} end\n"));
        let p = parse_research(&t2, m);
        assert_eq!((p.runs[0].state.as_str(), p.runs[0].elapsed.as_str()), ("running", "3m"));
        assert_eq!(p.runs[0].cwd.as_deref(), Some("/w"));
    }

    #[test]
    fn sections() {
        let v = parse_sections("junk\n__M__ a\nx\n\n__M__ b\n__M__ end\n", "__M__");
        assert_eq!(v, [("a".to_string(), "x\n".to_string()), ("b".to_string(), String::new()), ("end".to_string(), String::new())]);
    }
}
