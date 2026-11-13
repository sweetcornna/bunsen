// 新建研究项目的校验规则：名称、汇合点、研究目录、研究分支（契约 3.1【修订 A2、G12】、3.2【G19】、3.3【修订 A1、G1】）。
// 照 crates/core/src/projects.rs 的 validate_new / validate_branch / default_branch 写；新建项目表单和 dev/mock-server.ts 共用这一份。
// 这里不引用任何界面代码，mock 直接 import。

// 字符类都用字符串拼：源文件里不出现 U+2028、U+2029 本身（它们在 JS 源码里会断行）。
/** Rust char::is_whitespace / str::trim 认的空白（Unicode White_Space）。JS 的 \s、trim 还认 U+FEFF、不认 U+0085，和服务端不一致。 */
const WS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** Rust char::is_control：Unicode Cc，含换行、制表符。 */
const CC = "\\u0000-\\u001f\\u007f-\\u009f";
const TRIM_RE = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
const CONTROL_RE = new RegExp(`[${CC}]`);
/** 名称的“单行”：控制字符，加上行分隔符 U+2028、U+2029。 */
const MULTILINE_RE = new RegExp(`[${CC}\\u2028\\u2029]`);
/** 汇合点里不能有的字符：任何空白或控制字符。 */
const HUB_BAD_RE = new RegExp(`[${WS}${CC}]`);

/** 和服务端一样去首尾空白。 */
export const trimName = (name: string) => name.replace(TRIM_RE, "");

export type NameIssue = "slash" | "dot" | "multiline" | "empty" | "long";
/** 项目名称的问题；参数是原样输入（还没去空白）。顺序和服务端一致：先看 . 和 ..，再看 /，再看单行和长度（按 Unicode 字符计【G11】）。 */
export function nameIssue(raw: string): NameIssue | null {
  const name = trimName(raw);
  if (name === "." || name === "..") return "dot"; // 浏览器会把网址里的这两段规整掉【G19】
  if (name.includes("/")) return "slash";
  if (MULTILINE_RE.test(raw)) return "multiline";
  const n = [...name].length;
  if (n === 0) return "empty";
  if (n > 40) return "long";
  return null;
}
/** 服务端对每种问题回的文字（mock 照着回 400），和 validate_new 逐字一致（含 G19 那句）。 */
export const NAME_ERROR: Record<NameIssue, string> = {
  slash: "项目名称不能含 /：名称可用于 API 路径，/ 会破坏路径分段",
  dot: "项目名称不能是 . 或 ..",
  multiline: "项目名称要写成一行，去掉首尾空白后为 1 到 40 个字符",
  empty: "项目名称要写成一行，去掉首尾空白后为 1 到 40 个字符",
  long: "项目名称要写成一行，去掉首尾空白后为 1 到 40 个字符",
};

/** 表单里的提示；合规返回 null。allowEmpty：还没填的不算错，只是还不能提交。 */
export function nameProblem(raw: string, allowEmpty = false): string | null {
  const issue = nameIssue(raw);
  if (issue === "slash") return "不能含 /：项目名也用在网址里";
  if (issue === "dot") return "不能是 . 或 ..：项目名也用在网址里，浏览器会把这两个规整掉";
  if (issue === "multiline") return "要写成一行：不能含换行、制表符等控制字符";
  if (issue === "empty") return allowEmpty ? null : "名称不能为空";
  if (issue === "long") return `最多 40 个字符，现在 ${[...trimName(raw)].length} 个`;
  return null;
}

/** 汇合点哪里不合规。服务端不去空白：整串原样，不能为空，任何位置（含首尾）都不能有空白或控制字符。 */
export function hubProblem(raw: string, allowEmpty = false): string | null {
  if (!raw) return allowEmpty ? null : "汇合点不能为空";
  if (HUB_BAD_RE.test(raw)) return "不能含空格、换行等空白或控制字符（首尾也不行）";
  return null;
}
export const HUB_ERROR = "汇合点不能为空，也不能含空白或换行";

/** 研究目录哪里不合规。服务端不去空白；表单里留空表示用缺省的 research（不送这个字段），所以这里的空串是错。 */
export function homeProblem(raw: string): string | null {
  if (!raw) return "研究目录不能为空";
  if (raw.startsWith("/")) return "要相对路径，不能以 / 开头";
  if (raw.includes("..")) return "不能含 ..";
  if (CONTROL_RE.test(raw)) return "不能含换行、制表符等控制字符";
  return null;
}
export const HOME_ERROR = "研究目录要用非空相对路径，不能含 .. 或换行";
/** 服务端保存前的规整：去掉空段和 "."，什么都不剩时是仓库根 "."。 */
export const normalizeHome = (home: string) =>
  home
    .split("/")
    .filter((p) => p && p !== ".")
    .join("/") || ".";

export const BRANCH_RE = /^research\/[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
export const BRANCH_RULE = "简称以英文字母或数字开头，最多 40 个字符，只用英文字母、数字和 _ . -，不能含 ..，不能以 . 或 .lock 结尾";

/** 研究分支名哪里不合规；合规返回 null。 */
export function branchProblem(branch: string): string | null {
  if (!branch.startsWith("research/")) return "要写成 research/<简称>";
  const s = branch.slice("research/".length);
  if (!s) return "research/ 后面要写简称";
  if (/[^A-Za-z0-9_.-]/.test(s)) return "简称只能用英文字母、数字和 _ . -";
  if (!/^[A-Za-z0-9]/.test(s)) return "简称要以英文字母或数字开头";
  if (s.length > 40) return `简称最多 40 个字符，现在 ${s.length} 个`;
  if (s.includes("..")) return "简称里不能有 ..";
  if (s.endsWith(".") || s.endsWith(".lock")) return "简称不能以 . 或 .lock 结尾";
  return BRANCH_RE.test(branch) ? null : "研究分支名不合规";
}

/** 没给研究分支、汇合点上也没有 research/* 时，服务端按名称规整出的分支。 */
export function defaultBranch(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, 40)
    .replace(/[^A-Za-z0-9]+$/, "");
  return `research/${slug || "main"}`;
}
