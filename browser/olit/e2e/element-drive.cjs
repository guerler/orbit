// Tests Olit as the olit-plugin element on the stub's element host page, which mounts it in its own
// page as Galaxy AI does: it imports the plugin's src, creates the tag the XML declares with
// data-incoming, and reads galaxy-visualization events. Covers: no frame and the host's #app left
// alone, reports, commands, a move, focus across moves, a drag copy, an embedded visualization
// across a move, removal, removal while starting, remounts, and the visualization view.
// BROWSER=firefox or webkit runs it there.
const playwright = require("playwright");
const storedProvider = require("./stored-provider.cjs");
const BROWSER = process.env.BROWSER || "chromium";
const STUB = "http://127.0.0.1:8099";
const HOST = `${STUB}/plugins/visualizations/olit?element=1`;

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const until = async (test, ms = 30000) => {
    const end = Date.now() + ms;
    let ok = await test();
    while (!ok && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 200));
        ok = await test();
    }
    return ok;
};

async function open(browser, url) {
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await storedProvider(page, { provider: "openrouter", baseUrl: `${STUB}/v1`, apiKey: "sk-or-v1-stubkeystubkey", model: "stub-model" });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return { page, errors };
}

const state = (page) =>
    page.evaluate(async () => ({
        ...window.__element,
        elements: document.querySelectorAll("olit-plugin").length,
        frames: document.querySelectorAll("iframe").length,
        app: document.getElementById("app").textContent,
        styles: document.head.querySelectorAll("style").length,
        locks: (await navigator.locks.query()).held.map((l) => l.name),
    }));
const live = async (page) => {
    const s = await state(page);
    return s.workers - s.terminated;
};
const text = (page) =>
    page.evaluate(() => document.querySelector("olit-plugin")?.shadowRoot?.querySelector("#messages")?.innerText || "");
const ready = (page, ms = 120000) => until(async () => /Ready\./.test(await text(page)), ms);

