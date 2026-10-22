import type {
  BrowserContext,
  ConsoleMessage,
  Download,
  Frame,
  Page,
  Request,
  Response,
  WebSocket,
  Worker,
} from "playwright-core";

import type { SanitizedBrowserUrl } from "../domain/browserObservation.js";
import {
  browserScenarioEventSchema,
  type BrowserScenarioEvent,
} from "../domain/browserScenarioCaptureValues.js";
import type { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import type { BrowserNetworkContentSelection } from "../domain/browserNetworkEvidence.js";
import type { BrowserNetworkHeaders } from "../domain/browserNetworkEvidence.js";
import type { BrowserScenarioCaptureLimits } from "../domain/browserScenarioCaptureLimits.js";
import type {
  BrowserScenarioEventAdmission,
  BrowserScenarioEventBudgetReason,
  BrowserScenarioEventOmissions,
} from "../domain/browserScenarioCaptureValues.js";
import { DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS } from "../domain/browserScenarioCaptureLimits.js";
import { PlaywrightScenarioNetwork } from "./network/PlaywrightScenarioNetwork.js";

type EventName =
  | "console"
  | "page-errors"
  | "network"
  | "websockets"
  | "frames"
  | "workers"
  | "popups"
  | "downloads";

type UnindexedEvent = BrowserScenarioEvent extends infer Event
  ? Event extends BrowserScenarioEvent
    ? Omit<Event, "sequence" | "step_index">
    : never
  : never;

interface EventCaptureOptions {
  readonly page: Page;
  readonly context?: BrowserContext;
  /** A fresh launch context is wholly owned; connected contexts can contain other tabs. */
  readonly ownsContext?: boolean;
  readonly enabled: ReadonlySet<EventName>;
  readonly secrets: BrowserScenarioSecrets;
  readonly network?: BrowserNetworkContentSelection;
  readonly limits?: BrowserScenarioCaptureLimits;
  readonly signal?: AbortSignal;
}

// Conservative allocation accounting includes UTF-16 storage and worst-case
// JSON escaping. Check before schema cloning; never serialize to measure.
const MAX_LISTENER_OWNERS = 2048;
const allocationCost = (value: unknown, remaining: number): number => {
  if (typeof value === "string") return value.length * 8 + 2;
  if (value === null || typeof value !== "object") return 32;
  let cost = 2;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const item = (value as Record<string, unknown>)[key];
    cost += key.length * 8 + 4 + allocationCost(item, remaining - cost);
    if (cost > remaining) break;
  }
  return cost;
};

type EventKind = BrowserScenarioEvent["kind"];
/** Arrival-ordered Playwright event capture with current-step attribution. */
export class PlaywrightScenarioEvents {
  private readonly items: BrowserScenarioEvent[] = [];
  private retainedCost = 0;
  private dropped = 0;
  private readonly omittedKinds = new Map<
    EventKind,
    { count: number; reasons: Set<BrowserScenarioEventBudgetReason> }
  >();
  private readonly omittedNetwork = new Map<
    string,
    {
      readonly kinds: Set<EventKind>;
      readonly reasons: Set<BrowserScenarioEventBudgetReason>;
    }
  >();
  private stepIndex = 0;
  private sequence = 0;
  private readonly enabled: ReadonlySet<EventName>;
  private readonly secrets: BrowserScenarioSecrets;
  private readonly limits: BrowserScenarioCaptureLimits;
  private readonly ownsContext: boolean;
  private pages = new WeakSet<Page>();
  private readonly incompleteFamilies = new Set<EventName>();
  private readonly network: PlaywrightScenarioNetwork | undefined;
  private stopNetwork: (() => void) | undefined;
  private readonly stopListeners = new Map<object, Set<() => void>>();
  private sealed = false;

