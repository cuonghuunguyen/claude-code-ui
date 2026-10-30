const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export type FileNameProblem = "empty" | "dots" | "slash" | "control" | "long" | "windowsChars" | "trailingDot" | "reserved";

/** Why `name` cannot be a file or folder name (one segment), undefined when it can. `windows`: the target path is a Windows path. */
export function fileNameProblem(name: string, windows: boolean): FileNameProblem | undefined {
  if (name.trim() === "") return "empty";
  if (name === "." || name === "..") return "dots";
  if (/[/\\]/.test(name)) return "slash";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "control";
  if (new TextEncoder().encode(name).length > 255) return "long";
  if (windows) {
    if (/[<>:"|?*]/.test(name)) return "windowsChars";
    if (/[. ]$/.test(name)) return "trailingDot";
    if (RESERVED.test(name)) return "reserved";
  }
  return undefined;
}

const TEXT: Record<FileNameProblem, string> = {
  empty: "A name is required.",
  dots: "“.” and “..” are not names.",
  slash: "A name cannot contain / or \\.",
  control: "A name cannot contain control characters.",
  long: "The name is too long.",
  windowsChars: 'A name cannot contain < > : " | ? *.',
  trailingDot: "A name cannot end with a dot or a space.",
  reserved: "“{name}” is reserved on Windows.",
};

/** `fileNameProblem` as English text (the daemon's refusal; the web app shows its own translated text). */
export function fileNameError(name: string, windows: boolean): string | undefined {
  const p = fileNameProblem(name, windows);
  return p && TEXT[p].replace("{name}", name.split(".")[0]);
}
