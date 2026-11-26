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
type Organized = Record<string, any>;

const input = {
  historyId: z.string(),
  collectionName: z.string().default("Collection"),
  include: z.string().default("*"),
  structure: z
    .string()
    .default("auto")
    .describe(
      '"auto" pairs on evidence, "paired" (or Galaxy\'s own "list:paired") forces pairing, ' +
        '"list" forces a flat list.',
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
      "Report the structure, pairs, unpaired files and ambiguities it would build, and write " +
        "nothing.",
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
  collectionName?: string | null;
  include?: string | null;
  structure?: string | null;
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

async function run(i: In, ctx: GalaxyContext): Promise<Organized> {
  const historyId = i.historyId;
  const structure = i.structure ?? "auto";
  const include = i.include ?? "*";
  const datatype = i.datatype ?? undefined;
  const sampleRegex = i.sampleRegex ?? undefined;

  const visible = await contents(ctx, historyId, "True");
  const grouping = groupDatasets({ datasets: visible, structure, include, sampleRegex });
  if (grouping.empty) {
    const hidden = groupDatasets({
      datasets: await contents(ctx, historyId, "False"),
      structure,
      include,
      sampleRegex,
    });
    const elsewhere = hidden.empty
      ? ""
      : ` ${hidden.items.length} hidden dataset(s) would form a ${hidden.structure} ` +
        "collection; they are most likely inside a collection built earlier. Use that " +
        "collection rather than organizing them again.";
    throw new GalaxyValidationError(
      `Nothing was organized: no visible datasets formed a ${grouping.structure} collection.` +
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

  const built = await collection(
    ctx,
    historyId,
    i.collectionName ?? "Collection",
    grouping.structure,
    grouping.elements,
  );

  // Files that did not pair get their own collection rather than being dropped.
  const leftovers = grouping.has_leftovers
    ? await collection(ctx, historyId, "Unpaired", "list", grouping.leftovers)
    : null;

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
    leftovers,
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

function ambiguity(grouping: Grouping) {
  const { duplicate_mates = [], mixed_markers = [] } = grouping.ambiguity || {};
  return duplicate_mates.length || mixed_markers.length
    ? { ambiguity: { duplicate_mates: sample(duplicate_mates), mixed_markers } }
    : {};
}

/** Counts and a sample of names. The payload itself must never reach the model. */
export function summarize(state: Organized): Organized {
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
      datatype: state.datatype ? { would_change: state.datatype_pending ?? 0 } : null,
    };
  }
  const built = state.collection || {};
  const leftovers = state.leftovers || {};
  return {
    collection: {
      id: built.id ?? null,
      name: built.name ?? null,
      type: grouping.structure,
      elements: grouping.elements.length,
    },
    unpaired: { id: leftovers.id || null, ...sample(grouping.unmatched) },
    out_of_scope: sample(grouping.out_of_scope),
    ...ambiguity(grouping),
    datatype: state.batches
      ? {
          queued: state.datatype_queued ?? 0,
          state: "Galaxy applies these in the background; they are not converted yet",
        }
      : null,
  };
}

export const organizeDatasetsOp: Operation<typeof input, Organized> = {
  name: "organize_datasets",
  domain: "collections",
  summary:
    "Group loose datasets in a history into a new list or list:paired collection, set the " +
    "datatype of its elements, and tag it. With preview, report the structure and pairs it " +
    "would build without writing anything. Use when the user asks to organise, group, or " +
    "collect loose datasets in a history, such as uploaded files or the contents of an " +
    "unzipped archive, into a collection; not for filtering, relabelling or restructuring an " +
    "existing collection, which Galaxy's collection tools do.",
  input,
  readOnly: false,
  run,
  project: (state) => ({ data: summarize(state) }),
};

export const organizeDatasets = (i: In, ctx: GalaxyContext) =>
  runOperation(organizeDatasetsOp, i as InputOf<typeof input>, ctx);
