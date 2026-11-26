import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { groupDatasets } from "./dataset-grouping";

const ds = (name: string, i?: number) => ({ id: `id_${i ?? name}`, name });
const names = (files: string[]) => files.map((f, i) => ds(f, i));
const elementNames = (out: ReturnType<typeof groupDatasets>) => out.elements.map((e) => e.name);

const SRA = [1, 2, 3].flatMap((n) => [1, 2].map((m) => `SRR100${n}_${m}.fastq.gz`));
const ILLUMINA = [1, 2].flatMap((n) => [1, 2].map((m) => `sample${n}_R${m}_001.fastq.gz`));
const ZIP_FLAT = [1, 2, 3, 4].map((n) => `reads/run_${n}.fastq.gz`);

describe("pairing", () => {
  it("pairs SRA names into list:paired", () => {
    const out = groupDatasets({ datasets: names(SRA) });
    expect(out.structure).toBe("list:paired");
    expect(elementNames(out)).toEqual(["SRR1001", "SRR1002", "SRR1003"]);
    expect(out.unmatched).toEqual([]);
  });

  it("pairs Illumina R1/R2", () => {
    const out = groupDatasets({ datasets: names(ILLUMINA) });
    expect(out.structure).toBe("list:paired");
    expect(elementNames(out)).toEqual(["sample1_001", "sample2_001"]);
  });

  it("builds a pair as a nested collection the API accepts", () => {
    const element = groupDatasets({ datasets: [ds("s_R1.fastq.gz", 0), ds("s_R2.fastq.gz", 1)] })
      .elements[0];
    expect(element.src).toBe("new_collection");
    expect(element.collection_type).toBe("paired");
    expect(element.element_identifiers).toEqual([
      { name: "forward", src: "hda", id: "id_0" },
      { name: "reverse", src: "hda", id: "id_1" },
    ]);
  });

  it("points a flat element straight at the dataset", () => {
    const out = groupDatasets({ datasets: names(["s0.fastq.gz", "s1.fastq.gz"]) });
    expect(out.elements[0]).toEqual({ name: "s0.fastq.gz", src: "hda", id: "id_0" });
  });

  it("does not mistake run numbers for mates", () => {
    const out = groupDatasets({ datasets: names(ZIP_FLAT) });
    expect(out.structure).toBe("list");
    expect(out.elements).toHaveLength(4);
    expect(out.unmatched).toEqual([]);
  });

  it("names a half pair as a leftover", () => {
    const out = groupDatasets({ datasets: names(["s1_R1.fq.gz", "s1_R2.fq.gz", "s2_R1.fq.gz"]) });
    expect(out.structure).toBe("list:paired");
    expect(elementNames(out)).toEqual(["s1"]);
    expect(out.unmatched).toEqual(["s2_R1.fq.gz"]);
    expect(out.has_leftovers).toBe(true);
  });

  it("makes a non-read file a leftover", () => {
    const out = groupDatasets({ datasets: names(["a_R1.fastq.gz", "a_R2.fastq.gz", "notes.txt"]) });
    expect(out.structure).toBe("list:paired");
    expect(out.unmatched).toEqual(["notes.txt"]);
  });

  it("pairs only when more than half the files sit in complete pairs", () => {
    const files = (extra: number) =>
      names([...ILLUMINA, ...Array.from({ length: extra }, (_, i) => `other${i}.fastq.gz`)]);
    expect(groupDatasets({ datasets: files(3) }).structure).toBe("list:paired");
    expect(groupDatasets({ datasets: files(4) }).structure).toBe("list");
  });

  it("forces pairing past the majority rule with structure paired", () => {
    const out = groupDatasets({
      datasets: names(["a.fq", "b.fq", "c.fq", "s_1.fq", "s_2.fq"]),
      structure: "paired",
    });
    expect(out.structure).toBe("list:paired");
    expect(elementNames(out)).toEqual(["s"]);
    expect(out.unmatched).toEqual(["a.fq", "b.fq", "c.fq"]);
  });

  it("prefers R1 over a trailing 1 on the same name", () => {
    expect(
      elementNames(groupDatasets({ datasets: names(["lane1_R1.fastq.gz", "lane1_R2.fastq.gz"]) })),
    ).toEqual(["lane1"]);
  });

  it("reports empty input as empty", () => {
    const out = groupDatasets({ datasets: [] });
    expect(out.empty).toBe(true);
    expect(out.elements).toEqual([]);
  });
});

