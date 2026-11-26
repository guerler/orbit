import { z } from "zod";
import {
  GalaxyValidationError,
  httpError,
  runOperation,
  type GalaxyContext,
  type InputOf,
  type Operation,
} from "@galaxyproject/galaxy-ops/browser";
import { chunkItems, groupDatasets, type Grouping } from "./dataset-grouping";

export const BATCH = 1000;
const NAME_SAMPLE = 10;

type Dataset = Record<string, any>;
type Built = Record<string, any>;

const input = {
  historyId: z.string(),
  name: z.string().default("Collection"),
  datasetIds: z
    .array(z.string())
    .optional()
    .describe(
      "The visible datasets to build from, by id, as a selection in Galaxy's collection " +
        "builders. Without it, every visible dataset matching `include` is considered.",
    ),
  include: z.string().default("*"),
  collectionType: z
    .string()
    .default("auto")
    .describe(
      '"auto" pairs on evidence, "list:paired" (or "paired") forces pairing, "list" forces a ' +
        "flat list.",
    ),
  datatype: z
    .string()
    .optional()
    .describe(
      "Galaxy's datatype for these files, e.g. 'fastqsanger.gz'. A compressed file keeps " +
        "the compression in its datatype, so gzipped reads are 'fastqsanger.gz' and never " +
        "'fastqsanger'; setting the uncompressed name is refused.",
    ),
  tags: z.array(z.string()).optional(),
  preview: z
    .boolean()
    .default(false)
    .describe(
      "Report the collection type, pairs, unpaired files and ambiguities it would build, and " +
        "write nothing.",
    ),
  sampleRegex: z
    .string()
    .optional()
    .describe(
      "Optional regex over each archive path naming a `sample` group and an optional " +
        "`mate` group, e.g. '(?P<sample>[^/]+)/part(?P<mate>[12])'. Use it when the file " +
        "names follow a convention this tool did not infer; read a few names first.",
    ),
};

type In = {
  historyId: string;
  name?: string | null;
  datasetIds?: string[] | null;
  include?: string | null;
  collectionType?: string | null;
  datatype?: string | null;
  tags?: string[] | null;
  preview?: boolean | null;
  sampleRegex?: string | null;
};

