// Name and icon of a project or a machine (GH-515, docs/spec.md "Settings" › labels): name, none / emoji / image icon, the image cropped to a square.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { LABEL_EMOJI_MAX, LABEL_ICON_MAX, LABEL_ICON_PX, LABEL_NAME_MAX, type Label } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trapTab } from "./focus-trap.ts";
import { useT } from "./i18n.ts";
import { clampPan, rezoom, scaleOf, sourceRect } from "./icon-crop.ts";
import { LabelIcon } from "./label-icon.tsx";
import { iconSrc } from "./labels.ts";

const INPUT = "h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11";
const VIEW = 192;
const MAX_FILE = 10 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
type Mode = "none" | "emoji" | "image";
type Pic = { img: HTMLImageElement; url: string; w: number; h: number; zoom: number; ox: number; oy: number };

type Props = {
  open: boolean;
  title: string;
  /** Placeholder of the name: the folder name or the machine's own name. */
  fallbackName: string;
  label?: Label;
  /** `undefined` = Reset. Rejects with the daemon's message, shown in the dialog. */
  onSave: (label: Label | undefined) => Promise<void>;
  onClose: () => void;
};

export function LabelDialog(p: Props) {
  return (
    <Dialog.Root open={p.open} onOpenChange={(o) => !o && p.onClose()}>
      {p.open && <Body {...p} />}
    </Dialog.Root>
  );
}

