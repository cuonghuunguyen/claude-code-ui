# Ask an aside

Ask a side question about a session without touching it. An **aside** is a copy of the session that knows everything up to now. It answers in a floating popup while the session stays usable behind it.

## How to use

1. In a session, type `/btw` and your question in the prompt box, then press <kbd>Enter</kbd>. Or run **Ask aside** in the [command palette](palette). While a permission or question panel replaces the prompt box, **Ask aside** shows a one-line input.
2. The popup opens at once and starts to answer. It has its own timeline, a prompt box for follow-ups, and its own permission and question panels.
3. Drag the popup by its header, resize it by its corner, or click **Minimize aside** to fold it into a chip at the bottom right.
4. **Close aside** deletes the aside.
5. **Keep as session** turns it into a normal session: it gets a title in the sidebar and opens as a tab, and the popup closes.

## Good to know

- It works while Claude runs a turn. The turn goes on undisturbed. The aside sees the session up to the last complete reply, not what Claude is writing now. A session with no reply yet cannot be asked.
- An aside is read-only: Edit, Write and NotebookEdit are off, and it starts no workers. Other tools run in the default [mode](permissions), so Bash and others ask. Changing its permission mode lifts the read-only limit.
- Its requests show in its popup only, never in the session's panels. [Focus](focus) lists them as "Aside: *title*"; **Open** brings the popup forward.
- Several popups can be open. A popup shows only while its session's tab shows. Open popups are not restored after a page reload.
- On a phone the popup fills the screen.
- `/btw` and `/clear` do not work inside an aside. Images in the question are not sent.
- An aside that is not kept is not listed and is deleted when it is not needed any more, also after a browser close or a restart, so it does not show in `claude --resume`.
