import { BLOCK_REASON_MAX, parseBlockReason } from '@/lib/tickets'
import type { BlockFlow, DeleteFlow } from '@/lib/ticket-actions'
import { FieldLabel } from './EditableText'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/** The kebab's Block item opens this: a reason is required before Block is enabled. */
export function TicketBlockDialog({
  ticketKey,
  blockFlow,
}: {
  ticketKey: string
  blockFlow: BlockFlow
}) {
  return (
    <Dialog
      open={blockFlow.blocking}
      onOpenChange={(open) => {
        // Ignore dismissal while the block is in flight; reset on any close.
        if (blockFlow.pending) return
        if (!open) blockFlow.close()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Block {ticketKey}?</DialogTitle>
          <DialogDescription>
            Blocking flags the ticket — it stays in its column. A reason is required.
          </DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Reason</FieldLabel>
          <Textarea
            aria-label="reason"
            rows={3}
            autoFocus
            maxLength={BLOCK_REASON_MAX}
            value={blockFlow.reason}
            placeholder="Why is this blocked?"
            // `setReason` also clears any stale validation error — that rule moved into
            // the flow with the error it owns.
            onChange={(e) => blockFlow.setReason(e.target.value)}
          />
        </label>
        {blockFlow.error ? (
          <p role="alert" className="text-destructive text-sm">
            {blockFlow.error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={blockFlow.close} disabled={blockFlow.pending}>
            Cancel
          </Button>
          <Button
            onClick={() => void blockFlow.submit()}
            disabled={blockFlow.pending || !parseBlockReason(blockFlow.reason).ok}
          >
            {blockFlow.pending ? 'Blocking…' : 'Block'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The kebab's Delete item opens this: a destructive confirm, disabled mid-delete. */
export function TicketDeleteDialog({
  ticketKey,
  deleteFlow,
}: {
  ticketKey: string
  deleteFlow: DeleteFlow
}) {
  return (
    <AlertDialog
      open={deleteFlow.confirming}
      onOpenChange={(open) => {
        if (!deleteFlow.deleting) deleteFlow.setConfirming(open)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {ticketKey}?</AlertDialogTitle>
          <AlertDialogDescription>
            This can’t be undone. The ticket will be removed from the board and backlog.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={deleteFlow.deleting}>
              Cancel
            </Button>
          </AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => void deleteFlow.submit()}
            disabled={deleteFlow.deleting}
          >
            {deleteFlow.deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
