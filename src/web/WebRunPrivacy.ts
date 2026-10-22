import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { redactExplicitText } from "../domain/explicitSensitiveValues.js";

const object = z.record(z.string(), z.unknown());
/** Find only values explicitly declared sensitive by canonical input contracts. */
export const webRunSensitiveValues = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  environment: Readonly<NodeJS.ProcessEnv>,
): string[] => {
  const values: string[] = [];
  if (tool === "capture_process_scenario" && Array.isArray(input.events)) {
    for (const event of input.events) {
      const parsed = object.safeParse(event);
      if (
        parsed.success &&
        parsed.data.sensitive === true &&
        typeof parsed.data.data === "string"
      )
        values.push(parsed.data.data);
    }
  }
  const scenario = object.safeParse(input.scenario);
  if (scenario.success && Array.isArray(scenario.data.secrets)) {
    for (const secret of scenario.data.secrets) {
      const parsed = object.safeParse(secret);
      if (
        parsed.success &&
        typeof parsed.data.environment_variable === "string"
      ) {
        const value = environment[parsed.data.environment_variable];
        if (value) values.push(value);
      }
    }
  }
  for (const key of ["cdp_endpoint", "inspector_endpoint"]) {
    const endpoint = input[key];
    if (typeof endpoint !== "string") continue;
    try {
      const url = new URL(endpoint);
      if (url.username)
        values.push(url.username, decodeURIComponent(url.username));
      if (url.password)
        values.push(url.password, decodeURIComponent(url.password));
    } catch {
      /* Invalid endpoints are rejected by the canonical tool boundary. */
    }
  }
  return values;
};
/** Preserve arbitrary local evidence while excluding declared secrets from durable runs. */
export const redactWebRunValue = (
  value: unknown,
  sensitive: readonly string[],
): unknown => {
  if (sensitive.length === 0) return value;
  if (typeof value === "string") return redactExplicitText(value, sensitive);
  if (Array.isArray(value))
    return value.map((item) => redactWebRunValue(item, sensitive));
  const parsed = object.safeParse(value);
  if (parsed.success)
    return Object.fromEntries(
      Object.entries(parsed.data).map(([key, item]) => [
        key,
        redactWebRunValue(item, sensitive),
      ]),
    );
  return value;
};

const redactTextPayload = (
  text: string,
  sensitive: readonly string[],
): string => {
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(redactWebRunValue(parsed, sensitive));
  } catch {
    return redactExplicitText(text, sensitive);
  }
};

/** Redact payload values while preserving MCP discriminators and JSON object keys. */
export const redactWebToolResult = (
  result: CallToolResult,
  sensitive: readonly string[],
): CallToolResult => {
  if (sensitive.length === 0) return result;
  return {
    ...result,
    ...(result.structuredContent === undefined
      ? {}
      : {
          structuredContent: object.parse(
            redactWebRunValue(result.structuredContent, sensitive),
          ),
        }),
    content: result.content.map((content) => {
      if (content.type === "text")
        return { ...content, text: redactTextPayload(content.text, sensitive) };
      if (content.type === "resource" && "text" in content.resource)
        return {
          ...content,
          resource: {
            ...content.resource,
            text: redactTextPayload(content.resource.text, sensitive),
          },
        };
      // Encoded images/audio and protocol metadata are not plaintext payloads.
      return content;
    }),
  };
};
