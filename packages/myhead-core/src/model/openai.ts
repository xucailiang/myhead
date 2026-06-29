import type { z, ZodSchema, ZodTypeAny } from 'zod';
import type { ChatDelta, ChatMessage, ChatOptions, ModelClient } from './client.js';

export function createOpenAiClient(opts: {
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
}): ModelClient {
  const { apiKey, baseUrl, defaultModel } = opts;

  async function* chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatDelta> {
    const body: Record<string, unknown> = {
      model: options?.model ?? defaultModel,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };
    if (options?.maxTokens) body.max_completion_tokens = options.maxTokens;
    if (options?.temperature !== undefined) body.temperature = options.temperature;

    const url = `${baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      yield { type: 'error', message: `OpenAI HTTP ${res.status}: ${text}`, code: 'HTTP_ERROR' };
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
          if (data === '[DONE]') {
            yield { type: 'stop', stop_reason: 'end' };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              yield { type: 'text_delta', text: delta.content };
            } else if (delta.tool_calls?.length) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name) {
                  yield {
                    type: 'tool_use',
                    id: tc.id ?? tc.index,
                    name: tc.function.name,
                    input: JSON.parse(tc.function.arguments ?? '{}'),
                  };
                }
              }
            }
          } catch {
            // skip parse errors for individual lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'stop', stop_reason: 'end' };
  }

  async function completeJson<TSchema extends ZodTypeAny>(
    messages: ChatMessage[],
    schema: TSchema,
    options?: ChatOptions,
  ): Promise<z.output<TSchema>> {
    const jsonMessages = messages.map((m) => ({ role: m.role, content: m.content }));
    const shape = describeZodSchema(schema);
    jsonMessages.push({
      role: 'user',
      content: `Respond with a JSON object matching this shape. Use camelCase keys exactly as shown:\n${shape}\n\nOutput ONLY the JSON, no markdown.`,
    });

    const body: Record<string, unknown> = {
      model: options?.model ?? defaultModel,
      messages: jsonMessages,
      response_format: { type: 'json_object' },
    };
    if (options?.maxTokens) body.max_completion_tokens = options.maxTokens;

    const url = `${baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
    }

    const parsed = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const content = parsed.choices?.[0]?.message?.content;
    if (!content) throw new Error('No content in OpenAI structured response');

    try {
      return schema.parse(JSON.parse(content));
    } catch (err) {
      throw new Error(`JSON validation failed: ${(err as Error).message}. Content: ${content.slice(0, 500)}`);
    }
  }

  return { chat, completeJson };
}

function describeZodSchema(schema: ZodSchema): string {
  return JSON.stringify(describeZod(schema), null, 2);
}

function describeZod(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return String(schema);
  const z = schema as { _def?: { typeName?: string; type?: unknown; values?: unknown; shape?: () => Record<string, unknown> } };
  const def = z._def;
  if (!def) return String((schema as { type?: string; _type?: string })._type ?? (schema as { type?: string; _type?: string }).type ?? 'unknown');

  switch (def.typeName) {
    case 'ZodString': return 'string';
    case 'ZodNumber': return 'number';
    case 'ZodBoolean': return 'boolean';
    case 'ZodEnum': return def.values;
    case 'ZodArray': return [describeZod(def.type)];
    case 'ZodObject': {
      const shape = def.shape?.() ?? {};
      const props: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(shape)) {
        props[key] = describeZod(value);
      }
      return props;
    }
    case 'ZodOptional': return describeZod(def.type);
    case 'ZodNullable': return [null, describeZod(def.type)];
    case 'ZodLiteral': return (def as { value?: unknown }).value;
    case 'ZodEffects': return describeZod(def.type ?? (def as { schema?: unknown }).schema);
    default: return def.typeName ?? 'unknown';
  }
}
