import {
  DEFAULT_POLL,
  GalaxyValidationError,
  runWithEnvelope,
  type GalaxyContext,
} from "@galaxyproject/galaxy-ops/browser";
import { describe, expect, it } from "vitest";

import {
  BATCH,
  compressionLost,
  organizeDatasets,
  organizeDatasetsOp,
  summarize,
} from "./organize-datasets";

type Dataset = Record<string, any>;
interface Call {
  op: "contents" | "bulk" | "collection";
  body: Record<string, any>;
  query?: Record<string, any>;
}

/** What a history item is when it says nothing: shown, and not deleted. */
const ITEM_DEFAULTS: Record<string, unknown> = { visible: true, deleted: false };
const pyStr = (value: unknown) =>
  typeof value === "boolean" ? (value ? "True" : "False") : String(value);

/** Answers the three requests the op makes, filtering contents through q/qv as Galaxy does. */
function fakeContext(contents: Dataset[]) {
  const calls: Call[] = [];
  const ok = (data: unknown) => ({ data, response: { status: 200 } });
  const client = {
    GET: async (path: string, init: any) => {
      expect(path).toBe("/api/histories/{history_id}/contents");
      expect(init.params.path.history_id).toBe("h1");
      const query = init.params.query;
      calls.push({ op: "contents", body: {}, query });
      const wanted = query.q.map((field: string, i: number) => [field, query.qv[i]] as const);
      return ok(
        contents.filter((d) =>
          wanted.every(
            ([f, v]: readonly [string, string]) => pyStr(d[f] ?? ITEM_DEFAULTS[f]) === v,
          ),
        ),
      );
    },
    POST: async (path: string, init: any) => {
      expect(path).toBe("/api/dataset_collections");
      calls.push({ op: "collection", body: init.body });
      return ok({ id: "hdca1", name: init.body.name });
    },
    PUT: async (path: string, init: any) => {
      expect(path).toBe("/api/histories/{history_id}/contents/bulk");
      expect(init.params.path.history_id).toBe("h1");
      calls.push({ op: "bulk", body: init.body });
      return ok({ success_count: (init.body.items || []).length, errors: [] });
    },
  };
  return { ctx: { client, poll: DEFAULT_POLL } as unknown as GalaxyContext, calls };
}

const args = (inputs: Record<string, unknown>) =>
  ({
    historyId: "h1",
    collectionName: "reads",
    structure: "auto",
    include: "*",
    tags: [],
    ...inputs,
  }) as Parameters<typeof organizeDatasets>[0];

async function run(contents: Dataset[], inputs: Record<string, unknown> = {}) {
  const { ctx, calls } = fakeContext(contents);
  const state = await organizeDatasets(args(inputs), ctx);
  return { calls, state };
}

/** A refusal and the requests made before it. */
async function refused(contents: Dataset[], inputs: Record<string, unknown> = {}) {
  const { ctx, calls } = fakeContext(contents);
  const error = await organizeDatasets(args(inputs), ctx).then(
    () => undefined,
    (err: unknown) => err as Error,
  );
  expect(error).toBeInstanceOf(GalaxyValidationError);
  return { calls, message: error!.message };
}

const ops = (calls: Call[]) => calls.map((c) => c.op);
const built = (calls: Call[]) => calls.filter((c) => c.op === "collection").map((c) => c.body);
const bulks = (calls: Call[], operation: string) =>
  calls.filter((c) => c.op === "bulk" && c.body.operation === operation).map((c) => c.body);

const SRA = [1, 2]
  .flatMap((n) => [1, 2].map((m) => [n, m]))
  .map(([n, m], i) => ({
    id: `ds${i}`,
    name: `SRR100${n}_${m}.fastq.gz`,
    history_content_type: "dataset",
  }));
/** Files as they arrive from an unzipped archive: no mate markers. */
const ZIPPED = [3, 4, 5, 6].map((i) => ({
  id: `z${i}`,
  name: `run_${i}.txt`,
  history_content_type: "dataset",
}));

