// Saves a Blob as a file through a temporary link (Settings exports).
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Not in the same tick: the download may still be reading the object.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const downloadText = (name: string, text: string, type = "text/plain"): void => downloadBlob(name, new Blob([text], { type }));
