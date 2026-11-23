// The theme background (docs/spec.md "Addon themes and CSS" › Background): `<div data-part="backdrop">` fixed behind the app, only while the current addon theme has an image whose file exists for the current mode.
// The image, the veil and the panel alpha come from custom properties of the theme's colour rule (themes.ts `addonBackground`); index.css (host layer) draws it.
import { useContext, useLayoutEffect, useMemo } from "react";
import { AddonsContext, enabledAddons } from "./addons.ts";
import { useColorTheme, useDark } from "./theme.ts";
import { addonThemes, backgroundOf } from "./themes.ts";

export function Backdrop() {
  const addons = useContext(AddonsContext).addons;
  const id = useColorTheme();
  const dark = useDark();
  const list = useMemo(() => (id.startsWith("addon:") ? addonThemes(enabledAddons(addons)) : []), [addons, id]);
  const shown = !!backgroundOf(list.find((t) => t.id === id), dark ? "dark" : "light");
  // data-backdrop on <html> switches the panels to --panel-alpha (index.css); it is set exactly while the element is there.
  useLayoutEffect(() => {
    if (!shown) return;
    document.documentElement.setAttribute("data-backdrop", "");
    return () => document.documentElement.removeAttribute("data-backdrop");
  }, [shown]);
  return shown ? <div data-part="backdrop" aria-hidden="true" /> : null;
}