describe("organize_datasets", () => {
  it("makes paired reads a list:paired collection", async () => {
    const body = built((await run(SRA)).calls)[0];
    expect(body.collection_type).toBe("list:paired");
    expect(body.element_identifiers.map((e: any) => e.name)).toEqual(["SRR1001", "SRR1002"]);
  });

  it("makes unzipped files a flat list", async () => {
    const body = built((await run(ZIPPED)).calls)[0];
    expect(body.collection_type).toBe("list");
    expect(body.element_identifiers).toHaveLength(4);
  });

  it("tags the new collection", async () => {
    const [body] = bulks((await run(SRA, { tags: ["sra", "paired"] })).calls, "add_tags");
    expect(body.items).toEqual([{ id: "hdca1", history_content_type: "dataset_collection" }]);
    expect(body.params).toEqual({ type: "add_tags", tags: ["sra", "paired"] });
  });

  it("makes no tag call without tags", async () => {
    expect(bulks((await run(SRA)).calls, "add_tags")).toEqual([]);
  });

  it("only reads the history, writes bulk changes and builds collections", async () => {
    const { calls } = await run(SRA, { tags: ["sra"], datatype: "fastqsanger.gz" });
    expect(new Set(ops(calls))).toEqual(new Set(["contents", "bulk", "collection"]));
    expect(calls[0].query).toEqual({ v: "dev", q: ["visible", "deleted"], qv: ["True", "False"] });
  });

  it("retypes every dataset in one call", async () => {
    const [body] = bulks((await run(SRA, { datatype: "fastqsanger.gz" })).calls, "change_datatype");
    expect(body.params).toEqual({ type: "change_datatype", datatype: "fastqsanger.gz" });
    expect(body.items.map((i: any) => i.id)).toEqual(SRA.map((d) => d.id));
  });

  it("writes nothing without a datatype", async () => {
    expect(ops((await run(SRA)).calls)).not.toContain("bulk");
  });

  it("sets the datatype before building the collection", async () => {
    const order = ops((await run(SRA, { datatype: "fastqsanger.gz" })).calls);
    expect(order.indexOf("bulk")).toBeLessThan(order.indexOf("collection"));
  });
});

const MESSY = [
  ...SRA,
  { id: "half", name: "SRR200099_1.fastq.gz", history_content_type: "dataset" },
  { id: "notes", name: "README.txt", history_content_type: "dataset" },
];

describe("leftovers and scope", () => {
  it("gives leftovers their own collection instead of dropping them", async () => {
    const collections = built((await run(MESSY)).calls);
    expect(collections.map((b) => b.collection_type)).toEqual(["list:paired", "list"]);
    expect(collections[1].element_identifiers.map((e: any) => e.name)).toEqual([
      "README.txt",
      "SRR200099_1.fastq.gz",
    ]);
  });

  it("hides the source datasets of both collections, as Galaxy's builders do", async () => {
    const collections = built((await run(MESSY)).calls);
    expect(collections.map((b) => b.hide_source_items)).toEqual([true, true]);
    expect(collections.map((b) => b.copy_elements)).toEqual([undefined, undefined]);
  });

  it("keeps leftovers out of the datatype write", async () => {
    const [body] = bulks(
      (await run(MESSY, { datatype: "fastqsanger.gz" })).calls,
      "change_datatype",
    );
    expect(body.items.map((i: any) => i.id)).toEqual(SRA.map((d) => d.id));
  });

  it("writes nothing for an empty history", async () => {
    const { calls } = await refused([], { datatype: "fastqsanger.gz", tags: ["sra"] });
    expect(ops(calls)).toEqual(["contents", "contents"]);
  });

  it("points at hidden datasets that would form the collection", async () => {
    const hidden = SRA.map((d) => ({ ...d, visible: false }));
    const { calls, message } = await refused(hidden, { datatype: "fastqsanger.gz" });
    expect(calls.map((c) => c.query!.qv)).toEqual([
      ["True", "False"],
      ["False", "False"],
    ]);
    expect(message).toBe(
      "Nothing was organized: no visible datasets formed a list collection. " +
        `${SRA.length} hidden dataset(s) would form a list:paired collection; they are most ` +
        "likely inside a collection built earlier. Use that collection rather than organizing " +
        "them again.",
    );
  });

  it("leaves hidden datasets out of the error when they would not form the collection", async () => {
    const other = [{ id: "x", name: "notes.txt", extension: "txt", visible: false }];
    const { message } = await refused(other, { include: "*.fastq.gz" });
    expect(message).toBe("Nothing was organized: no visible datasets formed a list collection.");
  });

  it("reports building nothing as a failure, with what did not match", async () => {
    await refused([]);
    const lone = [{ id: "a", name: "sample_A.fastq.gz", extension: "fastqsanger.gz" }];
    const { message } = await refused(lone, { structure: "paired" });
    expect(message).toContain("Unpaired (1): sample_A.fastq.gz.");
  });

  it("batches the datatype write", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({
      id: `d${i}`,
      name: `S${String(Math.floor(i / 2)).padStart(5, "0")}_${(i % 2) + 1}.fastq.gz`,
      history_content_type: "dataset",
    }));
    const writes = bulks(
      (await run(many, { datatype: "fastqsanger.gz" })).calls,
      "change_datatype",
    );
    expect(writes.map((w) => w.items.length)).toEqual([1000, 1000, 500]);
  });

  it("does not treat a collection already in the history as a file", async () => {
    const withCollection = [
      {
        id: "c1",
        name: "reads",
        history_content_type: "dataset_collection",
        collection_type: "list",
        element_count: 4,
      },
      ...SRA,
    ];
    const { calls } = await run(withCollection, { datatype: "fastqsanger.gz" });
    expect(bulks(calls, "change_datatype")[0].items.map((i: any) => i.id)).not.toContain("c1");
    for (const element of built(calls)[0].element_identifiers) {
      for (const inner of element.element_identifiers ?? [element]) {
        expect(inner.id).not.toBe("c1");
      }
    }
  });
});

