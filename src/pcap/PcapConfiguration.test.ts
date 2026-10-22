import { describe, expect, it } from "vitest";

import {
  CAPINFOS_COMMAND_ENV,
  TSHARK_COMMAND_ENV,
  resolvePcapTools,
} from "./PcapConfiguration.js";
import { parseCapinfosOutput, parseTsharkJsonOutput } from "./PcapOutput.js";

describe("resolvePcapTools", () => {
  it("prefers absolute environment paths for both tools", () => {
    expect(
      resolvePcapTools({
        [TSHARK_COMMAND_ENV]: "/usr/bin/tshark",
        [CAPINFOS_COMMAND_ENV]: "/usr/bin/capinfos",
      }),
    ).toEqual({
      tshark: { command: "/usr/bin/tshark", source: "environment" },
      capinfos: { command: "/usr/bin/capinfos", source: "environment" },
    });
  });

  it("falls back to PATH resolution without the environment keys", () => {
    expect(resolvePcapTools({})).toEqual({
      tshark: { command: "tshark", source: "path" },
      capinfos: { command: "capinfos", source: "path" },
    });
  });

  it("rejects a relative tshark path explicitly", () => {
    expect(() =>
      resolvePcapTools({ [TSHARK_COMMAND_ENV]: "bin/tshark" }),
    ).toThrow(/must be an absolute path/u);
  });

  it("rejects a relative capinfos path explicitly", () => {
    expect(() =>
      resolvePcapTools({ [CAPINFOS_COMMAND_ENV]: "capinfos" }),
    ).toThrow(/must be an absolute path/u);
  });
});

const REAL_CAPINFOS = [
  "File name:           /work/rich-capture.pcap",
  "File type:           Wireshark/tcpdump/... - pcap",
  "File encapsulation:  Linux cooked-mode capture v2",
  "Packet size limit:   file hdr: 262144 bytes",
  "Number of packets:   50",
  "File size:           23279 bytes",
  "Capture duration:    0.373473 seconds",
  "Earliest packet time: 1791728020.608505",
  "Latest packet time:   1791728020.981978",
  "SHA256:              c94f94742b3288b9a979711509ed5eab3028576301f8938319de3c22a6f5c40b",
].join("\n");

describe("parseCapinfosOutput", () => {
  it("projects metadata from real capinfos output", () => {
    expect(parseCapinfosOutput(REAL_CAPINFOS)).toEqual({
      fileType: "Wireshark/tcpdump/... - pcap",
      encapsulation: "Linux cooked-mode capture v2",
      packetCount: 50,
      captureStart: "2026-10-11T14:13:40.608505Z",
      captureEnd: "2026-10-11T14:13:40.981978Z",
      captureDurationSeconds: 0.373473,
      snapshotLength: 262144,
      sha256:
        "c94f94742b3288b9a979711509ed5eab3028576301f8938319de3c22a6f5c40b",
    });
  });

  it("retains timestamps from the older capinfos labels", () => {
    const output = REAL_CAPINFOS.replace(
      "Earliest packet time",
      "First packet time",
    ).replace("Latest packet time", "Last packet time");
    const metadata = parseCapinfosOutput(output);
    expect(metadata.captureStart).toBe("2026-10-11T14:13:40.608505Z");
    expect(metadata.captureEnd).toBe("2026-10-11T14:13:40.981978Z");
  });

  it("projects epoch timestamps to UTC instants and keeps other spellings unknown", () => {
    const withTimes = (start: string, end: string): string =>
      REAL_CAPINFOS.replace("1791728020.608505", start).replace(
        "1791728020.981978",
        end,
      );
    expect(
      parseCapinfosOutput(withTimes("1791728020", "1791728020.500000")),
    ).toMatchObject({
      captureStart: "2026-10-11T14:13:40Z",
      captureEnd: "2026-10-11T14:13:40.500000Z",
    });
    // capinfos prints n/a for an empty capture, and its default wall-clock
    // spelling carries no zone, so neither names an instant.
    expect(
      parseCapinfosOutput(withTimes("n/a", "2026-10-11 14:13:40.981978")),
    ).toMatchObject({ captureStart: null, captureEnd: null });
    // a packet before the epoch prints with a leading minus; the whole seconds
    // and the fraction are borrowed so the instant stays exact
    expect(parseCapinfosOutput(withTimes("-1", "-1.250000"))).toMatchObject({
      captureStart: "1969-12-31T23:59:59Z",
      captureEnd: "1969-12-31T23:59:58.750000Z",
    });
    expect(parseCapinfosOutput(withTimes("-0.5", "0"))).toMatchObject({
      captureStart: "1969-12-31T23:59:59.5Z",
      captureEnd: "1970-01-01T00:00:00Z",
    });
    // beyond the RFC 3339 year range in either direction stays unknown
    expect(
      parseCapinfosOutput(withTimes("-62167219201", "253402300800")),
    ).toMatchObject({ captureStart: null, captureEnd: null });
  });

  it.each([
    ["0.000000001", "1970-01-01T00:00:00.000000001Z"],
    ["-0.000000001", "1969-12-31T23:59:59.999999999Z"],
    ["-1.000000", "1969-12-31T23:59:59.000000Z"],
    ["-0.000000", "1970-01-01T00:00:00.000000Z"],
    ["-62167219200.000000001", null],
    ["-62167219200", "0000-01-01T00:00:00Z"],
    ["253402300799.999999999", "9999-12-31T23:59:59.999999999Z"],
    ["253402300800", null],
    ["NaN", null],
    ["Infinity", null],
    ["1791728020.5junk", null],
    ["1e3", null],
    ["1.1234567890", null],
    ["9".repeat(1000), null],
  ])("preserves the exact instant or unknown for %s", (text, expected) => {
    const metadata = parseCapinfosOutput(
      REAL_CAPINFOS.replace("1791728020.608505", text).replace(
        "1791728020.981978",
        text,
      ),
    );
    expect(metadata.captureStart).toBe(expected);
    expect(metadata.captureEnd).toBe(expected);
  });

  it("keeps missing capture timestamps unknown", () => {
    const output = REAL_CAPINFOS.split("\n")
      .filter((line) => !line.includes("packet time:"))
      .join("\n");
    expect(parseCapinfosOutput(output)).toMatchObject({
      captureStart: null,
      captureEnd: null,
    });
  });

  it("rejects empty metadata rather than reporting complete unknown facts", () => {
    expect(() => parseCapinfosOutput("")).toThrow(/machine-readable/u);
  });
});

