"use client";

import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function DeleteConfirmDialog({
  children,
  title,
  description,
  confirmLabel = "Slett",
  disabled,
  onConfirm,
}: {
  children: ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild disabled={disabled}>
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <span className="flex size-10 items-center justify-center rounded-lg bg-red-50 text-red-700">
            <AlertTriangle className="size-5" />
          </span>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Avbryt
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button type="button" variant="destructive" onClick={() => void onConfirm()}>
              {confirmLabel}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