describe("datatype", () => {
  it("does not retype datasets already at the datatype", async () => {
    const typed = SRA.map((d) => ({ ...d, extension: "fastqsanger.gz" }));
    const { calls, state } = await run(typed, { datatype: "fastqsanger.gz" });
    expect(bulks(calls, "change_datatype")).toEqual([]);
    expect(state.datatype_already_set).toBe(typed.length);
  });

  it("retypes only what needs it in a mixed history", async () => {
    const half = SRA.map((d, n) => (n < 2 ? { ...d, extension: "fastqsanger.gz" } : d));
    const [body] = bulks(
      (await run(half, { datatype: "fastqsanger.gz" })).calls,
      "change_datatype",
    );
    expect(body.items).toHaveLength(SRA.length - 2);
  });

  it("reports only the datasets it retyped as queued", async () => {
    const half = SRA.map((d, n) => (n < 2 ? { ...d, extension: "fastqsanger.gz" } : d));
    const { state } = await run(half, { datatype: "fastqsanger.gz" });
    expect(summarize(state).datatype.queued).toBe(SRA.length - 2);
    expect(state.datatype_already_set).toBe(2);
  });

  it("refuses an uncompressed datatype for gzipped reads before writing", async () => {
    const { calls, message } = await refused(SRA, { datatype: "fastqsanger" });
    expect(message).toBe(
      'Refused: "fastqsanger" would relabel 4 compressed dataset(s) as uncompressed. ' +
        'Use "fastqsanger.gz". Compressed (4): SRR1001_1.fastq.gz, SRR1001_2.fastq.gz, ' +
        "SRR1002_1.fastq.gz, SRR1002_2.fastq.gz.",
    );
    expect(ops(calls)).toEqual(["contents"]);
  });

  it("accepts the compressed datatype itself", async () => {
    expect(ops((await run(SRA, { datatype: "fastqsanger.gz" })).calls)).toContain("collection");
  });

  it("accepts an uncompressed datatype for uncompressed files", async () => {
    expect(ops((await run(ZIPPED, { datatype: "tabular" })).calls)).toContain("collection");
  });

  it("counts Galaxy's detected extension as compressed", () => {
    const detected = [{ id: "d1", name: "reads_1", extension: "fastqsanger.gz" }];
    expect(compressionLost("fastqsanger", detected)).toEqual(["reads_1"]);
    expect(compressionLost("fastqsanger.gz", detected)).toEqual([]);
    expect(compressionLost(undefined, detected)).toEqual([]);
  });
});

