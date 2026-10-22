import type { Client } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";

import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { functionComparisonResultSchema } from "../../../src/domain/functionComparisonSchemas.js";
import { functionDossierSchema } from "../../../src/domain/hopperValues.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { reconstructionVerificationResultSchema } from "../../../src/domain/reconstructionVerificationSchemas.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const example = FUNCTION_COMPARISON_EXAMPLE.left;
const dossier = functionDossierSchema.parse(example.normalized_result);
type Reference = (typeof dossier.outgoing_references)[number];
type Classification = "call" | "data" | "unknown";

const createHarness = async () => {
  const harness = await createApplicationMcpHarness({
    session: createTestBinarySession(() => {
      throw new Error("Function comparison must not launch a provider");
    }),
  });
  onTestFinished(harness.close);
  return harness;
};

const procedure = (address: string, name: string) => ({
  address,
  name,
  classification: null,
  body: dossier.procedure.body,
});

const reference = (
  sourceAddress: string,
  targetAddress: string,
  classification: Classification = "call",
  options: {
    readonly sourceName?: string;
    readonly targetName?: string | null;
    readonly sourceEntryAddress?: string;
    readonly targetEntryAddress?: string;
  } = {},
): Reference => ({
  source_address: sourceAddress,
  target_address: targetAddress,
  source_procedure:
    options.sourceName === undefined
      ? procedure(options.sourceEntryAddress ?? sourceAddress, "main")
      : procedure(
          options.sourceEntryAddress ?? sourceAddress,
          options.sourceName,
        ),
  target_procedure:
    options.targetName === null
      ? null
      : procedure(
          options.targetEntryAddress ?? targetAddress,
          options.targetName ?? "helper",
        ),
  kind:
    classification === "unknown"
      ? { available: false, reason: "Reference kind was not exposed." }
      : {
          available: true,
          provenance: "controlled-reference-fact",
          type: classification === "call" ? "UNCONDITIONAL_CALL" : "READ",
          flow: classification === "call",
          call: classification === "call",
          jump: false,
          data: classification === "data",
          read: classification === "data",
          write: false,
          indirect: false,
          computed: false,
          conditional: false,
          terminal: false,
          primary: true,
          operand_index: 0,
          external: false,
        },
});

const evidence = (
  id: string,
  digest: string,
  outgoing: readonly Reference[] = [],
  options: {
    readonly incoming?: readonly Reference[];
    readonly procedureAddress?: string;
    readonly procedureName?: string;
  } = {},
) =>
  createEvidence(
    {
      path: `/fixture/function-reference/${id}`,
      sha256: digest.repeat(64),
      format: "mach-o",
    },
    example.provider,
    {
      operation: "analyze_function",
      parameters: { ...example.parameters, observation: id },
      result: jsonValueSchema.parse({
        ...dossier,
        procedure: {
          ...dossier.procedure,
          address: options.procedureAddress ?? dossier.procedure.address,
          name: options.procedureName ?? dossier.procedure.name,
        },
        incoming_references: [...(options.incoming ?? [])],
        outgoing_references: [...outgoing],
      }),
      confidence: "derived",
      authority: "shipped-artifact",
      relationshipCoverage: { status: "complete" },
    },
  );

const compare = async (
  client: Client,
  left: ReturnType<typeof evidence>,
  right: ReturnType<typeof evidence>,
) => {
  const response = await client.callTool({
    name: "compare_functions",
    arguments: { left, right },
  });
  expect(
    response.isError,
    JSON.stringify({
      content: response.content,
      structured: response.structuredContent,
    }),
  ).not.toBe(true);
  const resultEvidence = parseEvidence(response.structuredContent);
  expect(resultEvidence.operation).toBe("compare_functions");
  expect(resultEvidence.evidence_links).toEqual(
    expect.arrayContaining([left.evidence_id, right.evidence_id]),
  );
  return {
    evidence: resultEvidence,
    result: functionComparisonResultSchema.parse(
      resultEvidence.normalized_result,
    ),
  };
};

const expectReferences = (
  comparison: Awaited<ReturnType<typeof compare>>,
  status: "unchanged" | "changed" | "unknown",
) =>
  expect
    .soft(
      comparison.result.dimensions.find(
        ({ dimension }) => dimension === "references",
      ),
    )
    .toMatchObject({ status });