describe("archive members", () => {
  it("pairs a zip of paired reads", () => {
    const out = groupDatasets({ datasets: names(SRA.map((n) => `run/${n}`)) });
    expect(out.structure).toBe("list:paired");
    expect(elementNames(out)).toEqual(["SRR1001", "SRR1002", "SRR1003"]);
  });

  it("lists a zip of single-end reads", () => {
    const out = groupDatasets({ datasets: names([0, 1, 2].map((n) => `reads/s${n}.fastq.gz`)) });
    expect(out.structure).toBe("list");
    expect(elementNames(out)).toEqual(["s0.fastq.gz", "s1.fastq.gz", "s2.fastq.gz"]);
  });

  it("keeps nested directories out of the identifiers", () => {
    const out = groupDatasets({
      datasets: names(["a/b/c/SRR1_R1.fastq.gz", "a/b/c/SRR1_R2.fastq.gz"]),
    });
    expect(elementNames(out)).toEqual(["SRR1"]);
  });

  it("keeps the odd member of an archive holding both shapes", () => {
    const out = groupDatasets({ datasets: names(["p_R1.fastq.gz", "p_R2.fastq.gz", "notes.txt"]) });
    expect(out.structure).toBe("list:paired");
    expect(out.unmatched).toEqual(["notes.txt"]);
  });
});

describe("scope", () => {
  it("puts a non-read file beyond reach with include", () => {
    const out = groupDatasets({
      datasets: names(["a_R1.fastq.gz", "a_R2.fastq.gz", "notes.txt"]),
      include: "*.fastq.gz",
    });
    expect(out.out_of_scope).toEqual(["notes.txt"]);
    expect(out.unmatched).toEqual([]);
    expect(out.has_leftovers).toBe(false);
    expect(out.items).toHaveLength(2);
  });

  it("keeps leftovers out of items so a datatype write reaches only the collection", () => {
    const out = groupDatasets({ datasets: names(["s1_R1.fq.gz", "s1_R2.fq.gz", "s2_R1.fq.gz"]) });
    expect(out.items.map((i) => i.id)).toEqual(["id_0", "id_1"]);
  });
});

describe("evidence for pairing", () => {
  it("does not marry two unrelated assemblies into a pair", () => {
    const out = groupDatasets({ datasets: names(["assembly_1.fasta", "assembly_2.fasta"]) });
    expect(out.structure).toBe("list");
    expect(elementNames(out)).toEqual(["assembly_1.fasta", "assembly_2.fasta"]);
  });

  it("does not marry assemblies by datatype when the names look like reads", () => {
    const out = groupDatasets({
      datasets: ["assembly_1.fastq", "assembly_2.fastq"].map((name, i) => ({
        id: `id_${i}`,
        name,
        extension: "fasta",
      })),
    });
    expect(out.structure).toBe("list");
  });

  it("pairs a single sample of reads on a bare marker", () => {
    const out = groupDatasets({ datasets: names(["patient_1.fastq.gz", "patient_2.fastq.gz"]) });
    expect(out.structure).toBe("list:paired");
    expect(elementNames(out)).toEqual(["patient"]);
  });

  it("pairs reads by datatype when the names carry no read extension", () => {
    const out = groupDatasets({
      datasets: ["patient_1", "patient_2"].map((name, i) => ({
        id: `id_${i}`,
        name,
        extension: "fastqsanger.gz",
      })),
    });
    expect(out.structure).toBe("list:paired");
    expect(elementNames(out)).toEqual(["patient"]);
  });

  it("pairs a single sample on an explicit marker", () => {
    const out = groupDatasets({ datasets: names(["patient_R1.fastq.gz", "patient_R2.fastq.gz"]) });
    expect(out.structure).toBe("list:paired");
    expect(elementNames(out)).toEqual(["patient"]);
  });

  it("pairs a bare marker once a second sample shows the convention", () => {
    const out = groupDatasets({
      datasets: names(["a_1.fasta", "a_2.fasta", "b_1.fasta", "b_2.fasta"]),
    });
    expect(out.structure).toBe("list:paired");
    expect(elementNames(out)).toEqual(["a", "b"]);
  });

  it("lets structure paired override the evidence rule", () => {
    expect(
      groupDatasets({ datasets: names(["patient_1.fq", "patient_2.fq"]), structure: "paired" })
        .structure,
    ).toBe("list:paired");
  });

  it("recognises word markers", () => {
    for (const [forward, reverse] of [
      ["forward", "reverse"],
      ["fwd", "rev"],
      ["read1", "read2"],
    ]) {
      const out = groupDatasets({ datasets: names([`s_${forward}.fq`, `s_${reverse}.fq`]) });
      expect(out.structure).toBe("list:paired");
      expect(elementNames(out)).toEqual(["s"]);
    }
  });
});

