// 路径预览的唯一出口（第四期契约 Q8、Q14，审查 P4F1-02、07，P4F2-01、02）。
// 服务端的文件接口接受绝对路径和 ~（docs/API.md 第 7 节），前端是唯一一道防线：研究面板里凡是要点开预览的路径
// （输出清单、输入、计划交付物、预登记、结果页、问题出处、账本证据），都先经这里换成“相对工作目录、按 / 规范化、
// 不含 ..、首段不以 ~ 开头、不以 / 开头、每段首尾没有空白且不含控制字符”的形式；换不了就返回 null，界面上不给点。
// 这个文件不引入任何模块，检查脚本可以直接用 node 跑。

/** 路径相对什么：工作目录、研究目录、仓库根（outputs.json、meta.inputs、计划交付物的 resolved）。 */
export type PathBase = "workdir" | "home" | "repo";

export type PathCtx = {
  /** 会话的工作目录，可能以 ~ 开头。 */
  workdir: string;
  /** 服务器的家目录（探测结果），用来展开工作目录里的 ~；没探测过为 null。 */
  serverHome: string | null;
  /** 研究目录（Research.home）：一般相对工作目录，也可以是绝对路径或带 ..，但要落在工作目录之内才能预览。 */
  home: string;
  /** 工作目录相对仓库根的前缀：就是仓库根时为 ""，不在 git 仓库里（或服务端没给）为 null。 */
  repoPrefix: string | null;
};

/**
 * 一段能不能用：首尾不能有空白，不能含控制字符（审查 P4F2-01，契约 Q14）。
 * 旧服务端会先 trim（Rust 的 Unicode 空白，含 U+0085）再展开 ~，" /etc/passwd"、" ~/.ssh" 在这里看着像相对路径，
 * 到服务端就成了工作目录外的文件；JS 的 trim 不处理 U+0085，所以控制字符单独列出。
 */
const segOk = (s: string) => s.trim() === s && !/[\u0000-\u001f\u007f-\u009f]/.test(s);

/** 按 / 拆段，去掉空段和 "."；有 ".."、坏段返回 null。 */
function segments(p: string): string[] | null {
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === ".." || !segOk(s)) return null;
    out.push(s);
  }
  return out;
}

/** 接在 base 后面按字面消去 "." 和 ".."（只用于研究目录，路径本身仍不许有 ".."）；退到根之上或有坏段返回 null。 */
function joinDots(base: string[], p: string): string[] | null {
  const out = [...base];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (!segOk(s)) return null;
    if (s === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(s);
  }
  return out;
}

/** 相对路径的段：不能以 / 开头，规范化之后不能为空，首段不能以 ~ 开头（服务端会把它展开成某个家目录）。 */
function relSegments(p: string): string[] | null {
  if (p.startsWith("/")) return null;
  const s = segments(p);
  return s && s.length > 0 && !s[0].startsWith("~") ? s : null;
}

/** 工作目录的绝对路径段：~ 用家目录展开，展不开为 null。 */
function workdirSegments(ctx: PathCtx): string[] | null {
  let wd = ctx.workdir.trim();
  if (wd === "~" || wd.startsWith("~/")) {
    if (!ctx.serverHome || !ctx.serverHome.startsWith("/")) return null;
    wd = `${ctx.serverHome}/${wd.slice(1)}`;
  }
  if (!wd.startsWith("/")) return null;
  return segments(wd);
}

const startsWith = (whole: string[], head: string[]) => whole.length > head.length && head.every((s, i) => whole[i] === s);
const within = (whole: string[], head: string[]) => whole.length >= head.length && head.every((s, i) => whole[i] === s);

/**
 * 研究目录相对工作目录的段（可以为空，即研究目录就是工作目录）；不在工作目录之内为 null。
 * 研究目录可以是绝对路径（.claude/research-home 首行以 / 开头），也可以带 ".."：先和工作目录合并、消去 ".."，
 * 再要求仍在工作目录之内（审查 P4F2-02）。以 ~ 开头的不认。
 */
function homeSegments(ctx: PathCtx): string[] | null {
  const home = typeof ctx.home === "string" ? ctx.home : "";
  if (home === "" || home.startsWith("~")) return null;
  if (!home.startsWith("/") && !home.split("/").includes("..")) {
    const h = segments(home);
    return h && (h.length === 0 || !h[0].startsWith("~")) ? h : null;
  }
  const wd = workdirSegments(ctx);
  if (!wd) return null;
  const abs = joinDots(home.startsWith("/") ? [] : wd, home);
  return abs && within(abs, wd) ? abs.slice(wd.length) : null;
}

/**
 * 把一个路径换成可以交给文件接口预览的、相对工作目录的路径；不能预览时返回 null。
 * - 绝对路径（不论 base）：规范化后必须落在工作目录之内，返回工作目录之下的部分；
 * - 相对工作目录：规范化；
 * - 相对研究目录：接在研究目录（换算成相对工作目录的段）后面；
 * - 相对仓库根：repoPrefix 为 null 时一律不认；否则必须以前缀开头（按段比），去掉前缀。
 */
export function previewPath(path: unknown, base: PathBase, ctx: PathCtx): string | null {
  if (typeof path !== "string" || path === "" || path.includes("\0")) return null;
  let segs: string[] | null;
  if (path.startsWith("/")) {
    const abs = segments(path);
    const wd = workdirSegments(ctx);
    segs = abs && wd && startsWith(abs, wd) ? abs.slice(wd.length) : null;
  } else {
    const rel = relSegments(path);
    if (!rel) return null;
    if (base === "workdir") segs = rel;
    else if (base === "home") {
      const h = homeSegments(ctx);
      segs = h ? [...h, ...rel] : null;
    } else {
      if (ctx.repoPrefix === null || ctx.repoPrefix === undefined) return null;
      // 只有正好是 "" 才算仓库根；只有空白的前缀不认（审查 P4F2-01 的同类情形）。
      const pre = ctx.repoPrefix === "" ? [] : relSegments(ctx.repoPrefix);
      segs = pre && (pre.length === 0 || startsWith(rel, pre)) ? rel.slice(pre.length) : null;
    }
  }
  if (!segs || segs.length === 0 || segs[0].startsWith("~")) return null;
  return segs.join("/");
}
