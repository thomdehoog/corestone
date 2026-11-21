// @corestone/ui: the lowest layers of the web client. src/lib holds helpers
// without a user interface of their own; the files next to this one hold the
// controls built on them. Nothing here knows about Corestone's data, the
// server, or ProseMirror (see web/scripts/check-layers.mjs).
export { button, el, type ButtonOptions } from "./lib/dom";
export { dialogHead, Overlay, type Below, type OverlayOptions, type Point } from "./overlay";
export { prefs, type PrefsOptions } from "./lib/prefs";
export { errorText } from "./lib/errors";
export { drag, type DragOptions } from "./lib/drag";
export { deepEqual, fmtSize, fmtTime, relTime } from "./lib/format";
export { dataUrlToBlob } from "./lib/data-url";
export { safeHref } from "./lib/safe-url";
export { iconSet, type IconStyle } from "./lib/icons";
export { LightElement } from "./lib/light-element";
export { buildMenu, DropMenu, popupMenu, type DropMenuOptions, type MenuEntry } from "./menu";
export { Resizer, splitter, type ResizerOptions } from "./resizer";
export { attachTooltips, setTip, tipOf, type Tip, type TooltipOptions } from "./tooltip";
export { tint, type ColorChoices, type Palette, type StripePreset } from "./palette";
export { customColor, recentSwatches, swatch } from "./swatches";
export { section, type SectionBadge, type SectionOptions } from "./section";
export { ButtonBar, type BarItem, type ButtonBarOptions } from "./button-bar";
