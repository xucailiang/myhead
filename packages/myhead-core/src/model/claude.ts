import type { z, ZodSchema, ZodTypeAny } from 'zod';
import type { ChatDelta, ChatMessage, ChatOptions, ModelClient } from './client.js';

export function createClaudeClient(opts: {
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
}): ModelClient {
  const { apiKey, baseUrl, defaultModel } = opts;
  const base = baseUrl ?? 'https://api.anthropic.com';

  async function* chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatDelta> {
    const systemMessages = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const nonSystem = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: options?.model ?? defaultModel,
      max_tokens: options?.maxTokens ?? 4096,
      messages: nonSystem.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };
    if (systemMessages.length > 0) body.system = systemMessages;
    if (options?.temperature !== undefined) body.temperature = options.temperature;

    const version = versionDate();
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': version,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      yield { type: 'error', message: `Claude HTTP ${res.status}: ${text}`, code: 'HTTP_ERROR' };
      return;
    }

    if (!res.body) {
      yield { type: 'error', message: 'No response body', code: 'NO_BODY' };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          try {
            const event = JSON.parse(data);

            switch (event.type) {
              case 'content_block_start': {
                const block = event.content_block;
                if (block.type === 'tool_use') {
                  yield {
                    type: 'tool_use',
                    id: block.id,
                    name: block.name,
                    input: block.input ?? {},
                  };
                }
                break;
              }
              case 'content_block_delta': {
                const delta = event.delta;
                if (delta?.type === 'text_delta') {
                  yield { type: 'text_delta', text: delta.text };
                } else if (delta?.type === 'thinking_delta') {
                  yield { type: 'thinking_delta', text: delta.thinking };
                } else if (delta?.type === 'input_json_delta') {
                  // accumulated in content_block_start; skip stream deltas
                }
                break;
              }
              case 'message_stop': {
                yield { type: 'stop', stop_reason: event.stop_reason ?? 'end_turn' };
                return;
              }
              case 'error': {
                yield {
                  type: 'error',
                  message: event.error?.message ?? 'Unknown Claude error',
                  code: event.error?.type ?? 'CLAUDE_ERROR',
                };
                break;
              }
            }
          } catch {
            // skip parse errors
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function completeJson<TSchema extends ZodTypeAny>(
    messages: ChatMessage[],
    schema: TSchema,
    options?: ChatOptions,
  ): Promise<z.output<TSchema>> {
    const systemMessages = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const nonSystem = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: options?.model ?? defaultModel,
      max_tokens: options?.maxTokens ?? 4096,
      messages: nonSystem.map((m) => ({ role: m.role, content: m.content })),
      tools: [
        {
          name: 'respond',
          description: 'Respond with the structured output',
          input_schema: zodToClaudeSchema(schema),
        },
      ],
    };
    if (systemMessages.length > 0) body.system = systemMessages;

    const version = versionDate();
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': version,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Claude HTTP ${res.status}: ${await res.text()}`);
    }

    const parsed = (await res.json()) as {
      content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
    };
    const toolUse = parsed.content.find((c) => c.type === 'tool_use' && c.name === 'respond');
    if (!toolUse?.input) throw new Error('No structured output in Claude response');

    return schema.parse(toolUse.input);
  }

  return { chat, completeJson };
}

function versionDate(): string {
  return '2023-06-01';
}

function zodToClaudeSchema(schema: ZodSchema): Record<string, unknown> {
  return extractSchema(schema);
}

function extractSchema(schema: unknown, defs: Map<unknown, string> = new Map()): Record<string, unknown> {
  const zodSchema = schema as {
    _def?: {
      typeName?: string;
      type?: unknown;
      values?: unknown;
      options?: Map<string, unknown>;
      shape?: () => Record<string, unknown>;
      value?: unknown;
    };
  };

  const def = zodSchema._def;
  if (!def) return {};

  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum': {
      const values = (def.values as unknown) as Array<string | number>;
      return { type: 'string', enum: values };
    }
    case 'ZodArray':
      return { type: 'array', items: extractSchema(def.type, defs) };
    case 'ZodObject': {
      const shape = def.shape?.() ?? {};
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = extractSchema(value, defs);
      }
      return {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      };
    }
    case 'ZodOptional':
      return extractSchema(def.type, defs);
    case 'ZodNullable': {
      const inner = extractSchema(def.type, defs);
      return { anyOf: [{ type: 'null' }, inner] };
    }
    case 'ZodLiteral':
      return { const: def.value, type: typeof def.value };
    case 'ZodUnion': {
      const options = def.options;
      if (options) {
        return { anyOf: [...options.values()].map((o) => extractSchema(o, defs)) };
      }
      return {};
    }
    default:
      return {};
  }
}