(async () => {
    const browser = await playwright[BROWSER].launch();
    await fetch(`${STUB}/__script?name=plain`);

    const { page, errors } = await open(browser, `${HOST}&view=chat`);
    check("the chat boots in the host's page", await ready(page));
    let s = await state(page);
    check("without a frame, and the host's #app is left alone",
        s.frames === 0 && s.app === "Galaxy's own app" && s.elements === 1, JSON.stringify(s));
    check("it reports as a Galaxy visualization, on the element",
        await until(async () => (await state(page)).reports.some((r) => r.from === "galaxy-visualization" && r.visualization_saved === true)),
        JSON.stringify((await state(page)).reports));
    check("it reports the new chat", (await state(page)).reports.some((r) => r.visualization_config?.exchange_id === null),
        JSON.stringify((await state(page)).reports));

    await page.evaluate(() => window.__command({ type: "ask", question: "remember this" }));
    check("a command asks its question",
        await until(async () => /remember this[\s\S]*Noted\./.test(await text(page)), 60000), (await text(page)).slice(-200));
    check("asking reports unsaved", (await state(page)).reports.at(-1)?.visualization_saved === false,
        JSON.stringify((await state(page)).reports.slice(-2)));
    check("one worker so far", (await state(page)).workers === 1, JSON.stringify(await state(page)));

    await page.evaluate(() => document.getElementById("slot-b").appendChild(document.querySelector("olit-plugin")));
    await page.waitForTimeout(1000);
    s = await state(page);
    check("a move keeps the conversation and the worker",
        /remember this/.test(await text(page)) && s.workers === 1 && s.terminated === 0, JSON.stringify(s));

    await page.evaluate(() => document.body.prepend(Object.assign(document.createElement("input"), { id: "galaxy-input" })));
    await page.click("olit-plugin textarea");
    await page.keyboard.type("draft");
    await page.evaluate(() => document.getElementById("slot-a").appendChild(document.querySelector("olit-plugin")));
    await page.waitForTimeout(300);
    await page.keyboard.type(" kept");
    await page.click("#galaxy-input");
    await page.evaluate(() => document.getElementById("slot-b").appendChild(document.querySelector("olit-plugin")));
    await page.waitForTimeout(300);
    await page.keyboard.type("galaxy");
    const typed = await page.evaluate(() => ({
        chat: document.querySelector("olit-plugin").shadowRoot.querySelector("textarea").value,
        galaxy: document.getElementById("galaxy-input").value,
    }));
    check("a move keeps the chat's focus, and takes none from the page", typed.chat === "draft kept" && typed.galaxy === "galaxy", JSON.stringify(typed));

    const ends = await page.evaluate(() => {
        const answer = [...document.querySelector("olit-plugin").shadowRoot.querySelectorAll("#messages .message.assistant")].at(-1);
        const range = document.createRange();
        range.selectNodeContents(answer);
        const rects = range.getClientRects();
        const first = rects[0];
        const last = rects[rects.length - 1];
        return { from: [last.right, last.top + last.height / 2], to: [first.left, first.top + first.height / 2] };
    });
    await page.evaluate(() => {
        window.__copied = null;
        window.addEventListener("copy", (e) => (window.__copied = e.clipboardData.getData("text/plain")), { once: true });
    });
    await page.mouse.move(...ends.from);
    await page.mouse.down();
    await page.mouse.move(...ends.to, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.press("ControlOrMeta+c");
    const copied = await page.evaluate(() => window.__copied);
    check("a backward drag copies the answer", /Noted/.test(copied || ""), JSON.stringify(copied));

    const shownViewer = () =>
        page.evaluate(() => {
            const frame = document.querySelector("olit-plugin").shadowRoot.querySelector("#artifact-content iframe");
            return /ngl mounted/.test(frame?.contentDocument?.getElementById("app")?.textContent || "");
        });
    await fetch(`${STUB}/__script?name=visualization`);
    await page.evaluate(() => window.__command({ type: "ask", question: "open the structure in a viewer" }));
    const viewed = await until(shownViewer, 90000);
    await page.evaluate(() => document.getElementById("slot-a").appendChild(document.querySelector("olit-plugin")));
    check("a move keeps an embedded visualization shown", viewed && (await until(shownViewer, 10000)));
    await fetch(`${STUB}/__script?name=plain`);

    await page.evaluate(() => document.querySelector("olit-plugin").remove());
    check("removing it ends its worker and lets go of its storage",
        await until(async () => (await live(page)) === 0 && (await state(page)).locks.length === 0, 10000),
        JSON.stringify(await state(page)));
    check("and takes its styles from the page", (await state(page)).styles === 0, JSON.stringify(await state(page)));

    await page.evaluate(() => {
        const element = window.__create({ view: "chat" });
        document.getElementById("slot-a").appendChild(element);
        element.remove();
    });
    await page.waitForTimeout(3000);
    s = await state(page);
    check("removed while starting, it leaves no worker, lock or styles",
        s.workers - s.terminated === 0 && s.locks.length === 0 && s.styles === 0, JSON.stringify(s));

    for (let cycle = 0; cycle < 3; cycle++) {
        await page.evaluate(() => document.getElementById("slot-a").appendChild(window.__create({ view: "chat" })));
        const booted = await ready(page, 60000);
        s = await state(page);
        const running = s.workers - s.terminated;
        await page.evaluate(() => document.querySelector("olit-plugin").remove());
        const ended = await until(async () => (await live(page)) === 0 && (await state(page)).locks.length === 0, 10000);
        check(`remount ${cycle + 1} starts one worker and ends it`, booted && running === 1 && ended, JSON.stringify(await state(page)));
    }
    check("no page errors", errors.length === 0, errors.join(" | "));

    const viz = await open(browser, `${HOST}&dataset_id=d1`);
    check("the visualization view boots as the element too", await ready(viz.page));
    s = await state(viz.page);
    check("it saves to Galaxy's visualizations",
        (await viz.page.evaluate(() => document.querySelector("olit-plugin").shadowRoot.querySelector("#save-btn")?.title)) ===
            "Save this conversation to Galaxy to reopen it on any device");
    await viz.page.evaluate(() => document.querySelector("olit-plugin").remove());
    check("removing the visualization ends its worker",
        await until(async () => (await live(viz.page)) === 0, 10000), JSON.stringify(await state(viz.page)));

    await browser.close();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
