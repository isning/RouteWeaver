# Task overlays

These are product compositions of the official shadcn Radix Dialog, Sheet and AlertDialog components. They do not recreate Ant Design or alias its import path. Radix owns the focus trap, modal layering and Escape handling. Product-owned cancellation, pending mutations and triggerless focus return remain explicit.

## Declarative task

Import `TaskDialog` or `TaskSheet` from `ui-patterns/task-overlays`.

- `open`, `onOpenChange(next)` are controlled state. A caller with dirty-state review handles `false` without immediately unmounting.
- `title`, optional `description`, `children`, optional `footer` compose content.
- `pending` blocks Escape, backdrop dismissal and the close button. Footer actions remain caller-owned and should also be disabled appropriately.
- `size`: `sm`, `md` (default), `lg`, `xl`. Width is responsive, not arbitrary pixel CSS.
- `initialFocus: () => HTMLElement | null` opts into a specific initial element.
- `onReady` runs after the scope opens and focus is placed. `onClosed` runs after the scope releases focus, before owner-specific handoff. Keep task-generation guards in owners.
- `onCloseAutoFocus(event)` can prevent default when the owner performs a different explicit focus handoff.
- `contentRef` obtains the actual dialog element. `contentProps` puts semantic attributes/events on it. `bodyProps` puts events on the scrollable body.
- The content has `data-task-overlay="dialog"` or `"sheet"`; the scroll body has `data-task-overlay-body`. Do not inspect library classes.

Remove prior `modalRender` wrappers that merely implement a focus trap. Keep task-specific ownership refs with `contentRef` or `bodyProps.ref`. Replace `afterOpenChange` with `onReady` and `onClosed`. Replace width/styles overrides with `size` and scoped Tailwind utility classes only if needed. No implicit submit footer is created.

## Confirmation

Mount `ConfirmationProvider` around the application. `useConfirm()` returns a stable function:

```tsx
const confirm = useConfirm();
const handle = confirm({
  title: "放弃修改？",
  description: "尚未保存的修改将被丢弃。",
  confirmLabel: "放弃修改",
  cancelLabel: "继续编辑",
  destructive: true,
  onConfirm: () => discard(),
  onClosed: () => finishFocusHandoff(),
});
// Invalidate a stale decision without treating it as user cancellation.
handle.close();
```

The cancel button receives initial focus. A returned promise from `onConfirm` keeps the decision pending; rejection keeps it visible with the error and allows retry. `onCancel` is called only for user cancellation. `onClosed` fires once after focus restoration. `restoreFocus: false` allows an explicit owner to restore elsewhere. Concurrent confirmations are independent scopes; close handles are identity-bound.

The workspace-history domain still expects `{ destroy() }`; adapt only that call boundary with `{ destroy: handle.close }`, not an entire Ant Design API shim.

For success/error notifications import `toast` directly from `sonner`; the application mounts the official shadcn Toaster.
