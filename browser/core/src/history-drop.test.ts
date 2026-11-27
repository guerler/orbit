import { describe, expect, it } from "vitest";
import { droppedItems, itemReference, withReferences } from "./history-drop";

const reads = {
  id: "f2db41e1fa331b3e",
  hid: 12,
  name: "reads.fastq",
  history_content_type: "dataset",
};
const pairs = {
  id: "a1b2c3d4e5f60718",
  hid: 13,
  name: "pairs",
  history_content_type: "dataset_collection",
};
const element = {
  id: "0a1b2c3d4e5f6071",
  element_identifier: "forward",
  object: { id: "1b2c3d4e5f607182", model_class: "HistoryDatasetAssociation" },
};

describe("history items dropped on the input", () => {
  it("reads a dataset, a collection and a dataset inside a collection", () => {
    expect(droppedItems(JSON.stringify([reads]))).toEqual([
      { id: reads.id, kind: "dataset", hid: 12, name: "reads.fastq" },
    ]);
    expect(droppedItems(JSON.stringify([pairs]))).toEqual([
      { id: pairs.id, kind: "collection", hid: 13, name: "pairs" },
    ]);
    expect(droppedItems(JSON.stringify([element]))).toEqual([
      { id: element.object.id, kind: "dataset", name: "forward" },
    ]);
  });

  it("reads several selected items", () => {
    const selected = JSON.stringify([{ [reads.id]: reads, [pairs.id]: pairs }]);
    expect(droppedItems(selected)!.map((item) => item.id)).toEqual([reads.id, pairs.id]);
  });

  it("ignores text that is not a history item", () => {
    expect(droppedItems("plain text")).toBeUndefined();
    expect(droppedItems("null")).toBeUndefined();
    expect(droppedItems(JSON.stringify([{ id: "s1", name: "step" }]))).toEqual([]);
    const subcollection = { id: "e1", object: { id: "c1", model_class: "DatasetCollection" } };
    expect(droppedItems(JSON.stringify([subcollection]))).toEqual([]);
  });

  it("writes each as a reference with its id", () => {
    expect(itemReference({ id: "f2", kind: "dataset", hid: 12, name: "reads.fastq" })).toBe(
      '[dataset #12 "reads.fastq", id f2]',
    );
    expect(itemReference({ id: "x", kind: "collection" })).toBe("[collection, id x]");
  });

  it("writes the references at the selection, spaced from the text around them", () => {
    expect(withReferences("Count in please", 8, 8, ["[a]", "[b]"])).toEqual({
      value: "Count in [a] [b] please",
      caret: 16,
    });
    expect(withReferences("", 0, 0, ["[a]"])).toEqual({ value: "[a]", caret: 3 });
  });
});
