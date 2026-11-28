/**
 * The headless realm, run for real: Python keeps its computation and its network, and loses the
 * session's environment and the host's files. The browser realm is proven by e2e/run-python.
 */

import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nodePython, pyodideDir } from "./python-node";

const SECRET = "OLIT_REALM_TEST_SECRET";
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("public");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => server.close());

describe("nodePython", () => {
  process.env[SECRET] = "sk-not-for-python";
  const python = nodePython();

  it("computes, and keeps its state across calls", async () => {
    await python.run("import numpy as np\nxs = np.array([3, 5, 10])");
    expect(await python.run("float(xs.mean())")).toBe("6.0");
  }, 120_000);

  // Node applies no CORS: headless, Python reads hosts a browser would not let it read.
  it("reaches the network with top-level await, CORS or not", async () => {
    expect(await python.run(`r = await pyfetch("${url}")\nf"{r.status}:{await r.string()}"`)).toBe(
      "'200:public'",
    );
  });

  it("does not see the session's environment", async () => {
    expect(
      await python.run(`import js\n"${SECRET}" in js.Object.keys(js.process.env).to_py()`),
    ).toBe("False");
  });

  it("cannot read the host's files", async () => {
    await expect(
      python.run(
        `import js\nfs = await js.eval("import('node:fs')")\nfs.readFileSync("${process.cwd()}/package.json", "utf8")`,
      ),
    ).rejects.toThrow(/restricted|ERR_ACCESS_DENIED/);
  });

  it("moves bytes in and out of its filesystem", async () => {
    await python.write("/data/in.txt", new TextEncoder().encode("abc"));
    await python.run(`open("/data/out.txt", "w").write(open("/data/in.txt").read().upper())`);
    expect(new TextDecoder().decode(await python.read("/data/out.txt"))).toBe("ABC");
    expect(await python.read("/data/missing")).toBeUndefined();
  });

  it("starts afresh after Pyodide could not start", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pyodide-")));
    const late = nodePython(dir);
    await expect(late.run("1 + 1")).rejects.toThrow();
    cpSync(pyodideDir(), dir, { recursive: true });
    expect(await late.run("1 + 1")).toBe("2");
    rmSync(dir, { recursive: true, force: true });
  }, 120000);

  it("ends a run that never returns when it is aborted, and starts afresh", async () => {
    const controller = new AbortController();
    const out = python.run("while True: pass", controller.signal);
    setTimeout(() => controller.abort(), 500);
    await expect(out).rejects.toThrow(/Python was stopped; its state was reset/);
    expect(await python.run("1 + 1")).toBe("2");
  }, 60_000);
});