const REAL_TSHARK_JSON = JSON.stringify([
  {
    _source: {
      layers: {
        "frame.number": ["1"],
        "frame.protocols": ["sll:ethertype:ip:udp:dns"],
        "ip.src": ["192.168.1.1"],
        "ip.dst": ["8.8.8.8"],
        "dns.qry.name": ["example.com"],
        "dns.flags.response": ["1"],
        "dns.a": ["93.184.216.34"],
      },
    },
  },
  {
    _source: {
      layers: {
        "frame.number": ["2"],
        "frame.protocols": ["sll:ethertype:ip:tcp:tls"],
        "ip.src": ["192.168.1.1"],
        "ip.dst": ["93.184.216.34"],
        "tls.handshake.extensions_server_name": ["example.com"],
      },
    },
  },
  {
    _source: {
      layers: {
        "frame.number": ["3"],
        "frame.protocols": ["sll:ethertype:ip:tcp:http"],
        "ip.src": ["192.168.1.1"],
        "ip.dst": ["93.184.216.34"],
        "http.request.full_uri": ["http://example.com/page"],
      },
    },
  },
]);

describe("parseTsharkJsonOutput", () => {
  it("projects endpoints, DNS, TLS SNI, protocols, and HTTP URIs", async () => {
    const result = await parseTsharkJsonOutput(REAL_TSHARK_JSON);
    expect(result.endpoints).toEqual(
      expect.arrayContaining([
        { address: "192.168.1.1", port: null, packet_count: 3 },
        { address: "8.8.8.8", port: null, packet_count: 1 },
        { address: "93.184.216.34", port: null, packet_count: 2 },
      ]),
    );
    expect(result.dnsQueries).toEqual([
      {
        query: "example.com",
        response_addresses: ["93.184.216.34"],
        response_address_count: 1,
      },
    ]);
    expect(result.tlsSniValues).toEqual(["example.com"]);
    expect(result.httpRequestUris).toEqual(["http://example.com/page"]);
    expect(result.protocolDistribution).toEqual(
      expect.arrayContaining([
        { protocol: "sll:ethertype:ip:udp:dns", packet_count: 1 },
        { protocol: "sll:ethertype:ip:tcp:tls", packet_count: 1 },
        { protocol: "sll:ethertype:ip:tcp:http", packet_count: 1 },
      ]),
    );
  });

  it("retains every endpoint within the aggregate resource budget", async () => {
    const packets = Array.from({ length: 10 }, (_, index) => ({
      _source: {
        layers: {
          "frame.number": [String(index + 1)],
          "frame.protocols": ["ip:tcp"],
          "ip.src": [`10.0.0.${index}`],
          "ip.dst": ["10.0.1.1"],
        },
      },
    }));
    const result = await parseTsharkJsonOutput(JSON.stringify(packets));
    expect(result.endpoints).toHaveLength(11);
    expect(result.endpointCount).toBe(11); // 10 src + 1 dst
  });

  it.each([
    "",
    "not json",
    "{}",
    "null",
    "[null]",
    '[{"_source":{"layers":{"ip.src":[3]}}}]',
  ])("rejects malformed producer output %s", async (text) => {
    await expect(parseTsharkJsonOutput(text)).rejects.toMatchObject({
      _tag: "AnalysisProtocolError",
    });
  });
});
