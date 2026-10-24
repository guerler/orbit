import type { OlitIncoming } from "../incoming";

/** Choose Olit mode by the view Galaxy passes in. */
export interface OlitMode {
  mount(container: HTMLElement, incoming: OlitIncoming): Promise<void>;
}