const verifyReferences = async (
  client: Client,
  comparisonEvidenceId: string,
  status: "pass" | "fail" | "unknown",
) => {
  const claimId = `references-${comparisonEvidenceId}`;
  const response = await client.callTool({
    name: "verify_reconstruction",
    arguments: {
      specification: {
        name: `Reference identity check ${comparisonEvidenceId}`,
        claims: [
          {
            kind: "structural-function",
            claim_id: claimId,
            title: "Reference facts agree",
            comparison_evidence_id: comparisonEvidenceId,
            dimension: "references",
          },
        ],
      },
    },
  });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  const verification = reconstructionVerificationResultSchema.parse(
    parseEvidence(response.structuredContent).normalized_result,
  );
  const observed =
    status === "pass" ? "unchanged" : status === "fail" ? "changed" : "unknown";
  expect.soft(verification).toMatchObject({
    status,
    summary: {
      total: 1,
      passed: status === "pass" ? 1 : 0,
      failed: status === "fail" ? 1 : 0,
      unknown: status === "unknown" ? 1 : 0,
    },
    claims: {
      items: [
        expect.objectContaining({
          claim_id: claimId,
          status,
          observed_status: observed,
        }),
      ],
    },
  });
};

it("preserves reference identity uncertainty and same-artifact coordinates", async () => {
  const { client } = await createHarness();
  const namedLeft = evidence("named-left", "a", [
    reference("0x1000", "0x1010"),
  ]);
  const namedRight = evidence(
    "named-right",
    "b",
    [reference("0x2000", "0x2020")],
    { procedureAddress: "0x2000" },
  );
  expectReferences(await compare(client, namedLeft, namedRight), "unchanged");

  const named = evidence("known-helper", "c", [reference("0x1000", "0x1010")]);
  const unnamedElsewhere = evidence(
    "unknown-helper",
    "d",
    [reference("0x2000", "0x2020", "call", { targetName: null })],
    { procedureAddress: "0x2000" },
  );
  const namedToNull = await compare(client, named, unnamedElsewhere);
  expectReferences(namedToNull, "unknown");
  await verifyReferences(client, namedToNull.evidence.evidence_id, "unknown");
  const nullToNamed = await compare(client, unnamedElsewhere, named);
  expectReferences(nullToNamed, "unknown");

  const knownSameArtifact = evidence("same-named", "e", [
    reference("0x1000", "0x1010"),
  ]);
  expectReferences(
    await compare(
      client,
      knownSameArtifact,
      evidence("same-unnamed", "e", [
        reference("0x1000", "0x1010", "call", { targetName: null }),
      ]),
    ),
    "unchanged",
  );
  expectReferences(
    await compare(
      client,
      knownSameArtifact,
      evidence("same-different-raw", "e", [
        reference("0x1000", "0x1020", "call", { targetName: null }),
      ]),
    ),
    "changed",
  );

  const reversed = await compare(
    client,
    namedLeft,
    evidence("reverse", "f", [], {
      procedureAddress: "0x2000",
      incoming: [
        reference("0x2020", "0x2000", "call", {
          sourceName: "helper",
          targetName: "main",
        }),
      ],
    }),
  );
  expectReferences(reversed, "changed");
  expectReferences(await compare(client, namedRight, namedLeft), "unchanged");
});

it("keeps generated and ambiguous procedure names from proving cross-artifact identity", async () => {
  const { client } = await createHarness();
  for (const [index, name] of ["sub_1010", "fcn.1010", "FUN_1010"].entries()) {
    const left = evidence(`auto-left-${index}`, "1", [
      reference("0x1000", "0x1010", "call", { targetName: name }),
    ]);
    const right = evidence(
      `auto-right-${index}`,
      "2",
      [reference("0x2000", "0x2020", "call", { targetName: name })],
      { procedureAddress: "0x2000" },
    );
    expectReferences(await compare(client, left, right), "unknown");
    const otherName = ["fcn.2020", "FUN_2020", "sub_2020"][index] ?? "sub_2020";
    expectReferences(
      await compare(
        client,
        left,
        evidence(
          `auto-different-${index}`,
          "3",
          [reference("0x2000", "0x2020", "call", { targetName: otherName })],
          { procedureAddress: "0x2000" },
        ),
      ),
      "unknown",
    );
  }

  const sameCoordinates = await compare(
    client,
    evidence("auto-coordinate-left", "4", [
      reference("0x1000", "0x1010", "call", { targetName: "sub_1010" }),
    ]),
    evidence("auto-coordinate-right", "4", [
      reference("0x1000", "0x1010", "call", { targetName: "FUN_1010" }),
    ]),
  );
  expectReferences(sameCoordinates, "unchanged");

  const overloads = await compare(
    client,
    evidence("duplicate-helper-left", "5", [
      reference("0x1000", "0x1010"),
      reference("0x1000", "0x1020"),
    ]),
    evidence(
      "duplicate-helper-right",
      "6",
      [reference("0x2000", "0x2010"), reference("0x2000", "0x2020")],
      { procedureAddress: "0x2000" },
    ),
  );
  expectReferences(overloads, "unknown");

  const generatedFunctions = await compare(
    client,
    evidence("generated-function-left", "7", [], {
      procedureName: "sub_1000",
    }),
    evidence("generated-function-right", "8", [], {
      procedureAddress: "0x2000",
      procedureName: "FUN_2000",
    }),
  );
  expect.soft(generatedFunctions.result.function_match).toMatchObject({
    status: "ambiguous",
  });
  expect.soft(generatedFunctions.result.status).toBe("unknown");
});

