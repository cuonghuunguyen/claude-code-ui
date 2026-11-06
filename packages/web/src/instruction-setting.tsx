import { COMMIT_INSTRUCTION_MAX } from "@claude-ui/protocol";
import { isImeKey } from "./ime.ts";

/** A multi-line text setting (Settings › Git, commit message instruction): saved when the box loses focus (Ctrl/Cmd+Enter leaves it); `key` resets the draft to the saved value. */
export function InstructionSetting({ id, label, hint, value, placeholder, onSave }: { id: string; label: string; hint: string; value: string; placeholder?: string; onSave: (next: string) => void }) {
  return (
    <div className="flex flex-col gap-1 border-t py-2" data-testid={id}>
      <label htmlFor={`${id}-input`} className="block text-sm">{label}</label>
      <span id={`${id}-hint`} className="block text-muted-foreground text-xs">{hint}</span>
      <textarea
        key={value}
        id={`${id}-input`}
        defaultValue={value}
        rows={4}
        maxLength={COMMIT_INSTRUCTION_MAX}
        placeholder={placeholder}
        aria-describedby={`${id}-hint`}
        onBlur={(e) => e.target.value.trim() !== value && onSave(e.target.value.trim())}
        onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && !isImeKey(e.nativeEvent) && (e.preventDefault(), e.currentTarget.blur())}
        className="min-h-20 w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:text-base"
        data-testid={`${id}-input`}
      />
    </div>
  );
}
