// Registers the Relay tools with the browser's WebMCP model context.
// The tools are the same functions the walkthrough and tests use; this
// file only adapts them to document.modelContext.registerTool.

import type { RelayStore } from "../runtime/state";
import { TOOLS, invokeTool } from "./tools";

interface ModelContextTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown> | unknown;
}

interface ModelContext {
  registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): Promise<void> | void;
  getTools?(): Promise<Array<{ name: string }>>;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
  interface Navigator {
    modelContext?: ModelContext;
  }
}

export function findModelContext(): ModelContext | null {
  if (typeof document !== "undefined" && document.modelContext) return document.modelContext;
  if (typeof navigator !== "undefined" && navigator.modelContext) return navigator.modelContext;
  return null;
}

export interface RegistrationReport {
  available: boolean;
  registered: string[];
  errors: string[];
}

export async function registerRelayTools(store: RelayStore, signal?: AbortSignal): Promise<RegistrationReport> {
  const context = findModelContext();
  if (!context) return { available: false, registered: [], errors: [] };
  const registered: string[] = [];
  const errors: string[] = [];
  for (const spec of TOOLS) {
    try {
      await context.registerTool(
        {
          name: spec.name,
          description: spec.description,
          inputSchema: spec.inputSchema,
          annotations: spec.annotations,
          execute: async (input: unknown) => {
            // Chrome serialises whatever execute returns to a JSON string for
            // the agent, so hand back the plain result object: one level of JSON.
            return invokeTool(store, spec.name, input);
          },
        },
        signal ? { signal } : undefined,
      );
      registered.push(spec.name);
    } catch (error) {
      errors.push(`${spec.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { available: true, registered, errors };
}