describe("identifier collisions", () => {
  it("pairs per-sample directories without colliding", () => {
    const members = [1, 2, 3].flatMap((k) => [1, 2].map((m) => `Sample${k}/reads_R${m}.fq.gz`));
    const out = groupDatasets({ datasets: names(members) });
    expect(out.structure).toBe("list:paired");
    expect(elementNames(out)).toEqual(["Sample1_reads", "Sample2_reads", "Sample3_reads"]);
  });

  it("qualifies a flat list of colliding names by directory", () => {
    expect(
      elementNames(groupDatasets({ datasets: names(["A/notes.txt", "B/notes.txt"]) })),
    ).toEqual(["A_notes.txt", "B_notes.txt"]);
  });

  it("keeps identifiers unique across every layout", () => {
    const layouts = [
      [1, 2, 3].flatMap((n) => [1, 2].map((m) => `SRR100${n}_${m}.fastq.gz`)),
      [1, 2, 3].flatMap((n) => [1, 2].map((m) => `S${n}_S1_L001_R${m}_001.fastq.gz`)),
      [1, 2].flatMap((k) => [1, 2].map((m) => `Sample${k}/reads_R${m}.fq.gz`)),
      [1, 2].flatMap((k) => [1, 2].flatMap((n) => [1, 2].map((m) => `lane${k}/S${n}_R${m}.fq`))),
      ["A/notes.txt", "B/notes.txt", "C/notes.txt"],
    ];
    for (const layout of layouts) {
      const identifiers = elementNames(groupDatasets({ datasets: names(layout) }));
      expect(new Set(identifiers).size).toBe(identifiers.length);
    }
  });
});

describe("the caller-supplied pattern", () => {
  it("pairs a convention the rules cannot infer", () => {
    const out = groupDatasets({
      datasets: names([
        "A01_fwd_seq.fq.gz",
        "A01_rev_seq.fq.gz",
        "A02_fwd_seq.fq.gz",
        "A02_rev_seq.fq.gz",
      ]),
      sampleRegex: "(?P<sample>[A-Z]\\d+)_(?P<mate>fwd|rev)_seq",
    });
    expect(out.structure).toBe("list:paired");
    expect(elementNames(out)).toEqual(["A01", "A02"]);
  });

  it("can take the sample from the directory", () => {
    const out = groupDatasets({
      datasets: names([
        "donorA/part1.fq.gz",
        "donorA/part2.fq.gz",
        "donorB/part1.fq.gz",
        "donorB/part2.fq.gz",
      ]),
      sampleRegex: "(?P<sample>[^/]+)/part(?P<mate>[12])",
    });
    expect(elementNames(out)).toEqual(["donorA", "donorB"]);
  });

  it("names samples with a pattern that has no mate group and still pairs the mates", () => {
    const out = groupDatasets({
      datasets: names([
        "SRR000001_1.fastq.gz",
        "SRR000001_2.fastq.gz",
        "SRR000002_1.fastq.gz",
        "SRR000002_2.fastq.gz",
      ]),
      sampleRegex: "(?<sample>SRR\\d+)_\\d\\.fastq\\.gz$",
    });
    expect(out.structure).toBe("list:paired");
    expect(elementNames(out)).toEqual(["SRR000001", "SRR000002"]);
    expect(out.pairs[0]).toEqual({
      sample: "SRR000001",
      forward: "SRR000001_1.fastq.gz",
      reverse: "SRR000001_2.fastq.gz",
    });
  });

  it("forces nothing when the pattern's mates are not mates", () => {
    const out = groupDatasets({
      datasets: names(["only_a.fq", "only_b.fq"]),
      sampleRegex: "(?P<sample>only)_(?P<mate>[ab])",
    });
    expect(out.structure).toBe("list");
  });

  it("makes a file the pattern misses a leftover, not a guess", () => {
    const out = groupDatasets({
      datasets: names(["good_R1.fq", "good_R2.fq", "stray.txt"]),
      sampleRegex: "(?P<sample>\\w+)_(?P<mate>R[12])",
    });
    expect(out.unmatched).toEqual(["stray.txt"]);
  });

  it("says so when the pattern is broken", () => {
    expect(() => groupDatasets({ datasets: names(["a.fq"]), sampleRegex: "(?P<sample>" })).toThrow(
      /not a valid regular expression/,
    );
  });
});

