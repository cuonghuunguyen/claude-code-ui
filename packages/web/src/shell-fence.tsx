// A shell code fence with a "Run in terminal" button: the command goes to the project's terminal and runs there.
import { CheckIcon, CopyIcon, PlayIcon } from "lucide-react";
import { createContext, use, useRef, useState } from "react";
import { CodeBlock, CodeBlockActions, CodeBlockHeader, CodeBlockTitle } from "@/components/ai-elements/code-block";
import { useT } from "./i18n.ts";
import { tipRunInTerminal } from "./recommendations.ts";
import { ringLocate } from "./locate.ts";

/** Runs a command in the project's terminal; set by the App. Without it a shell fence has no button. */
export const RunInTerminalContext = createContext<((command: string) => void) | undefined>(undefined);

export const SHELL_LANGUAGES = ["bash", "sh", "shell", "zsh", "shellscript", "console"];

const btn = "inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11";

/** The Streamdown renderer of the shell fence languages. */
export function ShellFence({ code, language, isIncomplete }: { code: string; language: string; isIncomplete: boolean }) {
  const tr = useT();
  const run = use(RunInTerminalContext);
  const [copied, setCopied] = useState(false);
  const runBtn = useRef<HTMLButtonElement>(null);
  const command = code.replace(/\s+$/, "");
  return (
    <CodeBlock code={code} language={language as never} data-testid="shell-fence">
      <CodeBlockHeader>
        <CodeBlockTitle className="font-mono">{language}</CodeBlockTitle>
        <CodeBlockActions>
          <button
            type="button"
            className={btn}
            data-testid="shell-copy"
            onClick={() => {
              void navigator.clipboard?.writeText(code).then(() => (setCopied(true), setTimeout(() => setCopied(false), 2000)));
              // GH-1015: the copy above is not held up by the recommendation.
              tipRunInTerminal(!!run && !isIncomplete && !!command, () => runBtn.current?.isConnected && (ringLocate(runBtn.current), runBtn.current.focus({ preventScroll: true })));
            }}
          >
            {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            {tr("session.shell.copy")}
          </button>
          {run && (
            <button ref={runBtn} type="button" className={btn} data-testid="shell-run" disabled={isIncomplete || !command} onClick={() => run(command)}>
              <PlayIcon size={12} />
              {tr("session.shell.run")}
            </button>
          )}
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}
