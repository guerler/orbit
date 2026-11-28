/** Olit: Orbit's browser shell as a Galaxy visualization plugin, or as Galaxy's AI chat. */
import { CHAT_VIEW, hostSearch, parseIncoming, VISUALIZATION_VIEW, type View } from "./incoming";
import { isDev } from "./launch";
import { chatMode } from "./modes/chat";
import type { OlitMode } from "./modes/mode";
import { visualizationMode } from "./modes/visualization";

const MODES: Record<View, OlitMode> = {
  [VISUALIZATION_VIEW]: visualizationMode,
  [CHAT_VIEW]: chatMode,
};

/** Dev-only: synthesize data-incoming from the plugin XML (no framework host). */
async function seedDevIncoming(container: HTMLElement): Promise<void> {
  const { parseXML } = await import("galaxy-charts-xml-parser");
  const pageUrl = new URL(window.location.href);
  container.dataset.incoming = JSON.stringify({
    root: "/",
    visualization_config: {
      dataset_id: pageUrl.searchParams.get("dataset_id") || undefined,
      settings: {},
    },
    visualization_plugin: await parseXML("olit.xml"),
  });
}

async function main() {
  const scriptUrl = new URL(import.meta.url);
  const containerId = scriptUrl.searchParams.get("container") || "app";
  const container = document.getElementById(containerId);
  // Mount only on an element that has data-incoming, as Galaxy provides for plugins.
  if (container && (isDev() || container.dataset.incoming !== undefined)) {
    // Spelled out so a build drops the seeding and the XML parser it loads.
    if (import.meta.env.DEV && isDev()) {
      await seedDevIncoming(container);
    }
    const incoming = parseIncoming(container, hostSearch());
    await MODES[incoming.view].mount(container, incoming);
  }
}

const TAG = "olit-plugin";

class OlitPlugin extends HTMLElement {
  private ended: AbortController | undefined;
  private leaving: ReturnType<typeof setTimeout> | undefined;
  private moving = false;
  private scrolled = new Map<Element, number>();
  private focused: HTMLElement | undefined;
  private sized: ResizeObserver | undefined;

  connectedCallback() {
    clearTimeout(this.leaving);
    if (this.ended) {
      this.restore();
    } else {
      this.start();
    }
  }

  disconnectedCallback() {
    this.moving = true;
    this.leaving = setTimeout(() => {
      if (!this.isConnected) this.end();
    });
  }

  private start() {
    const ended = new AbortController();
    const { signal } = ended;
    this.ended = ended;
    this.moving = false;
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    root.addEventListener(
      "scroll",
      (e) => {
        const target = e.target as Element;
        if (!this.moving) this.scrolled.set(target, target.scrollTop);
      },
      { capture: true, passive: true, signal },
    );
    root.addEventListener("focusin", (e) => (this.focused = e.target as HTMLElement), { signal });
    const container = document.createElement("div");
    container.id = "app";
    root.replaceChildren(container);
    const incoming = parseIncoming(this, window.location.search);
    MODES[incoming.view]
      .mount(container, incoming, { element: this, signal })
      .catch((e) => console.error("[olit] could not start", e));
  }

  private end() {
    this.ended?.abort();
    this.ended = undefined;
    this.sized?.disconnect();
    this.shadowRoot?.replaceChildren();
    this.scrolled.clear();
    this.focused = undefined;
  }

  private restore() {
    this.sized?.disconnect();
    this.sized = new ResizeObserver(() => {
      if (this.offsetHeight > 0) {
        this.sized?.disconnect();
        for (const [element, top] of this.scrolled) {
          if (element.isConnected) element.scrollTop = top;
        }
        this.moving = false;
      }
    });
    this.sized.observe(this);
    const unfocused = document.activeElement === document.body || document.activeElement === null;
    if (unfocused && this.focused?.isConnected) this.focused.focus({ preventScroll: true });
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, OlitPlugin);

void main();
