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
    if (isDev()) {
      await seedDevIncoming(container);
    }
    const incoming = parseIncoming(container, hostSearch());
    await MODES[incoming.view].mount(container, incoming);
  }
}

void main();
