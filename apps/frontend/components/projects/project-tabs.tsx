"use client";

import { createContext, type HTMLAttributes, type ReactNode, useContext, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

export function Tabs({
  defaultValue,
  value: valueProp,
  onValueChange,
  className,
  children,
}: {
  defaultValue: string;
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children: ReactNode;
}) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const value = valueProp ?? internalValue;
  const setValue = onValueChange ?? setInternalValue;
  const context = useMemo(() => ({ value, setValue }), [value, setValue]);

  return (
    <TabsContext.Provider value={context}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={className} {...props} />;
}

export function TabsTrigger({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error("TabsTrigger must be used inside Tabs.");
  }

  const active = context.value === value;

  return (
    <button
      type="button"
      onClick={() => context.setValue(value)}
      className={cn(
        "border-b-2 border-transparent font-medium text-slate-500 transition hover:text-slate-900",
        active && "border-sky-700 text-slate-950",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const context = useContext(TabsContext);
  if (!context || context.value !== value) {
    return null;
  }

  return <div className={className}>{children}</div>;
}
