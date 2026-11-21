/**
 * How much to scale the interface for the window's size and the screen it is
 * on. The layout is designed for a laptop-sized window (about 1360×860
 * points). On a large external monitor everything grows in proportion
 * (text, controls, the orb) instead of leaving a small app floating in empty
 * space. On the laptop screen it stays at 1×, and the CSS breakpoints handle
 * windows smaller than the design size. Pure, so it can be tested.
 */
export interface Size { readonly width: number; readonly height: number }

const DESIGN: Size = { width: 1360, height: 860 };
/** A screen this large (in points) is a laptop screen: no extra scaling. */
const LAPTOP_SCREEN: Size = { width: 1440, height: 900 };
export const MIN_UI_ZOOM = 1;
export const MAX_UI_ZOOM = 1.75;

export function uiZoomFor(content: Size, screenWorkArea: Size): number {
  const forWindow = Math.min(content.width / DESIGN.width, content.height / DESIGN.height);
  const forScreen = Math.min(screenWorkArea.width / LAPTOP_SCREEN.width, screenWorkArea.height / LAPTOP_SCREEN.height);
  const zoom = Math.min(forWindow, forScreen);
  if (!Number.isFinite(zoom)) return MIN_UI_ZOOM;
  // Steps of 0.05 so small moves do not cause constant re-layout.
  return Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, Math.floor(zoom * 20) / 20));
}