/** Names Galaxy already stores compressed that this datatype would relabel plain. */
export function compressionLost(
  datatype: string | null | undefined,
  datasets: Dataset[],
): string[] {
  if (!datatype || [".gz", ".bz2", ".zip"].some((ext) => datatype.endsWith(ext))) {
    return [];
  }
  const names = datasets
    .filter(
      (d) => String(d.extension || "").endsWith(".gz") || String(d.name || "").endsWith(".gz"),
    )
    .map((d) => String(d.name || d.id));
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function contents(ctx: GalaxyContext, historyId: string, visible: "True" | "False") {
  // This endpoint filters through q/qv; a plain `visible` or `deleted` is ignored.
  const { data, error, response } = await ctx.client.GET("/api/histories/{history_id}/contents", {
    params: {
      path: { history_id: historyId },
      query: { v: "dev", q: ["visible", "deleted"], qv: [visible, "False"] } as never,
    },
  });
  if (error || !data) throw httpError(response, error);
  return data as unknown as Dataset[];
}

async function bulk(
  ctx: GalaxyContext,
  historyId: string,
  operation: string,
  items: unknown[],
  params: unknown,
) {
  const { data, error, response } = await ctx.client.PUT(
    "/api/histories/{history_id}/contents/bulk",
    {
      params: { path: { history_id: historyId } },
      body: { operation, items, params } as never,
    },
  );
  if (error || !data) throw httpError(response, error);
  return data;
}

async function collection(
  ctx: GalaxyContext,
  historyId: string,
  name: string,
  collectionType: string,
  elements: unknown[],
) {
  const { data, error, response } = await ctx.client.POST("/api/dataset_collections", {
    body: {
      history_id: historyId,
      name,
      type: "dataset_collection",
      collection_type: collectionType,
      element_identifiers: elements,
      hide_source_items: true,
    } as never,
  });
  if (error || !data) throw httpError(response, error);
  return data as unknown as Dataset;
}

const listed = (label: string, names: string[]) =>
  names.length
    ? ` ${label} (${names.length}): ${names.slice(0, NAME_SAMPLE).join(", ")}` +
      `${names.length > NAME_SAMPLE ? ", ..." : ""}.`
    : "";

async function run(i: In, ctx: GalaxyContext): Promise<Built> {
  const historyId = i.historyId;
  const structure = i.collectionType ?? "auto";
  const include = i.include ?? "*";
  const datatype = i.datatype ?? undefined;
  const sampleRegex = i.sampleRegex ?? undefined;
  const ids = i.datasetIds?.length ? new Set(i.datasetIds) : null;
  const selected = (datasets: Dataset[]) =>
    ids ? datasets.filter((d) => ids.has(d.id)) : datasets;

  const visible = selected(await contents(ctx, historyId, "True"));
  if (ids) {
    const found = new Set(visible.map((d) => d.id));
    const missing = [...ids].filter((id) => !found.has(id));
    if (missing.length) {
      throw new GalaxyValidationError(
        "dataset_ids holds ids that are not visible items of this history." +
          listed("Not found", missing),
      );
    }
  }
  const grouping = groupDatasets({ datasets: visible, structure, include, sampleRegex });
  if (grouping.empty) {
    const hidden = groupDatasets({
      datasets: selected(await contents(ctx, historyId, "False")),
      structure,
      include,
      sampleRegex,
    });
    const elsewhere = hidden.empty
      ? ""
      : ` ${hidden.items.length} hidden dataset(s) would form a ${hidden.structure} ` +
        "collection; they are most likely inside a collection built earlier. Use that " +
        "collection rather than building it again.";
    throw new GalaxyValidationError(
      `No collection was built: no visible datasets formed a ${grouping.structure} collection.` +
        elsewhere +
        listed("Unpaired", grouping.unmatched) +
        listed("Out of scope", grouping.out_of_scope),
    );
  }

  const wanted = new Set(grouping.items.map((item) => item.id));
  const compressed = compressionLost(
    datatype,
    visible.filter((d) => wanted.has(d.id)),
  );
  if (compressed.length) {
    throw new GalaxyValidationError(
      `Refused: ${JSON.stringify(datatype)} would relabel ${compressed.length} compressed ` +
        `dataset(s) as uncompressed. Use ${JSON.stringify(`${datatype}.gz`)}.` +
        listed("Compressed", compressed),
    );
  }

  // Galaxy detects the datatype on upload, so most of these are usually already right.
  const already = new Set(visible.filter((d) => d.extension === datatype).map((d) => d.id));
  const pending = datatype ? grouping.items.filter((item) => !already.has(item.id)) : [];
  if (i.preview) {
    return {
      grouping,
      preview: true,
      datatype: datatype ?? null,
      datatype_pending: pending.length,
    };
  }
  if (datatype) {
    for (const batch of chunkItems(pending, BATCH)) {
      await bulk(ctx, historyId, "change_datatype", batch, {
        type: "change_datatype",
        datatype,
      });
    }
  }

  // As Galaxy's builders do, datasets left out of the collection stay where they are.
  const built = await collection(
    ctx,
    historyId,
    i.name ?? "Collection",
    grouping.structure,
    grouping.elements,
  );

  // Tags belong to the collection, which the per-dataset route cannot address.
  if (i.tags?.length) {
    await bulk(
      ctx,
      historyId,
      "add_tags",
      [{ id: built.id, history_content_type: "dataset_collection" }],
      { type: "add_tags", tags: [...i.tags] },
    );
  }

  return {
    grouping,
    collection: built,
    batches: Boolean(datatype),
    datatype_queued: pending.length,
    datatype_already_set: datatype ? grouping.items.length - pending.length : 0,
  };
}

function sample<T = string>(names: T[] = []) {
  return {
    count: names.length,
    names: names.slice(0, NAME_SAMPLE),
    ...(names.length > NAME_SAMPLE ? { truncated: true } : {}),
  };
}

/** Galaxy's list builder warns of mixed formats and still builds; so does this. */
function mixed(grouping: Grouping, datatype: unknown) {
  return !datatype && grouping.datatypes.length > 1
    ? {
        note:
          `The collection mixes datatypes (${grouping.datatypes.join(", ")}). Galaxy allows ` +
          "this, but a list generally holds datasets of one datatype.",
      }
    : {};
}

function ambiguity(grouping: Grouping) {
  const { duplicate_mates = [], mixed_markers = [] } = grouping.ambiguity || {};
  return duplicate_mates.length || mixed_markers.length
    ? { ambiguity: { duplicate_mates: sample(duplicate_mates), mixed_markers } }
    : {};
}

/** Counts and a sample of names. The payload itself must never reach the model. */
export function summarize(state: Built): Built {
  const grouping: Grouping = state.grouping;
  if (state.preview) {
    const pairs = sample(grouping.pairs);
    return {
      preview: true,
      written: "nothing; call again without preview to build",
      collection: {
        type: grouping.structure,
        elements: grouping.elements.length,
        inferred: grouping.inferred,
      },
      pairs: {
        count: pairs.count,
        examples: pairs.names,
        ...(pairs.truncated ? { truncated: true } : {}),
      },
      unpaired: sample(grouping.unmatched),
      out_of_scope: sample(grouping.out_of_scope),
      ...ambiguity(grouping),
      ...mixed(grouping, state.datatype),
      datatype: state.datatype ? { would_change: state.datatype_pending ?? 0 } : null,
    };
  }
  const built = state.collection || {};
  return {
    collection: {
      id: built.id ?? null,
      hid: built.hid ?? null,
      name: built.name ?? null,
      type: grouping.structure,
      elements: grouping.elements.length,
    },
    unpaired: sample(grouping.unmatched),
    out_of_scope: sample(grouping.out_of_scope),
    ...ambiguity(grouping),
    ...mixed(grouping, state.batches),
    datatype: state.batches
      ? {
          queued: state.datatype_queued ?? 0,
          state: "Galaxy applies these in the background; they are not converted yet",
        }
      : null,
  };
}

export const buildCollectionOp: Operation<typeof input, Built> = {
  name: "build_collection",
  domain: "collections",
  summary:
    "Build a list or list:paired collection from datasets in a history, as Galaxy's " +
    "collection builders do, pairing mates and naming samples from the file names; " +
    "optionally set the datatype of its elements and tag it. Datasets left out stay as they " +
    "are. With preview, report what it would build without writing anything. Use when the " +
    "user asks to organize, group or collect datasets in a history, such as uploaded files " +
    "or the contents of an unzipped archive, into a collection; not for filtering, " +
    "relabeling or restructuring an existing collection, which Galaxy's collection tools do.",
  input,
  readOnly: false,
  run,
  project: (state) => ({ data: summarize(state) }),
};

export const buildCollection = (i: In, ctx: GalaxyContext) =>
  runOperation(buildCollectionOp, i as InputOf<typeof input>, ctx);
