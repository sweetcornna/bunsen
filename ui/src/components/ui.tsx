// 界面组件：每种东西只有一种写法（设计稿 .orchestra/design-ui-unify.md 第 2 节）。样式在 styles/components.css。
import * as RDialog from "@radix-ui/react-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as Select from "@radix-ui/react-select";
import * as Switch from "@radix-ui/react-switch";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Check, ChevronDown, CircleX, Info, Loader2, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type DragEventHandler, type HTMLAttributes, type MouseEventHandler, type ReactNode, type Ref, type RefObject } from "react";
import { fmtFull, fmtWhen, type TimeIn } from "../lib/format";
import { useApp } from "../lib/store";

/** lucide 图标只用这 4 个尺寸：xs 在 --h-xs 里，sm 在 --h-sm 控件里，md 默认（按钮、列表行、标签页、侧栏），lg 空状态。 */
export const ICON = { xs: 12, sm: 14, md: 16, lg: 20 } as const;
export type IconSize = (typeof ICON)[keyof typeof ICON];

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

type Side = "top" | "bottom" | "left" | "right";
type DataAttrs = { [k: `data-${string}`]: string | number | boolean | undefined };

export function Spinner({ size = ICON.sm }: { size?: IconSize }) {
  return <Loader2 size={size} className="spin" aria-hidden />;
}

/** 忙碌超过 ms 才显示转圈，免得一闪而过。 */
function useDelayed(on: boolean | undefined, ms = 150): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) {
      setShown(false);
      return;
    }
    const t = window.setTimeout(() => setShown(true), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return Boolean(on) && shown;
}

// ---------- 滚动区：边缘渐隐、滚动后才出现分隔线 ----------

/**
 * 给滚动容器标出两端还有没有内容：data-more-start（已经离开起点）、data-more-end（后面还有）。
 * markParent：同时在父元素上标 data-scrolled，父元素里的面板栏、页签栏据此显示底部分隔线。
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, axis: "x" | "y" = "y", markParent = false) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const start = axis === "y" ? el.scrollTop > 1 : el.scrollLeft > 1;
      const end = axis === "y" ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      el.toggleAttribute("data-more-start", start);
      el.toggleAttribute("data-more-end", end);
      if (markParent) el.parentElement?.toggleAttribute("data-scrolled", start);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref, axis, markParent]);
}

export function ScrollArea({ children, className, ref: outer, ...rest }: HTMLAttributes<HTMLDivElement> & DataAttrs & { ref?: Ref<HTMLDivElement> }) {
  const inner = useRef<HTMLDivElement | null>(null);
  useScrollEdges(inner, "y", true);
  return (
    <div
      ref={(el) => {
        inner.current = el;
        if (typeof outer === "function") outer(el);
        else if (outer) (outer as { current: HTMLDivElement | null }).current = el;
      }}
      className={cx("scroll-area", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * 页面（服务器、设置、研究项目）：内容最大宽 --page-w；页头高 --bar 起、吸顶，内容滚动后才出现分隔线。
 * 页头右侧最多一个 primary。
 */
export function Page({ title, sub, actions, children, ...data }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode } & DataAttrs) {
  return (
    <ScrollArea className="page" {...data}>
      <div className="page-inner">
        <header className="page-header">
          <div className="page-heading">
            <h1 className="page-title">{title}</h1>
            {sub && <div className="page-sub">{sub}</div>}
          </div>
          {actions && <div className="page-actions">{actions}</div>}
        </header>
        {children}
      </div>
    </ScrollArea>
  );
}

// ---------- Button / IconButton / InlineLink ----------

type Variant = "primary" | "secondary" | "ghost" | "danger";
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> &
  DataAttrs & {
    variant?: Variant;
    size?: "xs" | "sm" | "md" | "lg";
    icon?: ReactNode;
    loading?: boolean;
    /** 按下态（aria-pressed）用的语气：免确认这类有风险的开关按下时用 warn。 */
    tone?: "warn";
    ref?: Ref<HTMLButtonElement>;
  };

/** 一个区域最多一个 primary；secondary 是默认；ghost 用在次要动作；danger 只用在确认框。 */
export function Button({ variant = "secondary", size = "md", icon, loading, children, className, disabled, tone, ...rest }: BtnProps) {
  const spin = useDelayed(loading);
  return (
    <button
      type="button"
      className={cx("button", className)}
      data-variant={variant}
      data-size={size}
      data-tone={tone}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {spin ? <Spinner size={size === "xs" ? ICON.xs : size === "sm" ? ICON.sm : ICON.md} /> : icon}
      {children}
    </button>
  );
}

