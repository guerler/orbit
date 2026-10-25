// Tests Olit as Galaxy AI's chat on the stub's host page, which hosts it as Galaxy does: one frame,
// a port handed in once it says ready, and commands over that port in order.
// Covers: its reports, asking without a reload or a new worker, opening a chat without a reload,
// commands in order, a question during an answer, refusing commands from another frame, and
// artifacts in the chat's own pane. BROWSER=firefox or webkit runs it there; the mid-answer part is
// skipped in WebKit, which keeps no conversations in the browser.
const playwright = require("playwright");
const storedProvider = require("./stored-provider.cjs");
const BROWSER = process.env.BROWSER || "chromium";
const STUB = "http://127.0.0.1:8099";
const HOST = `${STUB}/plugins/visualizations/olit`;

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const calls = async () => (await (await fetch(`${STUB}/__seen`)).json()).calls;
const until = async (test, ms = 30000) => {
    const end = Date.now() + ms;
    let ok = await test();
    while (!ok && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 200));
        ok = await test();
    }
    return ok;
};

async function machine(browser, url) {
    const page = await (await browser.newContext()).newPage();
    await storedProvider(page, { provider: "openrouter", baseUrl: `${STUB}/v1`, apiKey: "sk-or-v1-stubkeystubkey", model: "stub-model" });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return { page, frame: page.frameLocator("#galaxy_visualization") };
}

const ready = (frame) =>
    frame
        .locator("text=/Ready\\./")
        .first()
        .waitFor({ timeout: 120000 })
        .then(() => true, () => false);