  constructor(options: EventCaptureOptions) {
    const network = options.network ?? {
      request_body: false,
      response_body: false,
      header_values: false,
    };
    this.enabled = new Set(options.enabled);
    if (network.request_body || network.response_body || network.header_values)
      this.enabled = new Set([...this.enabled, "network"]);
    this.secrets = options.secrets;
    this.limits = options.limits ?? DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS;
    this.ownsContext = options.ownsContext === true;
    this.pages.add(options.page);
    if (this.ownsContext && this.enabled.size > 0) {
      const context = options.context ?? options.page.context();
      const onPage = (page: Page) => this.popup(page);
      context.on("page", onPage);
      this.retainListener(context, () => context.off("page", onPage));
    }
    if (this.enabled.has("network")) {
      const context = options.context ?? options.page.context();
      const collector = new PlaywrightScenarioNetwork({
        selection: network,
        limits: this.limits,
        secrets: options.secrets,
        emit: (event) => this.push(event),
        admitText: (kind, values) => this.admitProducerText(kind, values, true),
        admitContentBody: (input) => this.admitContentBody(input),
        omitNetwork: (id, kind, reason) => this.omitNetwork(id, kind, reason),
        omitEvent: (kind, reason) => this.omitEvent(kind, reason),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      this.network = collector;
      const inScope = (request: Request): boolean => {
        if (this.ownsContext) return true;
        try {
          return this.pages.has(request.frame().page());
        } catch (cause: unknown) {
          // Initial popup navigations can lack a frame. Never guess ownership
          // from a URL in a shared context; connect captures are attach-limited.
          void cause;
          return false;
        }
      };
      const onRequest = (request: Request) => {
        if (inScope(request)) collector.request(request);
      };
      const onResponse = (response: Response) => {
        if (inScope(response.request())) collector.response(response);
      };
      const onFailed = (request: Request) => {
        if (inScope(request)) collector.failed(request);
      };
      const onFinished = (request: Request) => {
        if (inScope(request)) collector.finished(request);
      };
      context.on("request", onRequest);
      context.on("response", onResponse);
      context.on("requestfailed", onFailed);
      context.on("requestfinished", onFinished);
      this.stopNetwork = () => {
        context.off("request", onRequest);
        context.off("response", onResponse);
        context.off("requestfailed", onFailed);
        context.off("requestfinished", onFinished);
      };
    }
    this.observePage(options.page);
  }

  setStep(index: number): void {
    this.stepIndex = index;
  }

  nextSequence(): number {
    return this.sequence + 1;
  }

  lastSequence(): number {
    return this.sequence;
  }

  /** Drain selected network content and freeze the result before browser teardown. */
  async finish(): Promise<void> {
    this.stopNetwork?.();
    this.stopNetwork = undefined;
    for (const owner of this.stopListeners.keys()) this.releaseListeners(owner);
    this.pages = new WeakSet<Page>();
    try {
      await this.network?.finish();
    } finally {
      this.sealed = true;
    }
  }

  /** Report selected popup event families with unrecoverable pre-discovery gaps. */
  limitations(): readonly string[] {
    const popupGaps = [...this.incompleteFamilies].map(
      (family) =>
        `Popup ${family} events before Page discovery are unavailable; later events are retained.`,
    );
    const gaps = [...popupGaps, ...(this.network?.limitations() ?? [])];
    if (this.dropped > 0)
      gaps.push(
        "Browser event collection reached a selected resource budget; per-kind omissions and affected network transaction IDs are listed in events.omissions, and event coverage is incomplete.",
      );
    return this.enabled.has("network") && !this.ownsContext
      ? [
          "Shared-context network capture excludes requests without a known root or descendant Page frame.",
          ...gaps,
        ]
      : gaps;
  }

  result(): {
    readonly retained: number;
    readonly dropped: number;
    readonly items: readonly BrowserScenarioEvent[];
    readonly omissions: BrowserScenarioEventOmissions;
  } {
    const omittedKinds = new Map(
      [...this.omittedKinds].map(
        ([kind, omission]) =>
          [
            kind,
            { count: omission.count, reasons: new Set(omission.reasons) },
          ] as const,
      ),
    );
    return {
      retained: this.items.length,
      dropped: this.dropped,
      items: this.items,
      omissions: {
        by_kind: [...omittedKinds]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([kind, omission]) => ({
            kind,
            count: omission.count,
            reasons: [...omission.reasons].sort(),
          })),
        network_transactions: [...this.omittedNetwork]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([transaction_id, omission]) => ({
            transaction_id,
            omitted_kinds: [...omission.kinds].sort(),
            reasons: [...omission.reasons].sort(),
          })),
        network_transaction_range:
          this.network?.omittedTransactionRange() ?? null,
      },
    };
  }

