import { API_SURFACE_EXAMPLE } from "./analysisViewApiSurfaceExample.js";
import { ENVIRONMENT_MANIFEST_EXAMPLE } from "./analysisViewEnvironmentManifestExample.js";
import {
  analysisViewResultSchema,
  inspectAnalysisViewInputSchema,
} from "../domain/analysisView/analysisView.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

const RETAINED_EXAMPLE_ID = `ev_${"a".repeat(64)}`;

/** Selected views of completed layout, JavaScript, native, inventory, WASM, Mach-O, Interface Builder and web network Evidence. */
export const ANALYSIS_VIEW_TOOL_CONTRACTS = [
  {
    name: "inspect_analysis_view",
    ...toolContractMetadata("inspect_analysis_view"),
    kind: "application",
    description:
      'Inspect selected views of completed Go build metadata, binary-layout, JavaScript application, native analyze_function, inspect_artifact, inventory_artifact, inspect_wasm_artifact, inspect_macho, decode_interface_builder, inspect_evm_interface, inspect_managed_artifact, inspect_managed_members, inspect_android_package, inspect_dart_aot, inspect_il2cpp_metadata, inspect_model_artifact or inspect_web_network_capture Evidence without repeating analysis. Historical capture summaries return identity and counts without bodies or archive inventories. Capture views page retained records: view {kind: "capture", detail: "preview" | "complete", offset: 0, limit: 20}; preview selects recorded headline fields and binary descriptors, complete returns exact records with all sidecars. Offsets follow the selected parent record order, preserving original producer ordinals. Paging never reopens the source or reruns the decoder. Go metadata uses kind go, collection dependencies/settings, exact paths/keys or indices, fields and pagination. Row index refers to the original collection; empty selections return no rows, and dependency coverage remains unknown. For inspect_pcap_capture parents, kind pcap pages endpoints, dns-queries, tls-sni, protocols, http-uris or unattributed-addresses. Select an exact query for dns-addresses, or a tshark/capinfos stream for UTF-16 diagnostics text. Page totals count retained facts; source coverage remains explicit. Qlog summaries keep profile/scope and counts; kind qlog pages traces, streams, loss-declarations, incomplete-records, contributions, ranges or final-sizes. Except traces, select trace_index; stream-specific facets also require exact stream_id and direction. Facts retain all-recorded-events-before-selection scope, and interval overlap or endpoint loss declarations do not prove retransmission or network loss. The api-surface view groups retained HAR requests by method, origin and format-rule path template; templated segments are inferences. It reads no headers or bodies and reports no query values. The environment-manifest view projects the same HAR requests on the primary origin (most JSON-like records) into a replayable tool surface: view {kind: "environment-manifest", template_rules: ["after-uid-literal", "opaque-token", "sibling-variance"], include_query_parameter_names: true}. Each tool has a deterministic name, a path template and parameters from the four format rules plus the selected opt-in rules, observed query parameter names, a value-free body shape for POST/PUT/PATCH, status and content-type sets and record ordinals; records are pointers into the parent, excluded groups carry a reason and three fixed unknowns are always stated. Templates, parameters and names are inferences; the view copies no header, cookie or body values and refuses parents inspected with sensitive values. A capture_browser_scenario parent that selected response bodies or header values projects the same way, one record per network transaction in request order; it relies on capture-time redaction of declared secrets instead of that refusal, and a transaction whose URL was redacted is left unrepresented. The environment-state view extracts, from the same parents, the initial state the recorded reads observed: view {kind: "environment-state", template_rules: [...]} with the rules of the manifest it accompanies. It reads response bodies recorded before the first related write and reports entity types with an identity field (proved by a path parameter or inferred from a field name), entities in collection order with per-view values where views differ, documents for non-parameterized non-entity paths written by POST/PUT/PATCH (item-shaped and delete-only paths stay recorded), and a render plan per read tool: item and list views reproduce their latest recordings from the state, and every other read tool is a recorded view with a reason. Types and identity are inferences; values are recorded data, so it refuses parents inspected with sensitive values, and a scenario parent must have selected response bodies; its values keep the capture redaction markers, and a write whose URL it redacted ends the state of every type. For a retained record use source: {kind: "retained-evidence", evidence_id: "<parent_evidence_id>"}. Use normalized_result.parent_evidence_id from a summary receipt. Source kind is required. Portable source uses {kind: "inline", evidence: <complete Evidence>}. A completed Evidence JSON file on this host uses {kind: "evidence-file", path: "<absolute path>"}: REA reads and authenticates it, then projects it like retained Evidence, so a large capture is bounded by the file reader rather than by inline-input accounting. For layout, JavaScript, inventory, WASM, Mach-O, Interface Builder, EVM, managed artifact, Android package and Dart AOT sources, request a summary with view: {kind: "summary"}; summary is a view kind and has no facet. The WASM summary gives validation, counts, WAT digest/length, tool profile and execution/network states without reading WAT text. Select a layout mitigations/linkage facet, one section/symbol/module, or a stable page. Module pages include assets, bundled and source modules; use node_id for ambiguous or unavailable paths. Typed module references use view {kind: "javascript", collection: "modules", projection: "references", where: {path: "main.js", kind: "javascript-module"}, offset: 0, limit: 64}; where matches exact retained strings (null selects unavailable paths). Rows include canonical identity, retained source-range count and observation support states. Source coverage and selection remain explicit; exhausting matching rows does not prove runtime loading or complete analysis. For exact file/native facts and processing gaps, use view {kind: "javascript-facts", where: {paths: ["package.json"]}, property_keys: ["name", "operation", "analysis_status"]}. Rows page original observations with canonical identities and Evidence; missing properties remain omitted. Paths match recorded artifact-path/source-range locations; optional kinds filter nodes. To discover field names without values, opt into include_available_property_keys: true with property_keys: []. Canonical identity and Evidence are separate from properties; keep each node_id/observation_id pair together when composing results. Inventory uses view: {kind: "inventory", collection: "occurrences", logical_paths: ["package.json"], offset: 0, limit: 64}. Inventory views page nodes, occurrences, edges or integrity contradictions. Occurrences accept exact logical_paths and occurrence_ids; nodes accept artifact_ids. Batch filters intersect (omitted means all available, [] means none); fields selects columns while retaining identity links. source_complete describes retained graph membership; source_coverage describes producer coverage, including unknown encrypted PCK directories. Page exhaustion does not prove absence in a partial source. WASM views use kind wasm and facet sections/imports/exports/candidates/glue/wat/headers/details/tool_profile; text facets use UTF-16 code units and source forms remain exact. Mach-O views use kind macho and facet entrypoints/architectures/build_metadata/load_commands/dependencies/imports/exports/segments/provenance; source_exhaustive false means unreturned rows may exist. Interface Builder views use kind interface-builder and collection documents/nodes/edges/coverage; nodes and edges accept an exact document relative_path. EVM summary returns all inferred interface candidates, carrier/decoded identities and explicit unknowns without hex or duplicate stdout. EVM views use kind evm and facet functions/bytecode_hex/stdout/stderr; function pages preserve the original candidate rows, and text offsets/limits count UTF-16 code units (hex has two characters per decoded byte). Exhausting candidate pages does not establish global interface completeness. Managed artifact summaries preserve complete identity/classification, metadata status, module/MVID, frameworks, coverage and limitations without unrelated inventories. Managed pages use kind managed and collection references/resources/attributes, retaining source coverage and build-local token scope; page exhaustion does not establish complete metadata. Managed member summaries keep identity, selection with unmatched names, coverage and per-collection counts; managed-members pages use collection types/exported_types/fields/methods/member_refs/call_edges/field_accesses/user_strings and carry the source selection and coverage. Android package summaries retain all declarations, engine identity and counts without decoded manifest text. Android manifest pages use kind android, facet manifest, offset and limit in UTF-16 code units; source_status preserves partial decoded coverage even when the retained text page is exhausted. Dart AOT summary preserves target/ABI/library identity, snapshot headers and pool lower bounds. String pages use kind dart-aot, collection package_uris/dart_uris/class_like_tokens; source coverage remains partial when the producer says partial. Protobuf views use kind protobuf, collection bodies/frames/fields, with record_ordinals, body_pointers and fields; field pages also select frame_indices, field_ids, field_numbers or schema_names. Byte identity, offset basis and body status remain present. Text and schema_value are opt-in page columns. Model views use kind model-artifact and collection metadata (keys), tensors (names/types) or types (derived totals), with indices, fields and paging. Header SHA-256 scopes declarations; full-file identity remains unknown unless full hashing was selected. Arrays retain typed eight-element previews with explicit omissions. IL2CPP metadata views use kind il2cpp-metadata and collection sections/images/types/methods/fields/properties/events/parameters/string_literals/code_gen_modules/method_addresses/return_types/field_types/parameter_types. Select indices, fields and pages; named rows accept names, types also accept image_indices/namespaces/declaring_types, and methods/members accept declaring_types. Parameters and parameter_types accept method_indices; code_gen_modules accept image_indices; method_addresses accept addresses/states, preserving every folded alternative. Row index is scoped to the metadata digest; native pages add binary_source. Uncollected native tables have null counts and remain unavailable. Desktop directory views use kind desktop-application and collection files/omissions/candidates/components/next_probes, with fields and pagination; files and omissions accept exact paths or their stable IDs, and candidates accept families. Source coverage and stable row IDs remain available. Native inventory Evidence from list_names, list/search_procedures or list/search_strings uses view: {kind: "native-inventory", offset: 0, limit: 64, fields: ["value"]}. Rows keep source_index and address even with selected fields. Summary counts describe retained rows; provider discovery coverage remains unknown. Native function Evidence requires kind native: view: {kind: "native", facet: "procedure"}. Facets select procedure, pseudocode, assembly, basic blocks, comments, callers/callees, references, unresolved calls, referenced strings/names, native API and high-pcode. Use nonnegative offset and a positive caller-selected limit (defaults 0 and 64); pseudocode uses UTF-16 code units, other native pages use rows. Returns artifact identity, parent Evidence ID, a distinct view digest, coverage, limitations and unknowns. Actual serialized size determines MCP transport admission; choose a smaller page or export the complete retained Evidence if needed.',
    inputSchema: inspectAnalysisViewInputSchema,
    outputSchema: evidenceResultOf(analysisViewResultSchema),
    examples: [
      {
        title:
          "Page selected native inventory fields without repeating the complete list",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "native-inventory",
            offset: 0,
            limit: 32,
            fields: ["value"],
          },
        },
      },
      {
        title: "Read exact inventory paths from retained inspection Evidence",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "inventory",
            collection: "occurrences",
            logical_paths: ["package.json", "main.js"],
            offset: 0,
            limit: 32,
          },
        },
      },
      {
        title: "Group requests from retained HAR Evidence",
        input: API_SURFACE_EXAMPLE.input,
      },
      {
        title: "Project an environment manifest from retained HAR Evidence",
        input: ENVIRONMENT_MANIFEST_EXAMPLE.input,
      },
      {
        title: "Summarize retained analysis Evidence, including WASM",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: { kind: "summary" },
        },
      },
      {
        title: "Read one ELF section from retained layout Evidence",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "item",
            collection: "sections",
            selector: { name: ".text" },
          },
        },
      },
      {
        title: "Page native high-pcode operations from retained Evidence",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "native",
            facet: "value_flow_operations",
            offset: 0,
            limit: 32,
          },
        },
      },
      {
        title: "Page module identities from retained application Evidence",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "page",
            collection: "modules",
            offset: 0,
            limit: 32,
          },
        },
      },
      {
        title:
          "Read selected metadata and native facts by exact retained paths",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "javascript-facts",
            where: { paths: ["package.json", "build/Release/addon.node"] },
            property_keys: [
              "name",
              "version",
              "bytes",
              "availability",
              "operation",
              "analysis_status",
            ],
            include_available_property_keys: true,
            offset: 0,
            limit: 32,
          },
        },
      },
      {
        title:
          "Read typed module reference facts from retained application Evidence",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "javascript",
            collection: "modules",
            projection: "references",
            where: { path: "main.js", kind: "javascript-module" },
            offset: 0,
            limit: 64,
          },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
