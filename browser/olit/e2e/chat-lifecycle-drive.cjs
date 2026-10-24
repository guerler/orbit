// Tests Olit in chat mode on the stub's host page, which mounts it like Galaxy does.
// Covers: saved-state and chat-id messages, remounting per command, interrupting an answer, and
// artifacts in the chat's own pane. BROWSER=firefox or webkit runs it there; the mid-answer part
// is skipped in WebKit, which keeps no conversations in the browser.
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

const hosted = (page) => page.evaluate(() => window.__galaxyAi);
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
        .locator("text=/Ready\./")
        .first()
        .waitFor({ timeout: 120000 })
        .then(() => true, () => false);

/** Sends a command and waits for the remounted plugin. */
async function command(page, config) {
    await page.evaluate((given) => window.__command(given), config);
    return ready(page.frameLocator("#galaxy_visualization"));
}

(async () => {
    const browser = await playwright[BROWSER].launch();

    // Without the chat view, Olit runs as a visualization.
    const plain = await machine(browser, `${HOST}?dataset_id=dlife&frame=1`);
    const plainReady = await ready(plain.frame);
    const plainText = await plain.frame.locator("body").innerText();
    check("without the chat view, Olit runs as a visualization",
        plainReady && !/GalaxyAI/.test(plainText), plainText.replace(/\s+/g, " ").slice(0, 200));

    await fetch(`${STUB}/__script?name=plain`);
    // An older GalaxyAI chat, to open over unsaved changes.
    const turns = [{ query: "Which aligner?", response: "HISAT2." }];
    await fetch(`${STUB}/__held?id=g1&turns=${encodeURIComponent(JSON.stringify(turns))}`);
    const { page, frame } = await machine(browser, `${HOST}?frame=1&view=chat`);
    check("the chat boots", await ready(frame));
    const saved = async () => (await hosted(page)).saved;
    const shown = async () => (await hosted(page)).configs.at(-1);
    check("reports saved once on mount", JSON.stringify(await saved()) === "[true]", JSON.stringify(await saved()));
    check("reports no chat id before saving",
        await until(async () => JSON.stringify(await shown()) === JSON.stringify({ view: "chat" })), JSON.stringify(await shown()));
    await frame.locator("#input").fill("remember this");
    await frame.locator("#send-btn").click();
    check("asking a question reports unsaved", await until(async () => (await saved()).at(-1) === false), JSON.stringify(await saved()));
    await frame.locator("text=Noted.").last().waitFor({ timeout: 60000 });
    await frame.locator("#save-btn:not([disabled])").click({ timeout: 30000 });
    check("saving reports the new chat id", await until(async () => typeof (await shown())?.exchange_id === "string"), JSON.stringify(await shown()));
    const savedId = (await shown()).exchange_id;
    check("saving reports saved", await until(async () => (await saved()).at(-1) === true), JSON.stringify(await saved()));
    check("its messages do not remount it", (await hosted(page)).mounts.length === 1, JSON.stringify((await hosted(page)).mounts));

    // Change the chat, then open another one; the new one starts saved.
    await frame.locator("#input").fill("one more thing");
    await frame.locator("#send-btn").click();
    await frame.locator("text=Noted.").nth(1).waitFor({ timeout: 60000 });
    check("asking again reports unsaved", (await saved()).at(-1) === false, JSON.stringify(await saved()));
    await command(page, { exchange_id: "g1" });
    check("opening another chat remounts, reports saved and its id",
        await until(async () => (await shown())?.exchange_id === "g1" && (await saved()).at(-1) === true),
        JSON.stringify(await hosted(page)));
    check("only changes are reported", (await saved()).every((v, i, all) => i === 0 || v !== all[i - 1]), JSON.stringify(await saved()));
    await command(page, { exchange_id: savedId });
    await until(async () => (await shown())?.exchange_id === savedId);

    // WebKit reports the wrong sender for messages sent from a click.
    await page.frameLocator("#galaxy_visualization").locator("#reset-btn").click();
    check("clicking New reports no chat id and saved",
        await until(async () => (await shown())?.exchange_id === undefined && (await saved()).at(-1) === true),
        JSON.stringify(await hosted(page)));
    check("only commands remount it", (await hosted(page)).mounts.length === 3, JSON.stringify((await hosted(page)).mounts));

    if (BROWSER !== "webkit") {
        const current = () => page.frameLocator("#galaxy_visualization");
        await fetch(`${STUB}/__script?name=slow-once`);
        await current().locator("#input").fill("answer slowly");
        await current().locator("#send-btn").click();
        check("the answer is in flight", await until(async () => (await calls()) >= 1));

        await command(page, { exchange_id: savedId });
        check("a command during an answer opens the saved chat",
            await until(async () => (await shown())?.exchange_id === savedId), JSON.stringify(await shown()));

        await command(page, {});
        const back = await until(async () => /answer slowly/.test(await current().locator("body").innerText()), 60000);
        check("the interrupted question is kept", back);
        await new Promise((r) => setTimeout(r, 3000));
        const text = await current().locator("body").innerText();
        check("the interrupted answer is not shown or resumed",
            !/the abandoned answer/.test(text) && (await calls()) === 1, `calls ${await calls()}`);
        const idle = await until(() => current().locator("#send-btn").evaluate((b) => !b.classList.contains("hidden")), 30000);
        check("Send is available", idle, idle ? "" : (await current().locator("body").innerText()).replace(/\s+/g, " ").slice(-300));
    }

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
