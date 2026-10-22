import type { JsonValue } from "../jsonValue.js";
import {
  compareUnicodeCodePoints as compare,
  compositeKey,
} from "../unicodeCodePointOrder.js";
import {
  IDENTITY_NAMES,
  at,
  collectionPathOf,
  identifies,
  isObject,
  isParam,
  isQueryPost,
  isStateWrite,
  jsonBytes,
  hasPrototypeKey,
  lastSegmentValue,
  listItems,
  normalizedPath,
  locateItem,
  locateList,
  rootOf,
  scalarText,
  segmentsOf,
  apiBaseLengths,
  writeSpanCheck,
  type ExtractedState,
  type JsonObject,
  type RecordedViewReason,
  type StateBudget,
  type StateDocument,
  type StateEntity,
  type StateRecordFacts,
  type StateTimeline,
  type StateToolFacts,
  type StateType,
  type StateView,
} from "./environmentStateRules.js";
import { ENTRY_BYTES, textBytes } from "./webNetworkRouteTemplates.js";
import {
  classifyEntityChanges,
  compareObservedEntities,
  mergeObservedEntity,
  type ObservedEntity,
  type StateObservation,
} from "./environmentStateMerge.js";
import {
  checkItemPlan,
  checkListPlan,
  type StateGateContext,
  type StatePlan,
} from "./environmentStateGate.js";
import { StateWriteCutoffs } from "./environmentStateWriteCutoffs.js";

class StateBudgetExhausted extends Error {}

type Candidate = Pick<StatePlan, "tool" | "item" | "type">;

interface ObservedMembership {
  record: StateRecordFacts;
  readonly ids: Set<string>;
  capacity: number;
}

const entityKey = (type: string, collection: string, id: string): string =>
  compositeKey([type, collection, id]);

const requestLine = (record: StateRecordFacts): string =>
  record.path + (record.query ?? "");

/** Derive the init state and render plans from manifest tools and timeline-ordered records. */
export class EnvironmentStateExtraction {
  readonly #tools: readonly StateToolFacts[];
  readonly #timeline: StateTimeline;
  readonly #budget: StateBudget;
  readonly #position: ReadonlyMap<number, number>;
  readonly #byOrdinal: ReadonlyMap<number, StateRecordFacts>;
  readonly #writes: readonly StateRecordFacts[];
  readonly #writeWithin: ReturnType<typeof writeSpanCheck>;
  readonly #bases: ReadonlyMap<string, number>;
  #writeCutoffs: StateWriteCutoffs | undefined;
  readonly #initLimits = new Map<string, StateRecordFacts | undefined>();
  readonly #identity = new Map<
    string,
    { readonly field: string; readonly basis: StateType["id_basis"] }
  >();
  readonly #views = new Map<string, StateView>();
  readonly #plans: StatePlan[] = [];
  readonly #entities = new Map<string, ObservedEntity>();
  readonly #volatile = new Map<string, Set<string>>();
  /** Types with a value that changed across a recorded write, which may be that write's effect. */
  readonly #rewritten = new Set<string>();
  readonly #merged = new Map<string, StateEntity>();
  /** Merged entities by type and collection, built once on first use after merging. */
  #collections: Map<string, StateEntity[]> | undefined;

