/** Galaxy history items dropped on the input, read as Galaxy's IGV plugin reads them. */

export interface DroppedItem {
  id: string;
  kind: "dataset" | "collection";
  hid?: number;
  name?: string;
}

function itemOf(entry: any): DroppedItem | undefined {
  let item: DroppedItem | undefined;
  if (entry?.object?.model_class === "HistoryDatasetAssociation" && entry.element_identifier) {
    item = { id: entry.object.id, kind: "dataset", name: entry.element_identifier };
  } else if (
    entry?.history_content_type === "dataset" ||
    entry?.history_content_type === "dataset_collection"
  ) {
    const kind = entry.history_content_type === "dataset" ? "dataset" : "collection";
    item = { id: entry.id, kind, hid: entry.hid, name: entry.name };
  }
  return typeof item?.id === "string" ? item : undefined;
}

/**
 * The history items a drop carries: one item, or several selected ones keyed by id. Undefined
 * when the text is not Galaxy's drag payload at all.
 */
export function droppedItems(text: string): DroppedItem[] | undefined {
  let payload: any;
  try {
    payload = JSON.parse(text)?.[0];
  } catch {
    payload = undefined;
  }
  let items: DroppedItem[] | undefined;
  if (payload && typeof payload === "object") {
    const entries = payload.id ? [payload] : Object.values(payload);
    items = entries.map(itemOf).filter((item): item is DroppedItem => item !== undefined);
  }
  return items;
}

/** How a dropped item is written into the question. */
export function itemReference(item: DroppedItem): string {
  const label = [item.hid === undefined ? "" : `#${item.hid}`, item.name ? `"${item.name}"` : ""]
    .filter(Boolean)
    .join(" ");
  return `[${item.kind}${label ? ` ${label}` : ""}, id ${item.id}]`;
}

/** The input with `references` written at its selection, spaced from the text around it. */
export function withReferences(
  value: string,
  start: number,
  end: number,
  references: readonly string[],
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  const inserted = prefix + references.join(" ") + suffix;
  return {
    value: before + inserted + after,
    caret: before.length + inserted.length - suffix.length,
  };
}
