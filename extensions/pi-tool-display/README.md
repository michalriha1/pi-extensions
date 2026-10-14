# Tool display

Pending calls remain hidden by `HIDE_PENDING_CALLS`. Completed summaries are muted;
failures remain red. Click a category to show only its original native collapsed
previews; click it again, or a shown detail, to close. Ctrl+Shift+L retains keyboard
expansion.

## Subagents

`Agent` (case insensitive, installed `pi-subagents-lite/src/registration.ts`) and
`subagent` (Pi 1.2's bundled `examples/extensions/subagent/index.ts`) are launch
calls: **Called 1 subagent / Called N subagents**, with their own clickable section.
`AgentStatus`, `MessageAgent`, `StopAgent`, and result retrieval are not launches.
Counts are visible launch **calls**, not tasks inside a parallel/chain call.
`codemode` remains a script even when its code invokes agents: hidden nested calls
are not inferred from JavaScript or double-counted.

## Hover and compatibility

Fullscreen normalized `move` events underline the section under the pointer,
without replacing semantic colors. Hit tests use terminal columns and exclude
separators, padding, and truncation ellipses. Repeated movement within one section
does not invalidate its cached rows or request another render.

Pi 1.2's Container routes only to the hit child; it does not deliver leave events.
The existing Container patch observes departures, while instance-scoped hooks on
the tool's owning fullscreen UI (`createMouseEvent` and `requestRender`) cover
other layout components, blank space, and scroll/resize. These private hooks are
feature-detected and restored on reset/shutdown/reload. No raw input listeners,
mouse-mode changes, focus requests, or drag capture are added. Wheel, selection,
right-click, and native expanded-tool handlers keep their routing.

Regular mode uses terminal scrollback, not component mouse hover. Pi disables
all-motion reporting under tmux, Zellij, and screen; hover requires reported move
events, but clicks still work. Leaving the terminal window itself cannot be
detected without a terminal event. Private Pi routing APIs may need adaptation
in future releases.