/** Galaxy keeps a hidden copy per element of a collection, under the dataset's own name. */
const WITH_HIDDEN = [
  { id: "v1", name: "contigs_A.fasta.gz", history_content_type: "dataset" },
  { id: "v2", name: "contigs_B.fasta.gz", history_content_type: "dataset" },
  { id: "h1", name: "contigs_A.fasta.gz", history_content_type: "dataset", visible: false },
  { id: "h2", name: "contigs_B.fasta.gz", history_content_type: "dataset", visible: false },
  { id: "d1", name: "contigs_C.fasta.gz", history_content_type: "dataset", deleted: true },
];

describe("hidden and deleted items", () => {
  it("does not collect a hidden copy beside the dataset it copies", async () => {
    const body = built((await run(WITH_HIDDEN, { structure: "list" })).calls)[0];
    expect(body.element_identifiers.map((e: any) => e.id)).toEqual(["v1", "v2"]);
  });

  it("leaves a deleted dataset out", async () => {
    const body = built((await run(WITH_HIDDEN, { structure: "list" })).calls)[0];
    expect(body.element_identifiers.map((e: any) => e.id)).not.toContain("d1");
  });

  it("retypes only what the user can see", async () => {
    const [body] = bulks(
      (await run(WITH_HIDDEN, { structure: "list", datatype: "fasta.gz" })).calls,
      "change_datatype",
    );
    expect(body.items.map((i: any) => i.id)).toEqual(["v1", "v2"]);
  });
});

/** `ext` is what Galaxy currently holds, which is not always what the user wants. */
const history = (pairs: number, ext = "fasta.gz") =>
  Array.from({ length: pairs }, (_, i) =>
    [1, 2].map((mate) => ({
      name: `SRR${String(i).padStart(6, "0")}_${mate}.fasta.gz`,
      id: `${i}_${mate}`,
      extension: ext,
      history_content_type: "dataset",
    })),
  ).flat();

const runScale = (pairs: number, inputs: Record<string, unknown>, ext = "fasta.gz") =>
  run(history(pairs, ext), { include: "*", structure: "auto", ...inputs });

describe("scale", () => {
  it("brings every pair to the collection exactly once", async () => {
    const elements = built((await runScale(5000, { datatype: "fasta.gz" })).calls)[0]
      .element_identifiers;
    expect(elements).toHaveLength(5000);
    expect(new Set(elements.map((e: any) => e.name)).size).toBe(5000);
  });

  it("does not rewrite a datatype that is already correct", async () => {
    expect(ops((await runScale(5000, { datatype: "fasta.gz" })).calls)).not.toContain("bulk");
  });

  it("batches datatype changes", async () => {
    const batches = bulks(
      (await runScale(5000, { datatype: "fasta.gz" }, "data")).calls,
      "change_datatype",
    );
    expect(batches).toHaveLength(10000 / BATCH);
    expect(batches.every((b) => b.items.length <= BATCH)).toBe(true);
    expect(batches.reduce((n, b) => n + b.items.length, 0)).toBe(10000);
  });

  it("reads the history once however large it is", async () => {
    expect(
      ops((await runScale(5000, { datatype: "fasta.gz" })).calls).filter((o) => o === "contents"),
    ).toHaveLength(1);
  });

  it("keeps what the model sees from growing with the history", async () => {
    const small = summarize((await runScale(10, { datatype: "fasta.gz" })).state);
    const large = summarize((await runScale(5000, { datatype: "fasta.gz" })).state);
    expect(large.collection.elements).toBe(5000);
    expect(Object.keys(large).sort()).toEqual(Object.keys(small).sort());
    expect(JSON.stringify(large).length).toBeLessThan(2 * JSON.stringify(small).length);
    expect(JSON.stringify(large).length).toBeLessThan(1000);
  });

  it("refuses a datatype that would drop compression before writing anything", async () => {
    const { calls, message } = await refused(history(5000), { datatype: "fasta" });
    expect(message).toContain("Compressed (10000): ");
    expect(message.length).toBeLessThan(1000);
    expect(ops(calls)).toEqual(["contents"]);
  });

  it("tags the collection rather than every dataset", async () => {
    const tagging = bulks(
      (await runScale(2000, { datatype: "fasta.gz", tags: ["sra"] })).calls,
      "add_tags",
    );
    expect(tagging).toHaveLength(1);
    expect(tagging[0].items).toHaveLength(1);
    expect(tagging[0].items[0].history_content_type).toBe("dataset_collection");
  });

  it("builds the collection in one request of bounded size per element", async () => {
    const posts = built((await runScale(5000, { datatype: "fasta.gz" })).calls);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0]).length / posts[0].element_identifiers.length).toBeLessThan(300);
  });

  it("grows requests with batches rather than with datasets", async () => {
    const small = (await runScale(500, { datatype: "fasta.gz" }, "data")).calls;
    const large = (await runScale(5000, { datatype: "fasta.gz" }, "data")).calls;
    expect(large.length - small.length).toBe((10000 - 1000) / BATCH);
  });
});

