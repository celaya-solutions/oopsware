import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { packetRequest } from "./packet-entry.mjs";

const { values } = parseArgs({ options: { selection: { type: "string" } } });
if (!["baseline", "focused", "discovery"].includes(values.selection))
  throw new Error("Select baseline, focused or discovery");
const question = await readFile(
  new URL("./questions/packet-postgres.txt", import.meta.url),
  "utf8",
);
const plan = [
  ...(values.selection === "discovery"
    ? [
        {
          tool: "inspect_packet_fields",
          arguments: {
            kind: "fields",
            protocol: "tcp",
            query: "tcp.flags",
            limit: 1,
          },
        },
      ]
    : []),
  {
    tool: "inspect_packet_capture",
    arguments: packetRequest(
      "wireshark-pgsql-jdbc.pcap",
      "{{artifact_path}}",
      values.selection,
    ),
  },
];
process.stdout.write(
  question +
    "\nExecute this fixed public REA MCP plan in order. These are input selections, not expected answers. Preserve omitted defaults. All calls count toward the comparison.\n" +
    JSON.stringify(plan, null, 2) +
    "\n",
);
