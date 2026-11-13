import * as Dialog from "@radix-ui/react-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as Select from "@radix-ui/react-select";
import * as Switch from "@radix-ui/react-switch";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { hueOf } from "../lib/format";
import { useApp } from "../lib/store";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-hidden />;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: ReactNode;
  loading?: boolean;
};

export function Button({ variant = "default", size = "md", icon, loading, children, className, disabled, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      className={cx("btn", variant !== "default" && variant, size === "sm" && "sm", className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={13} /> : icon}
      {children}
    </button>
  );
}

export function Tip({ label, children, side = "bottom" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip" side={side} sideOffset={6}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function IconButton({
  label,
  children,
  active,
  className,
  side,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tip label={label} side={side}>
      <button type="button" aria-label={label} className={cx("icon-btn", active && "active", className)} {...rest}>
        {children}
      </button>
    </Tip>
  );
}

export type Tone = "ok" | "warn" | "err" | "mute" | "accent";

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={cx("dot", tone, pulse && "pulse")} aria-hidden />;
}

export function Pill({ tone, children, dot = true }: { tone: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cx("pill", tone)}>
      {dot && <Dot tone={tone} />}
      {children}
    </span>
  );
}

/** Agent 没有自己的图标：用名字首字母加一个稳定的颜色。 */
export function AgentMark({ id, name, size = 16 }: { id: string; name?: string; size?: number }) {
  const hue = hueOf(id);
  const letter = (name ?? id).trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className="agent-mark"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.6), ["--h" as string]: hue }}
      aria-hidden
    >
      {letter}
    </span>
  );
}

export type MenuItem =
  | { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean }
  | "sep";

export function Menu({ trigger, items, align = "end" }: { trigger: ReactNode; items: MenuItem[]; align?: "start" | "end" }) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="pop menu" align={align} sideOffset={4}>
          {items.map((it, i) =>
            it === "sep" ? (
              <Dropdown.Separator key={i} className="menu-sep" />
            ) : (
              <Dropdown.Item
                key={i}
                className={cx("menu-item", it.danger && "danger")}
                disabled={it.disabled}
                onSelect={() => it.onSelect()}
              >
                <span className="menu-icon">{it.icon}</span>
                {it.label}
              </Dropdown.Item>
            ),
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export type Option<T extends string> = { value: T; label: string; hint?: string; left?: ReactNode; right?: ReactNode; disabled?: boolean };

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
      <Select.Trigger className={cx(variant === "chip" ? "chip" : "field select-field", !cur && "placeholder")} aria-label={placeholder}>
        {cur ? (cur.left ?? icon) : icon}
        <Select.Value placeholder={placeholder}>{cur?.label}</Select.Value>
        <ChevronDown size={12} className="chev" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="pop menu" position="popper" sideOffset={6} align="start">
          <Select.Viewport>
            {options.length === 0 && <div className="menu-empty">{empty ?? "没有可选项"}</div>}
            {options.map((o) => (
              <Select.Item key={o.value} value={o.value} disabled={o.disabled} className="menu-item select-item">
                <span className="menu-icon">{o.left}</span>
                <span className="select-text">
                  <Select.ItemText>{o.label}</Select.ItemText>
                  {o.hint && <span className="select-hint">{o.hint}</span>}
                </span>
                {o.right}
                <Select.ItemIndicator className="select-check">
                  <Check size={13} />
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
    <label className={cx("toggle", disabled && "disabled")}>
      <Switch.Root className="switch" checked={checked} onCheckedChange={onChange} disabled={disabled}>
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
      {label && <span>{label}</span>}
    </label>
  );
}

export function Modal({
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
  size?: "sm" | "md" | "lg" | "xl";
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className={cx("modal", size)} aria-describedby={undefined}>
          <header className="modal-head">
            <div>
              <Dialog.Title className="modal-title">{title}</Dialog.Title>
              {description && <div className="modal-desc">{description}</div>}
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="关闭">
                <X size={15} />
              </button>
            </Dialog.Close>
          </header>
          <div className="modal-body">{children}</div>
          {footer && <footer className="modal-foot">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
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
      <div className="confirm-body">{body}</div>
    </Modal>
  );
}

export function Empty({ icon, title, hint, children }: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("form-field", className)}>
      <span className="form-label">{label}</span>
      {children}
      {hint && <span className="form-hint">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={cx(o.value === value && "on")} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Meter({ value, tone = "accent" }: { value: number; tone?: Tone }) {
  return (
    <span className="meter" aria-hidden>
      <span className={cx("meter-fill", tone)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx("toast", t.tone)}>
          <div className="toast-text">
            <div>{t.text}</div>
            {t.hint && <div className="toast-hint">{t.hint}</div>}
            {t.link && (
              <a className="toast-link" href={t.link.href} onClick={() => dismiss(t.id)}>
                {t.link.label}
              </a>
            )}
          </div>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={() => dismiss(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
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