describe("structure names", () => {
  it("accepts Galaxy's own name for a paired list", () => {
    const datasets = [1, 2].flatMap((s) =>
      [1, 2].map((m) => ({
        name: `S${s}_${m}.fasta.gz`,
        id: `${s}${m}`,
        extension: "fasta.gz",
        history_content_type: "dataset",
      })),
    );
    expect(groupDatasets({ datasets, structure: "list:paired" }).structure).toBe("list:paired");
  });

  it("refuses an unknown structure rather than quietly flattening", () => {
    expect(() => groupDatasets({ datasets: [], structure: "nonsense" })).toThrow(
      'structure must be "auto", "paired" or "list", not "nonsense"',
    );
  });
});

describe("Galaxy's auto_pairing_spec.yml", () => {
  const spec = parse(readFileSync(join(__dirname, "auto_pairing_spec.yml"), "utf8")) as {
    doc: string;
    inputs: string[];
    paired: Record<string, { forward: string; reverse: string }>;
  }[];

  for (const { doc, inputs, paired } of spec) {
    it(doc, () => {
      const out = groupDatasets({ datasets: inputs.map((name) => ({ id: name, name })) });
      expect(out.structure).toBe("list:paired");
      expect(out.unmatched).toEqual([]);
      const pairs = Object.fromEntries(
        out.elements.map((e) => [
          e.name,
          Object.fromEntries(e.element_identifiers!.map((m) => [m.name, m.id])),
        ]),
      );
      expect(pairs).toEqual(paired);
    });
  }
});

describe("what a preview shows", () => {
  it("names each pair by its files", () => {
    const out = groupDatasets({ datasets: names(ILLUMINA) });
    expect(out.pairs).toEqual([
      {
        sample: "sample1_001",
        forward: "sample1_R1_001.fastq.gz",
        reverse: "sample1_R2_001.fastq.gz",
      },
      {
        sample: "sample2_001",
        forward: "sample2_R1_001.fastq.gz",
        reverse: "sample2_R2_001.fastq.gz",
      },
    ]);
  });

  it("says whether the structure was inferred or given", () => {
    expect(groupDatasets({ datasets: names(SRA) }).inferred).toBe(true);
    expect(groupDatasets({ datasets: names(SRA), structure: "paired" }).inferred).toBe(false);
  });

  it("keeps lanes and chunks apart rather than merging them", () => {
    const lanes = [1, 2].flatMap((l) => [1, 2].map((m) => `S1_L00${l}_R${m}_001.fastq.gz`));
    const out = groupDatasets({ datasets: names(lanes) });
    expect(elementNames(out)).toEqual(["S1_L001_001", "S1_L002_001"]);
    expect(out.ambiguity).toEqual({ duplicate_mates: [], mixed_markers: [] });
  });

  it("flags a sample with two files for one mate and pairs neither", () => {
    const out = groupDatasets({
      datasets: names([...SRA, "SRR1003_1.fq.gz"]),
    });
    expect(out.ambiguity.duplicate_mates).toEqual(["SRR1003"]);
    expect(elementNames(out)).toEqual(["SRR1001", "SRR1002"]);
    expect(out.unmatched).toEqual(["SRR1003_1.fastq.gz", "SRR1003_1.fq.gz", "SRR1003_2.fastq.gz"]);
  });

  it("flags pairs marked by different conventions", () => {
    const out = groupDatasets({ datasets: names([...SRA, ...ILLUMINA]) });
    expect(out.ambiguity.mixed_markers).toEqual(["1/2", "R1/R2"]);
  });
});