  constructor(input: {
    readonly tools: readonly StateToolFacts[];
    readonly records: readonly StateRecordFacts[];
    readonly timeline: StateTimeline;
    readonly budget: StateBudget;
  }) {
    this.#tools = input.tools;
    this.#timeline = input.timeline;
    this.#budget = input.budget;
    this.#position = new Map(
      input.records.map((record, index) => [record.ordinal, index]),
    );
    this.#byOrdinal = new Map(
      input.records.map((record) => [record.ordinal, record]),
    );
    this.#writes = input.records.filter(isStateWrite);
    this.#writeWithin = writeSpanCheck(this.#writes);
    this.#bases = apiBaseLengths(input.tools.map((tool) => tool.path_template));
  }

  /** The extracted state, or null when the representation budget is exhausted. */
  run(): ExtractedState | null {
    try {
      if (this.#writes.length > 0)
        this.#writeCutoffs = new StateWriteCutoffs(
          this.#writes,
          this.#bases,
          (left, right) =>
            this.#position.get(left.ordinal)! <
            this.#position.get(right.ordinal)!,
          (bytes) => this.#retain(bytes),
        );
      const candidates = this.#candidates();
      for (const candidate of candidates.filter((entry) => entry.item))
        this.#planItem(candidate);
      for (const candidate of candidates.filter((entry) => !entry.item))
        this.#planList(candidate);
      for (const plan of this.#plans) this.#observePlan(plan);
      this.#classifyChanges();
      this.#merge();
      const gate = this.#gateContext();
      for (const plan of this.#plans)
        if (this.#rewritten.has(plan.type))
          this.#recorded(plan.tool, "fields-differ");
        else
          this.#views.set(
            plan.tool.name,
            plan.item ? checkItemPlan(gate, plan) : checkListPlan(gate, plan),
          );
      const documents = this.#documents(candidates);
      for (const { tool } of candidates)
        if (!this.#views.has(tool.name)) this.#recorded(tool, "not-entity");
      return this.#result(documents);
    } catch (cause: unknown) {
      if (cause instanceof StateBudgetExhausted) return null;
      throw cause;
    }
  }

  #retain(bytes: number): void {
    if (!this.#budget.retain(bytes)) throw new StateBudgetExhausted();
  }

  /** Parse one body and hand it to `use` before its temporary work is dropped; unusable bodies arrive undefined. */
  #withBody<T>(ordinal: number, use: (body: JsonValue | undefined) => T): T {
    const parsed = this.#budget.body(ordinal);
    if (parsed === null) throw new StateBudgetExhausted();
    try {
      return use(
        parsed.kind === "json" && !hasPrototypeKey(parsed.value)
          ? parsed.value
          : undefined,
      );
    } finally {
      this.#budget.release();
    }
  }

  #recorded(tool: StateToolFacts, reason: RecordedViewReason): void {
    this.#views.set(tool.name, { tool: tool.name, shape: "recorded", reason });
  }

  /** GET tools may render from state; query POSTs stay recorded. */
  #candidates(): Candidate[] {
    const candidates: Candidate[] = [];
    for (const tool of this.#tools) {
      if (isQueryPost(tool.method, tool.path_template))
        this.#recorded(tool, "query-body");
      if (tool.method !== "GET") continue;
      const segments = segmentsOf(tool.path_template);
      const item = segments.length > 0 && isParam(segments.at(-1)!);
      candidates.push({
        tool,
        item,
        type: item
          ? `/${segments.slice(0, -1).join("/")}`
          : normalizedPath(tool.path_template),
      });
    }
    return candidates;
  }

  /** The first write whose root relates to the template's bounds its init recordings. */
  #initLimit(template: string): StateRecordFacts | undefined {
    if (this.#writeCutoffs === undefined) return undefined;
    if (this.#initLimits.has(template)) return this.#initLimits.get(template);
    const first = this.#writeCutoffs.first(rootOf(template, this.#bases));
    this.#retain(ENTRY_BYTES + textBytes(template.length));
    this.#initLimits.set(template, first);
    return first;
  }

  /** Successful recordings that finished before the first related write began. */
  #initRecordings(tool: StateToolFacts, template: string): StateRecordFacts[] {
    const limit = this.#initLimit(template);
    const before = (record: StateRecordFacts): boolean =>
      limit === undefined ||
      (this.#position.get(record.ordinal)! <
        this.#position.get(limit.ordinal)! &&
        (this.#timeline === "record-order" || record.end <= limit.start));
    return tool.record_ordinals
      .map((ordinal) => this.#byOrdinal.get(ordinal))
      .filter(
        (record): record is StateRecordFacts =>
          record !== undefined &&
          record.status !== null &&
          record.status >= 200 &&
          record.status < 300 &&
          before(record),
      )
      .sort(
        (left, right) =>
          this.#position.get(left.ordinal)! -
          this.#position.get(right.ordinal)!,
      );
  }

  #latestPerLine(recordings: readonly StateRecordFacts[]): StateRecordFacts[] {
    const latest = new Map<string, StateRecordFacts>();
    for (const record of recordings) {
      latest.delete(requestLine(record));
      latest.set(requestLine(record), record);
    }
    return [...latest.values()];
  }

  /** A candidate's initial recordings, or undefined after recording that it has none. */
  #initRecordingsOf(candidate: Candidate): StateRecordFacts[] | undefined {
    const recordings = this.#initRecordings(candidate.tool, candidate.type);
    if (recordings.length > 0) return recordings;
    this.#recorded(candidate.tool, "no-init-recording");
    return undefined;
  }

  #addPlan(
    candidate: Candidate,
    pointer: string,
    recordings: readonly StateRecordFacts[],
  ): void {
    this.#plans.push({
      ...candidate,
      pointer,
      recordings,
      latest: this.#latestPerLine(recordings),
    });
  }

  /** Item tools prove a type's identity field by the path value their bodies repeat. */
  #planItem(candidate: Candidate): void {
    const { tool, type } = candidate;
    const recordings = this.#initRecordingsOf(candidate);
    if (recordings === undefined) return;
    let pointer: string | undefined;
    let keys: string[] | undefined;
    for (const record of recordings) {
      const located = this.#withBody(record.ordinal, (body) =>
        body === undefined
          ? null
          : locateItem(body, lastSegmentValue(record.path)),
      );
      if (located === null) {
        this.#recorded(tool, "body-unusable");
        return;
      }
      if (
        located === undefined ||
        (pointer ?? located.pointer) !== located.pointer
      ) {
        this.#recorded(tool, "no-identity");
        return;
      }
      pointer = located.pointer;
      if (keys === undefined) keys = located.keys;
      else {
        const matching = new Set(located.keys);
        keys = keys.filter((key) => matching.has(key));
      }
    }
    const field =
      IDENTITY_NAMES.find((name) => keys?.includes(name) === true) ?? keys?.[0];
    const known = this.#identity.get(type);
    if (
      field === undefined ||
      pointer === undefined ||
      (known !== undefined && known.field !== field)
    ) {
      this.#recorded(tool, "no-identity");
      return;
    }
    this.#identity.set(type, { field, basis: "path-parameter" });
    this.#addPlan(candidate, pointer, recordings);
  }

  /** List tools use the proved field, else the first identity name every non-empty recording's items carry. */
  #planList(candidate: Candidate): void {
    const { tool, type } = candidate;
    const recordings = this.#initRecordingsOf(candidate);
    if (recordings === undefined) return;
    const proved = this.#identity.get(type)?.field;
    let pointer: string | undefined;
    let names: readonly string[] | undefined;
    let sawItems = false;
    for (const record of recordings) {
      const found = this.#withBody(record.ordinal, (body) => {
        if (body === undefined) return null;
        // Every recording must locate the same list, so a later entity envelope is not taken as one.
        const located = locateList(body, proved);
        if (pointer !== undefined && located !== pointer) return undefined;
        const items =
          located === undefined ? undefined : listItems(body, located);
        if (items === undefined) return undefined;
        pointer = located;
        if (items.length > 0) sawItems = true;
        return items.length === 0
          ? (names ?? (proved === undefined ? IDENTITY_NAMES : [proved]))
          : (proved === undefined ? IDENTITY_NAMES : [proved]).filter((name) =>
              identifies(items, name),
            );
      });
      if (found === null || found === undefined) {
        this.#recorded(tool, found === null ? "body-unusable" : "not-entity");
        return;
      }
      names = (names ?? found).filter((name) => found.includes(name));
    }
    const field = names?.[0];
    // An identity name is only inferred from items that carry it; empty lists prove none.
    if (
      field === undefined ||
      pointer === undefined ||
      (proved === undefined && !sawItems)
    ) {
      this.#recorded(tool, "no-identity");
      return;
    }
    if (!this.#identity.has(type))
      this.#identity.set(type, { field, basis: "field-name" });
    this.#addPlan(candidate, pointer, recordings);
  }

  #observePlan(plan: StatePlan): void {
    // Only lists whose observations span a write need membership snapshots, including empty lists.
    const memberships =
      !plan.item &&
      this.#writeWithin(plan.recordings[0]!, plan.recordings.at(-1)!)
        ? new Map<string, ObservedMembership>()
        : undefined;
    for (const record of plan.recordings)
      this.#withBody(record.ordinal, (body) => {
        const located = body === undefined ? undefined : at(body, plan.pointer);
        const objects = plan.item
          ? isObject(located)
            ? [located]
            : []
          : body === undefined
            ? []
            : (listItems(body, plan.pointer) ?? []);
        if (memberships !== undefined)
          this.#observeMembership(plan, record, objects, memberships);
        objects.forEach((object, index) =>
          this.#observe(plan, record, object, index),
        );
      });
  }

  /** Compare one request line's membership before discarding older recordings; reuse its bounded set. */
  #observeMembership(
    plan: StatePlan,
    record: StateRecordFacts,
    objects: readonly JsonObject[],
    memberships: Map<string, ObservedMembership>,
  ): void {
    const line = requestLine(record);
    let previous = memberships.get(line);
    const earlier = previous?.record;
    if (previous === undefined) {
      this.#retain(ENTRY_BYTES * 2 + textBytes(line.length));
      previous = { record, ids: new Set(), capacity: 0 };
      memberships.set(line, previous);
    }
    // Reserve the peak membership representation before growing the set, including numeric ID text.
    if (objects.length > previous.capacity) {
      this.#retain((objects.length - previous.capacity) * ENTRY_BYTES * 4);
      previous.capacity = objects.length;
    }
    const field = this.#identity.get(plan.type)!.field;
    let changed = previous.ids.size !== objects.length;
    for (const object of objects)
      if (!previous.ids.delete(scalarText(object[field])!)) changed = true;
    if (previous.ids.size > 0) changed = true;
    if (earlier !== undefined && changed && this.#writeWithin(earlier, record))
      this.#rewritten.add(plan.type);
    previous.ids.clear();
    for (const object of objects) previous.ids.add(scalarText(object[field])!);
    previous.record = record;
  }

  /** Record one observed entity object; a value that changes between one tool's own observations is volatile. */
  #observe(
    plan: StatePlan,
    record: StateRecordFacts,
    object: JsonObject,
    index: number,
  ): void {
    const field = this.#identity.get(plan.type)!.field;
    const id = scalarText(object[field]);
    if (id === undefined) return;
    const collection = collectionPathOf(record, plan.item);
    const key = entityKey(plan.type, collection, id);
    const position = this.#position.get(record.ordinal)!;
    let entity = this.#entities.get(key);
    if (entity === undefined) {
      this.#retain(ENTRY_BYTES * 4 + textBytes(key.length));
      entity = {
        type: plan.type,
        collection,
        id,
        order: [position, index],
        observations: [],
      };
      this.#entities.set(key, entity);
    } else {
      // Plans are observed item tools first, so keep the earliest sighting in timeline order.
      const [first, at] = entity.order;
      if (position < first || (position === first && index < at))
        entity.order = [position, index];
    }
    this.#retain(ENTRY_BYTES + jsonBytes(object));
    entity.observations.push({
      position,
      ordinal: record.ordinal,
      tool: plan.tool.name,
      item: plan.item,
      object,
    });
  }

  /** A change across any recorded write rewrites the type; one between repeats of a line with no write is volatile. */
  #classifyChanges(): void {
    const recordOf = (observation: StateObservation): StateRecordFacts =>
      this.#byOrdinal.get(observation.ordinal)!;
    const changes = classifyEntityChanges(
      this.#entities.values(),
      (observation) => [observation.tool, requestLine(recordOf(observation))],
      (earlier, later) => this.#writeWithin(recordOf(earlier), recordOf(later)),
    );
    for (const type of changes.rewritten) this.#rewritten.add(type);
    for (const [type, names] of changes.volatile)
      this.#volatile.set(type, names);
  }

  #merge(): void {
    for (const entity of [...this.#entities.values()].sort(
      compareObservedEntities,
    ))
      this.#merged.set(
        entityKey(entity.type, entity.collection, entity.id),
        mergeObservedEntity(entity),
      );
  }

  #gateContext(): StateGateContext {
    return {
      withBody: (ordinal, use) => this.#withBody(ordinal, use),
      retain: (bytes) => this.#retain(bytes),
      entity: (type, collection, id) =>
        this.#merged.get(entityKey(type, collection, id)),
      inCollection: (type, collection) => this.#inCollection(type, collection),
      volatileOf: (type) => this.#volatileOf(type),
      idField: (type) => this.#identity.get(type)!.field,
    };
  }

  #volatileOf(type: string): ReadonlySet<string> {
    return this.#volatile.get(type) ?? new Set<string>();
  }

  #inCollection(type: string, collection: string): StateEntity[] {
    if (this.#collections === undefined) {
      this.#retain(ENTRY_BYTES * (this.#merged.size + 1));
      this.#collections = new Map();
      for (const entity of this.#merged.values()) {
        const key = JSON.stringify([entity.type, entity.collection]);
        const members = this.#collections.get(key);
        if (members === undefined) this.#collections.set(key, [entity]);
        else members.push(entity);
      }
    }
    return this.#collections.get(JSON.stringify([type, collection])) ?? [];
  }

  /** A written path whose read is not an entity holds one document value: its latest init recording. */
  #documents(candidates: readonly Candidate[]): StateDocument[] {
    const written = new Set(
      this.#tools
        .filter(
          (tool) =>
            ["POST", "PUT", "PATCH"].includes(tool.method) &&
            !isQueryPost(tool.method, tool.path_template),
        )
        .map((tool) => tool.path_template),
    );
    const documents: StateDocument[] = [];
    for (const { tool, item } of candidates) {
      const current = this.#views.get(tool.name);
      const entityless =
        current === undefined ||
        (current.shape === "recorded" &&
          (current.reason === "not-entity" ||
            current.reason === "no-identity"));
      if (item || !entityless || !written.has(tool.path_template)) continue;
      const latest = this.#latestPerLine(
        this.#initRecordings(tool, tool.path_template),
      );
      if (latest.length !== 1) {
        if (latest.length > 1) this.#recorded(tool, "query-varies");
        continue;
      }
      const record = latest[0]!;
      const value = this.#withBody(record.ordinal, (body) => body);
      if (value === undefined) {
        this.#recorded(tool, "body-unusable");
        continue;
      }
      this.#retain(
        ENTRY_BYTES + jsonBytes(value) + textBytes(record.path.length),
      );
      documents.push({
        tool: tool.name,
        path: record.path,
        value,
        record_ordinal: record.ordinal,
      });
      this.#views.set(tool.name, {
        tool: tool.name,
        shape: "document",
        checked_record_ordinals: [record.ordinal],
      });
    }
    return documents.sort((left, right) => compare(left.tool, right.tool));
  }

  /** Types and entities that at least one state-backed view renders; view values only for those views. */
  #result(documents: StateDocument[]): ExtractedState {
    const backed = new Set<string>();
    const backedTypes = new Set<string>();
    for (const view of this.#views.values())
      if (view.shape === "item" || view.shape === "list") {
        this.#retain(ENTRY_BYTES);
        backed.add(view.tool);
        if (!backedTypes.has(view.type)) {
          this.#retain(ENTRY_BYTES);
          backedTypes.add(view.type);
        }
      }
    const types = [...this.#identity.entries()]
      .filter(([type]) => backedTypes.has(type))
      .map(([type, { field, basis }]): StateType => ({
        collection_template: type,
        id_field: field,
        id_basis: basis,
        init_before_ordinal: this.#initLimit(type)?.ordinal ?? null,
        volatile_fields: [...this.#volatileOf(type)].sort(compare),
      }))
      .sort((left, right) =>
        compare(left.collection_template, right.collection_template),
      );
    const typed = new Set(types.map((type) => type.collection_template));
    return {
      types,
      entities: [...this.#merged.values()]
        .filter((entity) => typed.has(entity.type))
        .map((entity) => ({
          ...entity,
          view_fields: entity.view_fields.filter((view) =>
            backed.has(view.tool),
          ),
        })),
      documents,
      views: this.#tools.flatMap((tool) => {
        const view = this.#views.get(tool.name);
        return view === undefined ? [] : [view];
      }),
    };
  }
}