function Body({ title, fallbackName, label, onSave, onClose }: Props) {
  const t = useT();
  const kept = iconSrc(label?.icon);
  const [name, setName] = useState(label?.name ?? "");
  const [mode, setMode] = useState<Mode>(!label?.icon ? "none" : kept ? "image" : "emoji");
  const [emoji, setEmoji] = useState(label?.icon && !kept ? label.icon : "");
  const [pic, setPic] = useState<Pic>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => () => (pic ? URL.revokeObjectURL(pic.url) : undefined), [pic?.url]);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | undefined>(undefined);

  function choose(file: File | undefined) {
    if (!file) return;
    if (!TYPES.includes(file.type)) return setError(t("label.errType"));
    if (file.size > MAX_FILE) return setError(t("label.errSize"));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setError("");
      setPic({ img, url, w: img.naturalWidth, h: img.naturalHeight, zoom: 1, ...clampPan(img.naturalWidth, img.naturalHeight, VIEW, 1, (VIEW - img.naturalWidth * scaleOf(img.naturalWidth, img.naturalHeight, VIEW, 1)) / 2, (VIEW - img.naturalHeight * scaleOf(img.naturalWidth, img.naturalHeight, VIEW, 1)) / 2) });
    };
    img.onerror = () => (URL.revokeObjectURL(url), setError(t("label.errDecode")));
    img.src = url;
  }
  const pan = (ox: number, oy: number) => setPic((c) => c && { ...c, ...clampPan(c.w, c.h, VIEW, c.zoom, ox, oy) });
  const zoom = (z: number) => setPic((c) => c && { ...c, zoom: z, ...rezoom(c.w, c.h, VIEW, c.zoom, c.ox, c.oy, z) });
  const down = (e: PointerEvent) => {
    if (!pic) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: pic.ox, oy: pic.oy };
  };
  const move = (e: PointerEvent) => drag.current && pan(drag.current.ox + e.clientX - drag.current.x, drag.current.oy + e.clientY - drag.current.y);
  const key = (e: KeyboardEvent) => {
    const d = { ArrowLeft: [8, 0], ArrowRight: [-8, 0], ArrowUp: [0, 8], ArrowDown: [0, -8] }[e.key];
    if (!d || !pic) return;
    e.preventDefault();
    pan(pic.ox + d[0]!, pic.oy + d[1]!);
  };

  /** The icon to save: undefined = none. */
  function icon(): string | undefined {
    if (mode === "emoji") return emoji.trim() || undefined;
    if (mode !== "image") return undefined;
    if (!pic) return kept;
    const c = document.createElement("canvas");
    c.width = c.height = LABEL_ICON_PX;
    const { sx, sy, size } = sourceRect(pic.w, pic.h, VIEW, pic.zoom, pic.ox, pic.oy);
    c.getContext("2d")!.drawImage(pic.img, sx, sy, size, size, 0, 0, LABEL_ICON_PX, LABEL_ICON_PX);
    // A browser without WebP encoding answers PNG, which the daemon accepts too.
    const url = [0.85, 0.6].map((q) => c.toDataURL("image/webp", q)).find((u) => u.length <= LABEL_ICON_MAX);
    if (!url) throw new Error(t("label.errBig"));
    return url;
  }
  async function save(l?: () => Label | undefined) {
    setBusy(true);
    try {
      const v = l?.();
      await onSave(v && (v.name || v.icon) ? v : undefined);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const reset = () => void save();
  const submit = () => void save(() => ({ name: name.trim() || undefined, icon: icon() }));
  const preview = mode === "emoji" ? emoji.trim() : mode === "image" ? (pic ? undefined : kept) : undefined;

  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay" />
      <Dialog.Popup
        onKeyDown={trapTab}
        className="-translate-x-1/2 fixed top-[max(48px,calc((100dvh-560px)/2))] left-1/2 z-50 flex max-h-[min(100dvh-96px,640px)] w-[min(100vw-24px,420px)] flex-col rounded-2xl border bg-card text-foreground shadow-floating outline-none max-sm:top-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-screen max-sm:rounded-none"
        data-testid="label-dialog"
        aria-modal="true"
      >
        <div className="px-4 pt-4 pb-2">
          <Dialog.Title className="font-medium text-[15px] tracking-[-0.13px]">{title}</Dialog.Title>
        </div>
        <form
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-2"
          onSubmit={(e) => (e.preventDefault(), !busy && submit())}
        >
          <label className="flex flex-col gap-1 text-sm">
            {t("label.name")}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={fallbackName} maxLength={LABEL_NAME_MAX} autoFocus className={INPUT} data-testid="label-name" />
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="pb-1 text-sm">{t("label.icon")}</legend>
            <div role="radiogroup" aria-label={t("label.icon")} className="flex gap-1">
              {(["none", "emoji", "image"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => (setMode(m), setError(""))}
                  className={cn("h-8 flex-1 rounded-md border px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11", mode === m ? "bg-accent font-medium" : "hover:bg-accent")}
                  data-testid={`label-icon-${m}`}
                >
                  {t(`label.${m}`)}
                </button>
              ))}
            </div>
            {mode === "emoji" && (
              <div className="flex items-center gap-2">
                <input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder={t("label.emojiPlaceholder")} aria-label={t("label.emoji")} maxLength={LABEL_EMOJI_MAX} className={INPUT} data-testid="label-emoji" />
                {preview && <LabelIcon icon={preview} className="size-8 text-2xl" />}
              </div>
            )}
            {mode === "image" && (
              <div className="flex flex-col gap-2">
                <input type="file" accept={TYPES.join(",")} aria-label={t("label.choose")} onChange={(e) => (choose(e.target.files?.[0]), (e.target.value = ""))} className="max-w-full text-sm max-md:min-h-11" data-testid="label-file" />
                {!pic && kept && <LabelIcon icon={kept} className="size-16" />}
                {pic && (
                  <>
                    <div
                      tabIndex={0}
                      role="group"
                      aria-label={t("label.cropAria")}
                      onPointerDown={down}
                      onPointerMove={move}
                      onPointerUp={() => (drag.current = undefined)}
                      onPointerCancel={() => (drag.current = undefined)}
                      onKeyDown={key}
                      onWheel={(e) => zoom(Math.min(4, Math.max(1, pic.zoom - e.deltaY / 500)))}
                      style={{ width: VIEW, height: VIEW, touchAction: "none" }}
                      className="relative mx-auto cursor-grab overflow-hidden rounded-md border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid="label-crop"
                    >
                      <img
                        alt=""
                        src={pic.url}
                        draggable={false}
                        className="pointer-events-none absolute top-0 left-0 max-w-none select-none"
                        style={{ width: pic.w * scaleOf(pic.w, pic.h, VIEW, pic.zoom), height: pic.h * scaleOf(pic.w, pic.h, VIEW, pic.zoom), transform: `translate(${pic.ox}px, ${pic.oy}px)` }}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      {t("label.zoom")}
                      <input type="range" min={1} max={4} step={0.05} value={pic.zoom} onChange={(e) => zoom(Number(e.target.value))} className="min-w-0 flex-1 max-md:h-11" data-testid="label-zoom" />
                    </label>
                    <p className="text-muted-foreground text-xs">{t("label.cropHint")}</p>
                  </>
                )}
              </div>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="text-destructive text-sm" data-testid="label-error">
              {error}
            </p>
          )}
        </form>
        <div className="flex flex-wrap justify-between gap-2 border-t px-4 py-3">
          <Button variant="ghost" type="button" disabled={busy || !label} onClick={reset} className="max-md:h-11" data-testid="label-reset">
            {t("label.reset")}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" type="button" onClick={onClose} className="max-md:h-11" data-testid="label-cancel">
              {t("label.cancel")}
            </Button>
            <Button type="button" disabled={busy} onClick={submit} className="max-md:h-11" data-testid="label-save">
              {t("label.save")}
            </Button>
          </div>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  );
}
