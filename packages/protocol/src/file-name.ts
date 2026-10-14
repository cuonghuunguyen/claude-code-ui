const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why `name` cannot be a file or folder name (one segment), undefined when it can. `windows`: the target path is a Windows path. */
export function fileNameError(name: string, windows: boolean): string | undefined {
  if (name.trim() === "") return "A name is required.";
  if (name === "." || name === "..") return "“.” and “..” are not names.";
  if (/[/\\]/.test(name)) return "A name cannot contain / or \\.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "A name cannot contain control characters.";
  if (new TextEncoder().encode(name).length > 255) return "The name is too long.";
  if (windows) {
    if (/[<>:"|?*]/.test(name)) return 'A name cannot contain < > : " | ? *.';
    if (/[. ]$/.test(name)) return "A name cannot end with a dot or a space.";
    if (RESERVED.test(name)) return `“${name.split(".")[0]}” is reserved on Windows.`;
  }
  return undefined;
}
