import Link from "next/link";
import {
  cloneElement,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "outline" | "ghost" | "destructive";
type ButtonSize = "default" | "sm" | "lg";

function buttonClasses(variant: ButtonVariant, size: ButtonSize) {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-md border text-sm font-semibold transition-all outline-none",
    "focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55",
    variant === "default" && "border-blue-900 bg-blue-900 text-white hover:bg-blue-800 shadow-sm",
    variant === "outline" && "border-slate-300 bg-white text-slate-800 hover:bg-slate-50 shadow-sm",
    variant === "ghost" && "border-transparent bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900",
    variant === "destructive" && "border-red-300 bg-red-50 text-red-800 hover:bg-red-100",
    size === "default" && "h-9 px-4",
    size === "sm" && "h-8 px-3 text-[13px]",
    size === "lg" && "h-10 px-5 text-sm",
  );
}

export function Button({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  render?: ReactElement;
}) {
  const classes = cn(buttonClasses(variant, size), className);

  if (render) {
    const childProps = {
      className: cn(classes, (render.props as { className?: string }).className),
      ...props,
    };
    return cloneElement(render, childProps);
  }

  return <button className={classes} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-md border border-border bg-card shadow-sm", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pt-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-base font-bold text-foreground", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}

export function Badge({
  className,
  variant = "outline",
  children,
}: {
  className?: string;
  variant?: "default" | "outline" | "secondary";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] font-semibold",
        variant === "default" && "border-blue-900 bg-blue-900 text-white",
        variant === "secondary" && "border-emerald-200 bg-emerald-50 text-emerald-800",
        variant === "outline" && "border-slate-200 bg-white text-slate-700",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none transition",
        "focus:border-blue-400 focus:ring-2 focus:ring-blue-100",
        "placeholder:text-slate-400",
        props.className,
      )}
    />
  );
}

export function Label(props: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...props} className={cn("text-sm font-medium text-slate-700", props.className)} />;
}

export function NativeSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={cn(
          "h-9 w-full appearance-none rounded-md border border-slate-300 bg-white px-3 pr-10 text-sm outline-none transition",
          "focus:border-blue-400 focus:ring-2 focus:ring-blue-100",
          props.className,
        )}
      />
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
    </div>
  );
}

export function NativeSelectOption(props: React.OptionHTMLAttributes<HTMLOptionElement>) {
  return <option {...props} />;
}

export { Link };