(async () => {
    const browser = await playwright[BROWSER].launch();

    // A plain frame runs as a visualization and saves to Galaxy's visualizations.
    const plain = await machine(browser, `${HOST}?dataset_id=dlife&frame=1`);
    const plainReady = await ready(plain.frame);
    const plainSave = await plain.frame.locator("#save-btn").getAttribute("title");
    check("a plain frame runs as a visualization",
        plainReady && plainSave === "Save this conversation to Galaxy to reopen it on any device", plainSave);

    await fetch(`${STUB}/__script?name=plain`);
    // A chat saved without a session, to open after asking.
    const turns = [{ query: "Which aligner?", response: "HISAT2." }];
    await fetch(`${STUB}/__held?id=g1&turns=${encodeURIComponent(JSON.stringify(turns))}`);
    const { page, frame } = await machine(browser, `${HOST}?frame=1&view=chat`);
    const host = () => page.evaluate(() => {
        const view = document.getElementById("galaxy_visualization").contentWindow;
        return { ...window.__galaxyAi, page: view.__page };
    });
    const reports = async (type) => (await host()).reports.filter((r) => r.type === type);
    const last = async (type) => (await reports(type)).at(-1);
    const command = (given) => page.evaluate((c) => window.__command(c), given);
    const text = () => frame.locator("#messages").innerText();

    check("the chat boots", await ready(frame));
    check("it says ready and is handed a port", (await reports("ready")).length === 1, JSON.stringify((await host()).reports));
    check("it reports a new chat, unchanged",
        await until(async () => (await last("active"))?.exchange_id === null && (await last("unsaved"))?.value === false),
        JSON.stringify((await host()).reports));
    check("it sends no Charts messages as the chat", (await host()).charts.length === 0, JSON.stringify((await host()).charts));

    await command({ type: "ask", question: "remember this" });
    check("an asked question is answered",
        await until(async () => /remember this[\s\S]*Noted\./.test(await text()), 60000), (await text()).slice(-200));
    check("asking reports unsaved", (await last("unsaved"))?.value === true, JSON.stringify(await reports("unsaved")));
    check("asking keeps the page and its worker", (await host()).page === "first" && (await host()).workers === 1,
        JSON.stringify(await host()));

    await frame.locator("#save-btn:not([disabled])").click({ timeout: 30000 });
    check("saving reports the new chat id", await until(async () => typeof (await last("active"))?.exchange_id === "string"),
        JSON.stringify(await reports("active")));
    const savedId = (await last("active")).exchange_id;
    check("saving reports saved", await until(async () => (await last("unsaved"))?.value === false),
        JSON.stringify(await reports("unsaved")));

    await command({ type: "open", exchange_id: "g1" });
    check("opening a chat reports it, unchanged",
        await until(async () => (await last("active"))?.exchange_id === "g1" && (await last("unsaved"))?.value === false, 60000),
        JSON.stringify((await host()).reports.slice(-4)));
    check("the opened chat shows", await until(async () => /Which aligner\?/.test(await text())), (await text()).slice(-200));
    check("opening keeps the page, with a new worker", (await host()).page === "first" && (await host()).workers === 2,
        JSON.stringify(await host()));

    // An open followed at once by a question: the question comes after the open.
    const before = (await host()).reports.length;
    await page.evaluate((id) => {
        window.__command({ type: "open", exchange_id: id });
        window.__command({ type: "ask", question: "and then?" });
    }, savedId);
    check("a question after an open is asked in a new conversation",
        await until(async () => /and then\?[\s\S]*Noted\./.test(await text()) && !/remember this/.test(await text()), 60000),
        (await text()).slice(-300));
    const after = (await host()).reports.slice(before).filter((r) => r.type === "active").map((r) => r.exchange_id);
    check("the open ran before the question", JSON.stringify(after) === JSON.stringify([savedId, null]), JSON.stringify(after));
    check("both kept the page", (await host()).page === "first" && (await host()).workers === 3, JSON.stringify(await host()));

    // Two questions at once: neither is dropped.
    await page.evaluate(() => {
        window.__command({ type: "ask", question: "first of two" });
        window.__command({ type: "ask", question: "second of two" });
    });
    check("the second of two questions is asked",
        await until(async () => /second of two[\s\S]*Noted\./.test(await text()), 60000), (await text()).slice(-300));
    check("asking the second holds the first's running turn, visibly",
        /Its running turn stopped; Galaxy jobs it started are still watched\./.test(await text()), (await text()).slice(-300));

    if (BROWSER !== "webkit") {
        await fetch(`${STUB}/__script?name=slow-once`);
        const already = await calls();
        await command({ type: "ask", question: "answer slowly" });
        check("the answer is in flight", await until(async () => (await calls()) > already));
        await command({ type: "ask", question: "the next question" });
        check("a question during an answer is answered in a new conversation",
            await until(async () => /the next question[\s\S]*The answer after the reload\./.test(await text()), 60000),
            (await text()).slice(-300));
        check("it says the running turn stopped", /Its running turn stopped/.test(await text()));
        await new Promise((r) => setTimeout(r, 3000));
        check("the held answer never shows", !/the abandoned answer/.test(await text()));
        const idle = await until(() => frame.locator("#send-btn").evaluate((b) => !b.classList.contains("hidden")), 30000);
        check("Send is available", idle);
        await fetch(`${STUB}/__script?name=plain`);
    }

    // Commands only come over Galaxy's port: another frame is ignored.
    const asked = (await host()).reports.length;
    await page.evaluate(() => window.__foreign({ type: "ask", question: "from another frame" }));
    await new Promise((r) => setTimeout(r, 3000));
    check("a command from another frame is ignored",
        !/from another frame/.test(await text()) && (await host()).reports.length === asked, (await text()).slice(-200));
    check("only one frame was ever mounted", (await host()).mounts.length === 1 && (await host()).page === "first",
        JSON.stringify(await host()));

    // Artifacts show in the chat's own pane, inside its frame.
    const shows = await machine(browser, `${HOST}?dataset_id=d1&frame=1&view=chat`);
    check("a chat on a dataset boots", await ready(shows.frame));
    await fetch(`${STUB}/__script?name=visualization`);
    await shows.frame.locator("#input").fill("open the structure in a viewer");
    await shows.frame.locator("#send-btn").click();
    const inPane = await shows.frame
        .frameLocator("#artifact-content iframe")
        .locator("#app", { hasText: "ngl mounted" })
        .waitFor({ timeout: 90000 })
        .then(() => true, () => false);
    check("an artifact shows in the chat's own pane", inPane);
    check("there is only one frame", (await shows.page.locator("iframe").count()) === 1);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    await browser.close();
    process.exit(failed.length ? 1 : 0);
})();