  private push(event: UnindexedEvent): BrowserScenarioEventAdmission {
    this.sequence += 1;
    const cost =
      allocationCost(event, this.limits.max_event_allocation_bytes) + 128;
    const reason = this.admissionReason(cost);
    if (this.sealed || reason !== undefined) {
      const finalReason = reason ?? "max-events";
      this.omitEvent(event.kind, finalReason);
      return {
        status: "omitted",
        sequence: this.sequence,
        reason: finalReason,
      };
    }
    this.retainedCost += cost;
    const parsed = browserScenarioEventSchema.parse({
      ...event,
      sequence: this.sequence,
      step_index: this.stepIndex,
    });
    this.items.push(parsed);
    return { status: "retained", sequence: this.sequence };
  }

  private admitText(kind: EventKind, ...values: readonly string[]): boolean {
    return this.admitProducerText(kind, values, false).status === "retained";
  }

  /** Admit conservative output cost before running redaction or cloning. */
  private admitProducerText(
    kind: EventKind,
    values: Iterable<string>,
    networkMetadata: boolean,
  ): BrowserScenarioEventAdmission {
    let cost = 4096;
    for (const value of values) {
      cost += this.secrets.redactionAllocationCost(value.length);
    }
    const reason =
      networkMetadata &&
      cost > this.limits.max_network_metadata_allocation_bytes
        ? "max-network-metadata-allocation-bytes"
        : this.admissionReason(cost);
    if (reason !== undefined) {
      this.sequence += 1;
      this.omitEvent(kind, reason);
      return { status: "omitted", sequence: this.sequence, reason };
    }
    return { status: "retained", sequence: this.sequence + 1 };
  }

  private admissionReason(
    cost: number,
  ): BrowserScenarioEventBudgetReason | undefined {
    if (this.sealed || this.items.length >= this.limits.max_events)
      return "max-events";
    if (cost > this.limits.max_event_allocation_bytes)
      return "max-event-allocation-bytes";
    if (cost > this.limits.max_total_event_allocation_bytes - this.retainedCost)
      return "max-total-event-allocation-bytes";
    return undefined;
  }

  private admitContentBody(input: {
    readonly transactionId: string;
    readonly sourceEventSequence: number;
    readonly phase: "request" | "response";
    readonly headers: BrowserNetworkHeaders;
    readonly observedBytes: number;
    readonly allocationBytes: number;
    readonly mediaType: string | undefined;
  }): BrowserScenarioEventAdmission {
    const kind = "network-content";
    const eventCost =
      allocationCost(
        {
          kind,
          sequence: this.sequence + 1,
          step_index: this.stepIndex,
          transaction_id: input.transactionId,
          source_event_sequence: input.sourceEventSequence,
          phase: input.phase,
          headers: input.headers,
          body: {
            state: "captured",
            representation:
              input.phase === "request"
                ? "browser-exposed-request-bytes"
                : "playwright-response-body-bytes",
            encoding: "base64",
            content: null,
            bytes: input.observedBytes,
            sha256: "0".repeat(64),
            media_type: null,
            redacted: false,
          },
        },
        this.limits.max_event_allocation_bytes,
      ) -
      64 +
      input.allocationBytes +
      (input.mediaType === undefined
        ? 0
        : Math.max(
            input.mediaType.length * 8 + 2,
            this.secrets.redactionAllocationCost(input.mediaType.length),
          )) +
      128;
    const reason = this.admissionReason(eventCost);
    if (reason !== undefined) {
      this.sequence += 1;
      this.omitEvent(kind, reason);
      return { status: "omitted", sequence: this.sequence, reason };
    }
    return { status: "retained", sequence: this.sequence + 1 };
  }

  private omitEvent(
    kind: EventKind,
    reason: BrowserScenarioEventBudgetReason,
  ): void {
    this.dropped += 1;
    let omission = this.omittedKinds.get(kind);
    if (omission === undefined) {
      omission = { count: 0, reasons: new Set() };
      this.omittedKinds.set(kind, omission);
    }
    omission.count += 1;
    omission.reasons.add(reason);
  }

