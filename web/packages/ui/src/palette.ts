/** A colour palette, e.g. from company design guidelines. */
export interface Palette {
  /** Font colours. */
  colors: string[];
  /** Background (marker) colours, in the same order: a light tint of each font colour, so the
   *  same swatch gives dark ink on a light marker; a light font colour (white) gets a dark marker.
   *  No marker should equal a font colour, or text can be made unreadable (blacked out).
   *  Missing ones are derived from the font colours. */
  backgrounds?: string[];
  names?: string[];
  /** false: only palette colours, no picker and no history. */
  allowCustom?: boolean;
  /** The colour pairs offered for striped tables (first and second stripe). */
  stripes?: StripePreset[];
}

export interface StripePreset { name: string; colors: [string, string] }

/** The colours a dialog offers: the marker swatches, the picker and history when the
 *  palette allows them, and the stripe presets. */
export interface ColorChoices {
  swatches: string[];
  custom: boolean;
  recent(): string[];
  addRecent(v: string): void;
  presets: StripePreset[];
}

/** The marker for a font colour (#rrggbb): a light tint (three quarters white), or for a light
 *  colour a dark shade (three fifths black), so the ink stays readable on it. */
export function tint(c: string): string {
  const n = parseInt(c.slice(1), 16);
  const rgb = [n >> 16, (n >> 8) & 255, n & 255];
  const light = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.8;
  const mix = (v: number) => Math.round(light ? v * 0.4 : v + (255 - v) * 0.75).toString(16).padStart(2, "0");
  return "#" + rgb.map(mix).join("");
}
