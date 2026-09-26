"use client";

import { AlertTriangle } from "lucide-react";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";

interface BulkDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  count: number;
  sharedCount?: number;
  isPending?: boolean;
}

export function BulkDeleteDialog({
  open,
  onOpenChange,
  onConfirm,
  count,
  sharedCount = 0,
  isPending = false,
}: BulkDeleteDialogProps) {
  return (
    <ConfirmationDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      title={
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          Delete {notes(count)}?
        </div>
      }
      description={deleteDescription(count, sharedCount)}
      confirmLabel="Delete"
      variant="destructive"
      isPending={isPending}
    />
  );
}

const notes = (count: number) => `${count} note${count > 1 ? "s" : ""}`;
const these = (count: number) => (count > 1 ? "These notes" : "This note");

function deleteDescription(count: number, sharedCount: number): string {
  if (sharedCount === 0) {
    return `${these(count)} will be moved to trash.`;
  }
  if (sharedCount === count) {
    return `${these(count)} will be removed from your notes.`;
  }
  return "Notes you own will be moved to trash. Shared notes will be removed from your notes.";
}
