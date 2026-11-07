import type { VyomaraDesktopApi } from '../../desktop/contracts.ts';

declare global {
  interface Window {
    readonly vyomara: VyomaraDesktopApi;
  }
}

export {};