describe("preview", () => {
  it("reads the history and writes nothing", async () => {
    const { calls } = await run(SRA, { preview: true, datatype: "fastqsanger.gz", tags: ["sra"] });
    expect(ops(calls)).toEqual(["contents"]);
  });

  it("shows the structure, the pairs and what it would retype", async () => {
    const summary = summarize(
      (await run([...SRA, ...ZIPPED.slice(0, 1)], { preview: true, datatype: "fastqsanger.gz" }))
        .state,
    );
    expect(summary).toEqual({
      preview: true,
      written: "nothing; call again without preview to build",
      collection: { type: "list:paired", elements: 2, inferred: true },
      pairs: {
        count: 2,
        examples: [
          { sample: "SRR1001", forward: "SRR1001_1.fastq.gz", reverse: "SRR1001_2.fastq.gz" },
          { sample: "SRR1002", forward: "SRR1002_1.fastq.gz", reverse: "SRR1002_2.fastq.gz" },
        ],
      },
      unpaired: { count: 1, names: ["run_3.txt"] },
      out_of_scope: { count: 0, names: [] },
      datatype: { would_change: 4 },
    });
  });

  it("still refuses a datatype that would drop compression", async () => {
    const { calls } = await refused(SRA, { preview: true, datatype: "fastqsanger" });
    expect(ops(calls)).toEqual(["contents"]);
  });

  it("reports ambiguous pairs in a preview and after building", async () => {
    const extra = { id: "dup", name: "SRR1002_1.fq.gz", history_content_type: "dataset" };
    const preview = summarize((await run([...SRA, extra], { preview: true })).state);
    expect(preview.ambiguity).toEqual({
      duplicate_mates: { count: 1, names: ["SRR1002"] },
      mixed_markers: [],
    });
    const built = summarize((await run([...SRA, extra])).state);
    expect(built.ambiguity.duplicate_mates.names).toEqual(["SRR1002"]);
  });

  it("leaves ambiguity out when there is none", async () => {
    expect(summarize((await run(SRA)).state)).not.toHaveProperty("ambiguity");
  });
});

describe("as a galaxy-ops operation", () => {
  it("is a write op in the collections domain", () => {
    expect(organizeDatasetsOp.readOnly).toBe(false);
    expect(organizeDatasetsOp.domain).toBe("collections");
  });

  it("projects the summary into the envelope's data", async () => {
    const { ctx } = fakeContext(SRA);
    const envelope = await runWithEnvelope(organizeDatasetsOp, args({}) as never, ctx);
    expect(envelope.success).toBe(true);
    expect(envelope.data).toEqual({
      collection: { id: "hdca1", name: "reads", type: "list:paired", elements: 2 },
      unpaired: { id: null, count: 0, names: [] },
      out_of_scope: { count: 0, names: [] },
      datatype: null,
    });
  });

  it("carries a refusal's sentence as the envelope's message", async () => {
    const { ctx } = fakeContext(SRA);
    const envelope = await runWithEnvelope(
      organizeDatasetsOp,
      args({ datatype: "fastqsanger" }) as never,
      ctx,
    );
    expect(envelope.success).toBe(false);
    expect(envelope.message).toMatch(/^Refused: "fastqsanger" would relabel 4 compressed/);
  });

  it("applies its defaults when the caller leaves them out", async () => {
    const { ctx, calls } = fakeContext(SRA);
    await organizeDatasets({ historyId: "h1" } as Parameters<typeof organizeDatasets>[0], ctx);
    const [body] = calls.filter((c) => c.op === "collection").map((c) => c.body);
    expect(body.name).toBe("Collection");
    expect(body.collection_type).toBe("list:paired");
  });
});
