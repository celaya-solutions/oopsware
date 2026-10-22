import { parseArgs } from "node:util";
import { signalRequest, SIGNAL_ARTIFACTS } from "./signal-entry.mjs";

const { values } = parseArgs({
  options: { artifact: { type: "string" }, selection: { type: "string" } },
});
if (
  !Object.hasOwn(SIGNAL_ARTIFACTS, values.artifact ?? "") ||
  !["baseline", "focused"].includes(values.selection)
)
  throw new Error(
    "Use --artifact fixed-signal-ID --selection baseline|focused",
  );
const kind = SIGNAL_ARTIFACTS[values.artifact].kind;
const question =
  kind === "uart"
    ? "Report every decoded RX data octet on the specified DOUT1 channel, in recording order, as decimal integer bytes. Include all repetitions; do not deduplicate data."
    : "Report every I2C READ data payload in recording order, grouped into consecutive six-byte payloads. Exclude address bytes and write data. Do not infer button or hardware behavior.";
console.log(`${question}
Use the configured REA MCP and make exactly one decode_signal_recording call with this selection:
${JSON.stringify(signalRequest(values.artifact, "{{artifact_path}}", values.selection))}
Return one JSON object with exactly these keys: kind (${JSON.stringify(kind)}), ${kind === "uart" ? "bytes (an array of decimal octets)" : "reads (an array of six-octet decimal arrays)"}, evidence_ids (unique actual returned Evidence IDs), limitations (nonempty investigation limitations). Preserve source identity and recorded order. Output lines are not sample or annotation counts; selected decoder observations do not prove complete hardware traffic or original application behavior. Do not run shell commands, browse, acquire hardware samples, invent missing data, or fabricate citations.`);
