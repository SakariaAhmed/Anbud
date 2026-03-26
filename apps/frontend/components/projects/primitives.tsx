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
    "inline-flex items-center justify-center gap-2 rounded-xl border text-sm font-medium transition outline-none",
    "focus-visible:ring-2 focus-visible:ring-sky-300 disabled:pointer-events-none disabled:opacity-55",
    variant === "default" && "border-sky-700 bg-sky-700 text-white hover:bg-sky-800",
    variant === "outline" && "border-slate-300 bg-white text-slate-900 hover:bg-slate-50",
    variant === "ghost" && "border-transparent bg-transparent text-slate-700 hover:bg-slate-100",
    variant === "destructive" && "border-red-200 bg-red-50 text-red-700 hover:bg-red-100",
    size === "default" && "h-10 px-4",
    size === "sm" && "h-9 px-3 text-sm",
    size === "lg" && "h-11 px-5 text-base",
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
  return <div className={cn("rounded-[28px]", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-6 pt-6", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-lg font-semibold", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-sm text-slate-500", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-6 pb-6", className)} {...props} />;
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
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
        variant === "default" && "border-sky-700 bg-sky-700 text-white",
        variant === "secondary" && "border-emerald-200 bg-emerald-50 text-emerald-700",
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
        "h-11 w-full rounded-2xl border border-slate-300 bg-white px-3 text-base outline-none transition",
        "focus:border-sky-400 focus:ring-2 focus:ring-sky-200",
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
          "h-11 w-full appearance-none rounded-2xl border border-slate-300 bg-white px-3 pr-10 text-base outline-none transition",
          "focus:border-sky-400 focus:ring-2 focus:ring-sky-200",
          props.className,
        )}
      />
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
    </div>
  );
}

export function NativeSelectOption(props: React.OptionHTMLAttributes<HTMLOptionElement>) {
  return <option {...props} />;
}

export { Link };
