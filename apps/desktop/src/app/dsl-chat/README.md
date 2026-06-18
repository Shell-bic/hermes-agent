# DSL Chat reuse boundary

DSL Chat should behave as an enhanced rendering layer for the existing chat
surface, not as a separate workspace projection.

Reusable chat exports live in `../chat`:

- `ChatRuntimeBoundary` owns the `$messages` subscription, runtime message
  caching, branch parent mapping, and assistant-ui runtime provider. DSL Chat
  should wrap its message renderer and composer with this boundary instead of
  reimplementing runtime conversion.
- `ChatRuntimeBoundaryProps` is the minimal contract for supplying run state and
  edit/reload/cancel/thread-message callbacks.
- `ChatHeader` and `ChatHeaderProps` provide the titlebar session menu used by
  the regular chat view.
- `ChatViewProps` is the full shell-level action surface. The composer-specific
  subset is already modeled by `ChatBarProps` from `../chat/composer/types`, and
  `ChatBar` / `ChatBarFallback` are exported from `../chat/composer`.

Keep DSL Chat composition close to `ChatView`: reuse `ChatRuntimeBoundary` around
the DSL message renderer plus `ChatBar`, and pass through the same `onSubmit`,
attachment, steering, edit, reload, and cancel callbacks from the shell.