  private omitNetwork(
    transactionId: string,
    kind: EventKind,
    reason: BrowserScenarioEventBudgetReason,
  ): void {
    let omission = this.omittedNetwork.get(transactionId);
    if (omission === undefined) {
      omission = { kinds: new Set(), reasons: new Set() };
      this.omittedNetwork.set(transactionId, omission);
    }
    omission.kinds.add(kind);
    omission.reasons.add(reason);
  }

  private admitOwner(kind: EventKind): boolean {
    if (this.stopListeners.size < MAX_LISTENER_OWNERS) return true;
    this.sequence += 1;
    this.omitEvent(kind, "max-listener-owners");
    return false;
  }

  private retainListener(owner: object, stop: () => void): void {
    let stops = this.stopListeners.get(owner);
    if (stops === undefined) {
      stops = new Set();
      this.stopListeners.set(owner, stops);
    }
    stops.add(stop);
  }

  private releaseListeners(owner: object): void {
    const stops = this.stopListeners.get(owner);
    this.stopListeners.delete(owner);
    for (const stop of stops ?? []) stop();
  }

  private observePage(page: Page): void {
    if (this.enabled.size > 0) {
      const onClose = () => {
        this.releaseListeners(page);
      };
      page.on("close", onClose);
      this.retainListener(page, () => page.off("close", onClose));
    }

    if (this.enabled.has("console")) {
      const onConsole = (message: ConsoleMessage) => this.console(message);
      page.on("console", onConsole);
      this.retainListener(page, () => page.off("console", onConsole));
    }
    if (this.enabled.has("page-errors")) {
      const onError = (error: Error) => {
        if (!this.admitText("page-error", error.message, error.stack ?? ""))
          return;
        this.push({
          kind: "page-error",
          message: this.secrets.redact(error.message),
          stack:
            error.stack === undefined ? null : this.secrets.redact(error.stack),
        });
      };
      page.on("pageerror", onError);
      this.retainListener(page, () => page.off("pageerror", onError));
    }
    if (this.enabled.has("websockets")) {
      const onWebSocket = (socket: WebSocket) => this.webSocket(socket);
      page.on("websocket", onWebSocket);
      this.retainListener(page, () => page.off("websocket", onWebSocket));
    }
    if (this.enabled.has("frames")) {
      const onAttached = (frame: Frame) => this.frame("frame-attached", frame);
      const onDetached = (frame: Frame) => this.frame("frame-detached", frame);
      const onNavigated = (frame: Frame) =>
        this.frame("frame-navigated", frame);
      page.on("frameattached", onAttached);
      page.on("framedetached", onDetached);
      page.on("framenavigated", onNavigated);
      this.retainListener(page, () => page.off("frameattached", onAttached));
      this.retainListener(page, () => page.off("framedetached", onDetached));
      this.retainListener(page, () => page.off("framenavigated", onNavigated));
    }
    if (this.enabled.has("workers")) {
      const onWorker = (worker: Worker) => this.worker(worker);
      page.on("worker", onWorker);
      this.retainListener(page, () => page.off("worker", onWorker));
    }
    // Any selected family needs descendant discovery in shared contexts.
    // Popup lifecycle records remain gated on their own selector below.
    if (this.enabled.size > 0) {
      const onPopup = (popup: Page) => this.popup(popup);
      page.on("popup", onPopup);
      this.retainListener(page, () => page.off("popup", onPopup));
    }
    if (this.enabled.has("downloads")) {
      const onDownload = (download: Download) => this.download(download);
      page.on("download", onDownload);
      this.retainListener(page, () => page.off("download", onDownload));
    }
  }

  private safeUrl(value: string) {
    return this.secrets.sanitizeUrl(value);
  }

  private console(message: ConsoleMessage): void {
    const rawText = message.text();
    const location = message.location();
    if (!this.admitText("console", rawText, location.url, message.type()))
      return;
    this.push({
      kind: "console",
      level: this.secrets.redact(message.type()),
      text: this.secrets.redact(rawText),
      url: location.url === "" ? null : this.safeUrl(location.url),
    });
  }

