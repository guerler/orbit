import type { OpenRequest, PageMessage, WorkerMessage } from "./worker";

/** The agent worker as the page sees it: requests in, the conversation's state and events out. */
export class AgentClient {
  private worker: Worker;
  private replies = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 0;
  private closed = false;

  /**
   * `createWorker` belongs to the flavor: the worker entry it names is what decides which tools
   * the agent has, and a `new Worker(new URL(...))` here would bundle a second one without them.
   */
  constructor(listen: (message: WorkerMessage) => void, createWorker: () => Worker) {
    this.worker = createWorker();
    this.worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (data.type === "reply") {
        const waiting = this.replies.get(data.id);
        this.replies.delete(data.id);
        if (data.error !== undefined) waiting?.reject(new Error(data.error));
        else waiting?.resolve(data.value);
        return;
      }
      listen(data);
    };
    // A worker that never loads, or dies outside a message, would otherwise leave Send inert.
    this.worker.onerror = (e) => {
      e.preventDefault();
      listen({ type: "failed", message: e.message || "The assistant could not start." });
    };
  }

  private send(message: PageMessage) {
    if (!this.closed) this.worker.postMessage(message);
  }

  private request<T>(message: (id: number) => PageMessage): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new Error("The agent is closed."));
      this.replies.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send(message(id));
    });
  }

  open(request: OpenRequest) {
    this.send({ type: "open", request });
  }

  submit(text: string) {
    this.send({ type: "submit", text });
  }

  stop() {
    this.send({ type: "stop" });
  }

  confirm(id: number, approved: boolean) {
    this.send({ type: "confirmed", id, approved });
  }

  /** Continue the session whose record is `pageId`, or start a new one. */
  recover(pageId?: string) {
    this.send({ type: "recover", ...(pageId ? { pageId } : {}) });
  }

  reset() {
    this.send({ type: "reset" });
  }

  switchModel(config: Extract<PageMessage, { type: "switch" }>["config"]) {
    return this.request<void>((id) => ({ type: "switch", id, config }));
  }

  export(title: string) {
    return this.request<import("./saved").SessionDocument>((id) => ({ type: "export", id, title }));
  }

  saved(savedId: string, document: import("./saved").SessionDocument) {
    return this.request<void>((id) => ({ type: "saved", id, savedId, document }));
  }

  /** End the worker, which also lets go of its storage lock, and fail whatever waits on it. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const waiting of this.replies.values()) waiting.reject(new Error("The agent is closed."));
    this.replies.clear();
  }
}