it("normalizes numeric coordinates but preserves address spaces and source sites", async () => {
  const { client } = await createHarness();
  const at = (id: string, address: string) =>
    evidence(id, "9", [
      {
        ...reference("0x1000", "0x1010", "call", { targetName: null }),
        target_address: address,
      },
    ]);
  const equivalentCoordinates = [
    ["0x1010", "0x00001010"],
    ["0x1010", "0X001010"],
    ["0x10a", "0x10A"],
  ] as const;
  for (const [index, [left, right]] of equivalentCoordinates.entries())
    expectReferences(
      await compare(
        client,
        at(`coordinate-left-${index}`, left),
        at(`coordinate-right-${index}`, right),
      ),
      "unchanged",
    );

  expectReferences(
    await compare(
      client,
      at("space-left", "left:0x1010"),
      at("space-right", "right:0x1010"),
    ),
    "changed",
  );

  expectReferences(
    await compare(
      client,
      at("escaped-space-left", "seg%2f:0x0010"),
      at("escaped-space-right", "seg%2F:0x10"),
    ),
    "unchanged",
  );
  expectReferences(
    await compare(
      client,
      at("space-case-left", "RAM:0x10"),
      at("space-case-right", "ram:0x10"),
    ),
    "changed",
  );

  const unsupported = (
    id: string,
    digest: string,
    address: string,
    classification: Classification = "call",
  ) =>
    evidence(id, digest, [
      reference("0x1000", address, classification, { targetName: null }),
    ]);
  expectReferences(
    await compare(
      client,
      unsupported("unsupported-same-left", "a", "bad coordinate"),
      unsupported("unsupported-same-right", "a", "bad coordinate"),
    ),
    "unknown",
  );
  expectReferences(
    await compare(
      client,
      unsupported("unsupported-different-left", "b", "bad coordinate"),
      unsupported("unsupported-different-right", "c", "other bad coordinate"),
    ),
    "unknown",
  );
  expectReferences(
    await compare(
      client,
      unsupported("unsupported-call", "d", "bad coordinate", "call"),
      unsupported("unsupported-data", "e", "other bad coordinate", "data"),
    ),
    "changed",
  );

  const atSite = (id: string, site: string) =>
    evidence(id, "a", [
      reference(site, "0x1010", "call", { sourceEntryAddress: "0x1000" }),
    ]);
  expectReferences(
    await compare(
      client,
      atSite("site-left", "0x1004"),
      atSite("site-right", "0x1008"),
    ),
    "changed",
  );
});

it("keeps known reference changes decisive beside unrelated unknown kinds", async () => {
  const { client } = await createHarness();
  const left = evidence("mixed-left", "b", [
    reference("0x1000", "0x1010", "call"),
    reference("0x1000", "0x1020", "unknown", { targetName: "other" }),
  ]);
  const right = evidence(
    "mixed-right",
    "c",
    [
      reference("0x2000", "0x2020", "unknown", { targetName: "other" }),
      reference("0x2000", "0x2010", "data"),
    ],
    { procedureAddress: "0x2000" },
  );
  const compared = await compare(client, left, right);
  expectReferences(compared, "changed");
  await verifyReferences(client, compared.evidence.evidence_id, "fail");
});

it("keeps ambiguous duplicate edge kinds unknown independent of input order", async () => {
  const { client } = await createHarness();
  const left = [
    reference("0x1000", "0x1010", "call"),
    reference("0x1000", "0x1010", "unknown"),
  ];
  const right = [
    reference("0x2000", "0x2010", "unknown"),
    reference("0x2000", "0x2010", "data"),
  ];
  const first = await compare(
    client,
    evidence("ambiguous-left", "d", left),
    evidence("ambiguous-right", "e", right, { procedureAddress: "0x2000" }),
  );
  const reversed = await compare(
    client,
    evidence("ambiguous-left-reversed", "f", [...left].reverse()),
    evidence("ambiguous-right-reversed", "1", [...right].reverse(), {
      procedureAddress: "0x2000",
    }),
  );
  expectReferences(first, "unknown");
  expectReferences(reversed, "unknown");
  expect(
    reversed.result.dimensions.find(
      ({ dimension }) => dimension === "references",
    )?.limitations,
  ).toEqual(
    first.result.dimensions.find(({ dimension }) => dimension === "references")
      ?.limitations,
  );

  const changed = await compare(
    client,
    evidence("changed-target-left", "2", [reference("0x1000", "0x1010")]),
    evidence(
      "changed-target-right",
      "3",
      [reference("0x2000", "0x2020", "call", { targetName: "replacement" })],
      { procedureAddress: "0x2000" },
    ),
  );
  expectReferences(changed, "changed");
});
