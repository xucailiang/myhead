import type { z, ZodTypeAny } from 'zod';

export type ChatDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; content: string }
  | { type: 'stop'; stop_reason: string }
  | { type: 'error'; message: string; code?: string };

export type ChatOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type ModelClient = {
  chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatDelta>;
  completeJson<TSchema extends ZodTypeAny>(
    messages: ChatMessage[],
    schema: TSchema,
    options?: ChatOptions,
  ): Promise<z.output<TSchema>>;
};

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};