  private webSocket(socket: WebSocket): void {
    if (!this.admitOwner("websocket-opened")) return;
    if (!this.admitText("websocket-opened", socket.url())) return;
    const url = this.safeUrl(socket.url());
    this.push({ kind: "websocket-opened", url });
    const onSent = ({ payload }: { payload: string | Buffer }) =>
      this.webSocketFrame("websocket-frame-sent", url, payload);
    const onReceived = ({ payload }: { payload: string | Buffer }) =>
      this.webSocketFrame("websocket-frame-received", url, payload);
    const onClose = () => {
      this.push({ kind: "websocket-closed", url });
      this.releaseListeners(socket);
    };
    socket.on("framesent", onSent);
    socket.on("framereceived", onReceived);
    socket.on("close", onClose);
    this.retainListener(socket, () => socket.off("framesent", onSent));
    this.retainListener(socket, () => socket.off("framereceived", onReceived));
    this.retainListener(socket, () => socket.off("close", onClose));
  }

  private webSocketFrame(
    kind: "websocket-frame-sent" | "websocket-frame-received",
    url: SanitizedBrowserUrl,
    payload: string | Buffer,
  ): void {
    const bytes = Buffer.byteLength(payload);
    const isText = typeof payload === "string";
    if (!isText) {
      this.push({
        kind,
        url,
        payload_type: "binary",
        payload_bytes: bytes,
        payload_text: null,
        truncated: false,
      });
      return;
    }
    if (!this.admitText(kind, payload)) return;
    const text = this.secrets.redact(payload);
    this.push({
      kind,
      url,
      payload_type: "text",
      payload_bytes: bytes,
      payload_text: text,
      truncated: false,
    });
  }

  private frame(
    kind: "frame-attached" | "frame-detached" | "frame-navigated",
    frame: Frame,
  ): void {
    if (!this.admitText(kind, frame.url(), frame.name())) return;
    this.push({
      kind,
      url: frame.url() === "" ? null : this.safeUrl(frame.url()),
      name: frame.name() === "" ? null : this.secrets.redact(frame.name()),
    });
  }

  private worker(worker: Worker): void {
    if (
      !this.admitOwner("worker-created") ||
      !this.admitText("worker-created", worker.url())
    )
      return;
    const details = {
      url: this.safeUrl(worker.url()),
      name: null,
    };
    this.push({ kind: "worker-created", ...details });
    const onClose = () => {
      this.push({ kind: "worker-closed", ...details });
      this.releaseListeners(worker);
    };
    worker.on("close", onClose);
    this.retainListener(worker, () => worker.off("close", onClose));
  }

  private popup(page: Page): void {
    if (this.pages.has(page)) return;
    if (
      !this.admitOwner("popup-opened") ||
      !this.admitText("popup-opened", page.url())
    )
      return;
    this.pages.add(page);
    for (const family of [
      "frames",
      "workers",
      "websockets",
      "downloads",
    ] as const)
      if (this.enabled.has(family)) this.incompleteFamilies.add(family);
    const opened = {
      url: page.url() === "" ? null : this.safeUrl(page.url()),
      name: null,
    };
    if (this.enabled.has("popups")) {
      this.push({ kind: "popup-opened", ...opened });
      const onClose = () => {
        if (!this.admitText("popup-closed", page.url())) return;
        this.push({
          kind: "popup-closed",
          url: page.url() === "" ? null : this.safeUrl(page.url()),
          name: null,
        });
      };
      page.on("close", onClose);
      this.retainListener(page, () => page.off("close", onClose));
    }
    this.observePage(page);
  }

  private download(download: Download): void {
    if (
      this.admitText(
        "download-cancelled",
        download.suggestedFilename(),
        download.url(),
      )
    )
      this.push({
        kind: "download-cancelled",
        suggested_filename: this.secrets.redact(download.suggestedFilename()),
        url: this.safeUrl(download.url()),
      });
    void download.cancel().catch((cause: unknown) => {
      // best-effort cleanup: download cancellation must not reject unhandled.
      void cause;
    });
  }
}