export function Tip({ label, children, side = "bottom" }: { label: ReactNode; children: ReactNode; side?: Side }) {
  if (label === null || label === undefined || label === "") return <>{children}</>;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" side={side} sideOffset={6}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** 正方形 ghost 按钮，必须有 aria-label 和提示。active 表示按下态（例如星标）。 */
export function IconButton({
  label,
  children,
  active,
  size = "md",
  side,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & DataAttrs & { label: string; active?: boolean; size?: "xs" | "sm" | "md"; side?: Side; ref?: Ref<HTMLButtonElement> }) {
  return (
    <Tip label={label} side={side}>
      <button type="button" aria-label={label} aria-pressed={active} className={cx("icon-button", className)} data-size={size} {...rest}>
        {children}
      </button>
    </Tip>
  );
}

/** 按钮形态的链接：点了在本页打开东西（预览、运行详情）。样子和 a 一样。 */
export function InlineLink({ children, icon, mono, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & DataAttrs & { icon?: ReactNode; mono?: boolean }) {
  return (
    <button type="button" className={cx("inline-link", mono && "mono", className)} {...rest}>
      {icon}
      {children}
    </button>
  );
}

// ---------- Tabs / Segmented ----------

export type TabItem<T extends string> = { value: T; label: ReactNode; count?: number | null; icon?: ReactNode; title?: string };

/** 下划线式页签。放不下时横向滚动、两端渐隐；键盘移到的页签整个滚进可见区（审查 P4F1-05）。 */
export function Tabs<T extends string>({ value, onChange, items, end, label, className, ...data }: { value: T; onChange: (v: T) => void; items: TabItem<T>[]; end?: ReactNode; label: string; className?: string } & DataAttrs) {
  const ref = useRef<HTMLDivElement | null>(null);
  useScrollEdges(ref, "x");
  return (
    <div className={cx("tabbar", className)} {...data}>
      <div
        ref={ref}
        className="tabbar-scroll"
        role="tablist"
        aria-label={label}
        onFocus={(e) => {
          if (e.target !== e.currentTarget) e.target.scrollIntoView({ block: "nearest", inline: "nearest" });
        }}
      >
        {items.map((it) => (
          <button key={it.value} type="button" role="tab" aria-selected={it.value === value} className="tabbar-item" title={it.title} onClick={() => onChange(it.value)}>
            {it.icon}
            <span>
              {it.label}
              {typeof it.count === "number" && (
                <>
                  {" "}
                  <span className="tabbar-count">{it.count}</span>
                </>
              )}
            </span>
          </button>
        ))}
      </div>
      {end && <div className="tabbar-end">{end}</div>}
    </div>
  );
}

export type SegOption<T extends string> = { value: T; label: ReactNode; count?: number | null; disabled?: boolean; title?: string };

/** 分段控件：只用于选值（主题、筛选）。选中用中性色。 */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: SegOption<T>[]; label?: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className="seg-item" disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
          {typeof o.count === "number" && <span className="seg-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- Row ----------

type RowProps = DataAttrs & {
  lead?: ReactNode;
  name: ReactNode;
  meta?: ReactNode;
  /** 悬停或聚焦才出现的操作，出现时盖住 meta。 */
  tail?: ReactNode;
  density?: "panel" | "nav";
  selected?: boolean;
  /** 多行内容（名称换行、下面还有一行说明）。 */
  multi?: boolean;
  title?: string;
  onClick?: () => void;
  href?: string;
  className?: string;
  nameClass?: string;
  role?: string;
  "aria-label"?: string;
  "aria-checked"?: boolean;
  "aria-expanded"?: boolean;
  /** 侧栏的会话行：拖进会话页在分屏中打开；右键打开它的菜单。 */
  onDragStart?: DragEventHandler<HTMLElement>;
  onContextMenu?: MouseEventHandler<HTMLElement>;
};

/** 列表行：前导（图标或状态点）· 名称（截断用渐隐）· 元信息（右对齐、等宽数字）· 尾部操作。 */
export function Row({ lead, name, meta, tail, density = "panel", selected, multi, title, onClick, href, className, nameClass, ...rest }: RowProps) {
  const body = (
    <>
      {lead !== undefined && <span className="list-row-lead">{lead}</span>}
      <span className={cx("list-row-name", nameClass)}>{name}</span>
      {meta !== undefined && meta !== null && meta !== "" && <span className="list-row-meta">{meta}</span>}
    </>
  );
  const common = { "data-density": density === "nav" ? "nav" : undefined, "data-multi": multi ? "" : undefined, title };
  const sel = selected ? { "aria-current": "true" as const } : {};
  if (tail) {
    const main = href ? (
      <a className="list-row-main" href={href} {...sel}>
        {body}
      </a>
    ) : onClick ? (
      <button type="button" className="list-row-main" onClick={onClick} {...sel}>
        {body}
      </button>
    ) : (
      <div className="list-row-main">{body}</div>
    );
    return (
      <div className={cx("list-row", className)} data-hover="" {...common} {...(selected ? { "aria-current": "true" } : {})} {...rest}>
        {main}
        <span className="list-row-tail">{tail}</span>
      </div>
    );
  }
  if (href)
    return (
      <a className={cx("list-row", className)} href={href} {...common} {...sel} {...rest}>
        {body}
      </a>
    );
  if (onClick)
    return (
      <button type="button" className={cx("list-row", className)} onClick={onClick} {...common} {...sel} {...rest}>
        {body}
      </button>
    );
  return (
    <div className={cx("list-row", className)} {...common} {...sel} {...rest}>
      {body}
    </div>
  );
}

// ---------- Table / Facts ----------

export function Table({ density = "page", children, className, ...data }: { density?: "page" | "panel"; children: ReactNode; className?: string } & DataAttrs) {
  return (
    <div className="tbl-wrap" {...data}>
      <table className={cx("tbl", className)} data-density={density}>
        {children}
      </table>
    </div>
  );
}

export function Facts({ children, className, ...data }: { children: ReactNode; className?: string } & DataAttrs) {
  return (
    <dl className={cx("kv", className)} {...data}>
      {children}
    </dl>
  );
}

export function Fact({ label, children, ...data }: { label: ReactNode; children: ReactNode } & DataAttrs) {
  return (
    <>
      <dt>{label}</dt>
      <dd {...data}>{children}</dd>
    </>
  );
}

// ---------- Badge / Dot ----------

export type BadgeTone = "neutral" | "warn" | "err";

/** 徽标：中性（默认）、warn、err，没有 ok，没有点。 */
export function Badge({ tone = "neutral", children, title, mono, className, ...data }: { tone?: BadgeTone; children: ReactNode; title?: string; mono?: boolean; className?: string } & DataAttrs) {
  return (
    <span className={cx("badge", mono && "mono", className)} data-tone={tone === "neutral" ? undefined : tone} title={title} {...data}>
      {children}
    </span>
  );
}

export type DotTone = "live" | "err" | "warn" | "new" | "idle";

/** 6px 状态点：live（正在运行，呼吸）、err、warn、new（有新输出，强调色）、idle。给了 label 时读屏读它。 */
export function Dot({ tone, label }: { tone: DotTone; label?: string }) {
  return label ? <span className="status-dot" data-tone={tone} role="img" aria-label={label} title={label} /> : <span className="status-dot" data-tone={tone} aria-hidden />;
}

// ---------- Surface / Section / Empty ----------

export function Surface({ kind = "card", as = "div", className, children, ...rest }: { kind?: "card" | "well" | "float"; as?: "div" | "section" | "article"; className?: string; children: ReactNode } & DataAttrs & HTMLAttributes<HTMLElement>) {
  const Tag = as;
  return (
    <Tag className={cx(`surface-${kind}`, className)} {...rest}>
      {children}
    </Tag>
  );
}

/** 不画框的区块：标题行（可带计数和右侧的 ghost 按钮）加内容。 */
export function Section({ title, count, end, children, className, ...data }: { title: ReactNode; count?: ReactNode; end?: ReactNode; children?: ReactNode; className?: string } & DataAttrs) {
  return (
    <section className={cx("section", className)} {...data}>
      <div className="section-head">
        <h2 className="section-title">
          {title}
          {count !== undefined && count !== null && (
            <>
              {" "}
              <span className="section-count">{count}</span>
            </>
          )}
        </h2>
        {end && <div className="section-end">{end}</div>}
      </div>
      {children}
    </section>
  );
}

export function GroupTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("group-title", className)}>{children}</div>;
}

/** 空状态：标题说发生了什么，说明说怎么办；最多一个主动作。 */
export function Empty({ icon, title, hint, children, ...data }: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; children?: ReactNode } & DataAttrs) {
  return (
    <div className="empty-block" {...data}>
      {icon && <div className="empty-block-icon">{icon}</div>}
      <div className="empty-block-title">{title}</div>
      {hint && <div className="empty-block-hint">{hint}</div>}
      {children && <div className="empty-block-actions">{children}</div>}
    </div>
  );
}

/** 区块里的“暂无”：一行 muted 文字。 */
export function EmptyLine({ children, ...data }: { children: ReactNode } & DataAttrs) {
  return (
    <div className="empty-line" {...data}>
      {children}
    </div>
  );
}

/** 加载中：只在内容区显示一个转圈。 */
export function Loading({ hint }: { hint?: ReactNode }) {
  return (
    <div className="empty-block" aria-busy="true">
      <Spinner size={ICON.lg} />
      {hint && <div className="empty-block-hint">{hint}</div>}
    </div>
  );
}

// ---------- Notice ----------

/** 提示和错误：well 加 2px 状态左边线，正文主色；原始报错折叠在“详情”里（等宽，先显示 8 行）。 */
export function Notice({ tone = "neutral", children, hint, raw, action, icon, className, ...data }: { tone?: BadgeTone; children: ReactNode; hint?: ReactNode; raw?: string | null; action?: ReactNode; icon?: ReactNode; className?: string } & DataAttrs) {
  const I = tone === "err" ? CircleX : tone === "warn" ? TriangleAlert : Info;
  return (
    <div className={cx("notice", className)} data-tone={tone === "neutral" ? undefined : tone} {...data}>
      <span className="notice-icon">{icon ?? <I size={ICON.md} />}</span>
      <div className="notice-body">
        <div>{children}</div>
        {hint && <div className="notice-hint">{hint}</div>}
        {raw && (
          <details className="notice-raw">
            <summary>详情</summary>
            <pre>{raw}</pre>
          </details>
        )}
      </div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}

// ---------- Field / Picker / Toggle ----------

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("field-group", className)}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export type Option<T extends string> = { value: T; label: string; hint?: string; left?: ReactNode; right?: ReactNode; disabled?: boolean };

/** 下拉：field 外观（表单里）和 chip 外观（欢迎页工具栏：ghost 按钮加箭头）。 */
export function Picker<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  icon,
  variant = "chip",
  empty,
  disabled,
}: {
  value: T | null;
  onChange: (v: T) => void;
  options: Option<T>[];
  placeholder: string;
  icon?: ReactNode;
  variant?: "chip" | "field";
  empty?: ReactNode;
  disabled?: boolean;
}) {
  const cur = options.find((o) => o.value === value);
  // 始终受控：没有选中项（或选中的值不在选项里）时传空串。传 undefined 会让 Radix Select 变成非受控，
  // 继续显示、勾选上一次选的项；Radix 2.x 把空串当作“显示占位文字”，选项的 value 不能是空串。
  return (
    <Select.Root value={cur ? cur.value : ""} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <Select.Trigger
        className={variant === "chip" ? "button picker-chip" : "input picker-field"}
        {...(variant === "chip" ? { "data-variant": "ghost", "data-size": "md" } : {})}
        aria-label={placeholder}
      >
        {cur ? (cur.left ?? icon) : icon}
        <span className="label">
          <Select.Value placeholder={placeholder}>{cur?.label}</Select.Value>
        </span>
        <ChevronDown size={ICON.sm} className="chev" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="menu-panel" position="popper" sideOffset={6} align="start">
          <Select.Viewport>
            {options.length === 0 && <div className="menu-note">{empty ?? "没有可选项"}</div>}
            {options.map((o) => (
              <Select.Item key={o.value} value={o.value} disabled={o.disabled} className="menu-row">
                <span className="menu-row-icon">{o.left}</span>
                <span className="menu-row-text">
                  <Select.ItemText>{o.label}</Select.ItemText>
                  {o.hint && <span className="menu-row-hint">{o.hint}</span>}
                </span>
                {o.right}
                <Select.ItemIndicator className="menu-row-check">
                  <Check size={ICON.sm} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="toggle-label">
      <Switch.Root className="switch" checked={checked} onCheckedChange={onChange} disabled={disabled}>
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
      {label && <span>{label}</span>}
    </label>
  );
}

// ---------- Dialog / Confirm ----------

/** 打开时焦点落在第一个输入框；没有输入框时落在“取消”（data-dialog-cancel），再没有就落在底栏第一个按钮。 */
function focusFirst(e: Event) {
  const root = e.target as HTMLElement | null;
  if (!root?.querySelector) return;
  const el =
    root.querySelector<HTMLElement>(".dialog-body :is(input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not(:disabled), textarea:not(:disabled))") ??
    root.querySelector<HTMLElement>("[data-dialog-cancel]") ??
    root.querySelector<HTMLElement>(".dialog-foot button:not(:disabled)");
  if (el) {
    e.preventDefault();
    el.focus();
  }
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="dialog-overlay" />
        <RDialog.Content className="dialog" data-size={size} aria-describedby={undefined} onOpenAutoFocus={focusFirst}>
          <header className="dialog-head">
            <RDialog.Title className="dialog-title">{title}</RDialog.Title>
            {description && <div className="dialog-desc">{description}</div>}
            <RDialog.Close asChild>
              <IconButton label="关闭" size="sm" className="dialog-close">
                <X size={ICON.sm} />
              </IconButton>
            </RDialog.Close>
          </header>
          <div className="dialog-body">{children}</div>
          {footer && <footer className="dialog-foot">{footer}</footer>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function Confirm({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" data-dialog-cancel="" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="secondary">{body}</div>
    </Dialog>
  );
}

// ---------- Menu ----------

export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean } | "sep";

/** 下拉菜单。open/onOpenChange：受控打开（侧栏右键）；onCloseAutoFocus：关掉时焦点去哪（分屏小窗的菜单把焦点还给终端）。 */
export function Menu({
  trigger,
  items,
  align = "end",
  open,
  onOpenChange,
  onCloseAutoFocus,
  ...data
}: { trigger: ReactNode; items: MenuItem[]; align?: "start" | "end"; open?: boolean; onOpenChange?: (v: boolean) => void; onCloseAutoFocus?: (e: Event) => void } & DataAttrs) {
  return (
    <Dropdown.Root open={open} onOpenChange={onOpenChange}>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu-panel" align={align} sideOffset={4} onCloseAutoFocus={onCloseAutoFocus} {...data}>
          {items.map((it, i) =>
            it === "sep" ? (
              <Dropdown.Separator key={i} className="menu-divider" />
            ) : (
              <Dropdown.Item key={i} className="menu-row" data-danger={it.danger ? "" : undefined} disabled={it.disabled} onSelect={() => it.onSelect()}>
                <span className="menu-row-icon">{it.icon}</span>
                <span className="menu-row-text">{it.label}</span>
              </Dropdown.Item>
            ),
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

// ---------- Toast ----------

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast-card" data-tone={t.tone}>
          <span className="toast-icon">{t.tone === "err" ? <CircleX size={ICON.md} /> : t.tone === "ok" ? <Check size={ICON.md} /> : <Info size={ICON.md} />}</span>
          <div className="toast-text">
            <div>{t.text}</div>
            {t.hint && <div className="toast-hint">{t.hint}</div>}
            {t.link && (
              <a href={t.link.href} onClick={() => dismiss(t.id)}>
                {t.link.label}
              </a>
            )}
          </div>
          <IconButton label="关闭" size="sm" onClick={() => dismiss(t.id)}>
            <X size={ICON.sm} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

// ---------- 其他 ----------

/** 时间点：界面上统一的写法，悬停看完整本地时间；认不出的时间不显示。 */
export function When({ iso, className, suffix }: { iso: TimeIn; className?: string; suffix?: string }) {
  const text = fmtWhen(iso);
  if (!text) return null;
  return (
    <time className={className} dateTime={typeof iso === "number" ? undefined : (iso ?? undefined)} title={fmtFull(iso)}>
      {text}
      {suffix}
    </time>
  );
}

export function Meter({ value, tone = "neutral" }: { value: number; tone?: BadgeTone }) {
  const t = tone === "warn" || tone === "err" ? tone : undefined;
  return (
    <span className="meter" aria-hidden>
      <span className="meter-fill" data-tone={t} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  );
}

/** Agent 没有自己的图标：用名字首字母，中性底色。 */
export function AgentMark({ id, name, size = "md" }: { id: string; name?: string; size?: "md" | "lg" }) {
  const letter = (name ?? id).trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="agent-glyph" data-size={size === "lg" ? "lg" : undefined} aria-hidden>
      {letter}
    </span>
  );
}

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M16 3.5c2.6 4.4 7 7.6 7 13.3a7 7 0 0 1-14 0c0-5.7 4.4-8.9 7-13.3z" fill="none" stroke="var(--brand)" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M16 13.2c1.3 2.1 3 3.4 3 5.8a3 3 0 0 1-6 0c0-2.4 1.7-3.7 3-5.8z" fill="var(--brand)" />
      <path d="M11 28.2h10" stroke="var(--brand)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export { Tooltip };
