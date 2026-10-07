import { execFile, spawn, type ChildProcess } from "node:child_process";

type Entry = { ppid: number; name: string };
/** Images that only wrap the daemon (npm, its script shell, tsx, the launcher, a cmd shim); the user's shell or terminal is not one. */
export const WRAPPER = /^(node|bash|sh|cmd)\.exe$/i;
const QUERY = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }';

/** Lines `pid ppid name` (names may hold spaces; CRLF ok). */
export function parseProcessTable(out: string): Map<number, Entry> {
  const t = new Map<number, Entry>();
  for (const line of out.split("\n")) {
    const m = /^(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line.replace(/\r$/, ""));
    if (m) t.set(Number(m[1]), { ppid: Number(m[2]), name: m[3]! });
  }
  return t;
}

/** The contiguous wrapper ancestors above `pid`, nearest first. */
export function wrapperChain(table: Map<number, Entry>, pid: number) {
  const chain: { pid: number; name: string }[] = [];
  const seen = new Set([pid]);
  for (let p = table.get(pid)?.ppid; p && !seen.has(p); p = table.get(p)?.ppid) {
    const e = table.get(p);
    if (!e || !WRAPPER.test(e.name)) break;
    seen.add(p);
    chain.push({ pid: p, name: e.name });
  }
  return chain;
}

export function readProcessTable(): Promise<Map<number, Entry>> {
  return new Promise((resolve, reject) =>
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", QUERY], { windowsHide: true, timeout: 15_000, maxBuffer: 1 << 24 }, (err, stdout) => (err ? reject(err) : resolve(parseProcessTable(stdout)))),
  );
}

/**
 * One hidden powershell that opens a handle of every chain process (a held handle: no pid reuse) and of the daemon itself, blocks in WaitAny
 * (no polling, no CPU) and prints `GONE <pid>` for the first one that ended. Pids are validated integers; nothing else is interpolated.
 * process.kill(pid, 0) is no test on Windows: it still succeeds for an ended process whose handle another process holds.
 */
const script = (pids: number[], self: number) => `
$hs = @(); $ids = @()
foreach ($i in @(${pids.join(",")}, ${self})) {
  try { $p = [System.Diagnostics.Process]::GetProcessById($i) } catch [System.ArgumentException] { [Console]::Out.WriteLine("GONE $i"); [Console]::Out.Flush(); continue } catch { [Console]::Out.WriteLine("SKIP $i $($_.Exception.Message)"); [Console]::Out.Flush(); continue }
  try { $h = New-Object System.Threading.ManualResetEvent($false); $h.SafeWaitHandle = New-Object Microsoft.Win32.SafeHandles.SafeWaitHandle($p.Handle, $false); $hs += $h; $ids += $i } catch { [Console]::Out.WriteLine("SKIP $i $($_.Exception.Message)"); [Console]::Out.Flush() }
}
if ($hs.Count -gt 0) { $n = [System.Threading.WaitHandle]::WaitAny($hs); [Console]::Out.WriteLine("GONE $($ids[$n])"); [Console]::Out.Flush() }
`;

type Child = Pick<ChildProcess, "stdout" | "on" | "kill">;
/**
 * Calls `onGone` once when a chain process ends. A watcher that fails to start, exits without a `GONE <chain pid>` line or prints anything else
 * is only logged: it never stops the daemon. Returns the watcher's kill.
 */
export function watchChain(
  chain: { pid: number; name: string }[],
  onGone: (a: { pid: number; name: string }) => void,
  opts: { self?: number; log?: (line: string) => void; spawn?: (script: string) => Child } = {},
) {
  if (!chain.length) return undefined;
  const log = opts.log ?? (() => {});
  const spawnWatcher = opts.spawn ?? ((sc) => spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", sc], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }));
  let child: Child;
  try {
    child = spawnWatcher(script(chain.map((a) => a.pid), opts.self ?? process.pid));
  } catch (e) {
    log(`claude-ui daemon: parent watch not started: ${(e as Error).message}`);
    return undefined;
  }
  let out = "", fired = false;
  child.stdout?.on("data", (d) => {
    out += d;
    for (const m of out.matchAll(/^GONE (\d+)\r?\n/gm)) {
      const a = chain.find((c) => c.pid === Number(m[1]));
      if (a && !fired) (fired = true, onGone(a));
    }
    for (const m of out.matchAll(/^SKIP (.+)\r?\n/gm)) log(`claude-ui daemon: parent watch skips pid ${m[1]}`);
    out = out.slice(out.lastIndexOf("\n") + 1);
  });
  child.on("error", (e: Error) => log(`claude-ui daemon: parent watch failed: ${e.message}`));
  child.on("exit", () => !fired && log("claude-ui daemon: parent watch ended without a result; not watching"));
  return () => child.kill();
}
