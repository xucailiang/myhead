import { describe, expect, it } from 'vitest';
import { createJsonEventStreamHandler } from '../src/parsers/json-event-stream.js';

describe('createJsonEventStreamHandler', () => {
  it('emits the Codex thread id as a resumable session id', () => {
    const events: Array<Record<string, unknown>> = [];
    const handler = createJsonEventStreamHandler('codex', (event) => {
      events.push(event);
    });

    handler.feed('{"type":"thread.started","thread_id":"codex-thread-1"}\n');
    handler.flush();

    expect(events).toContainEqual({
      type: 'status',
      label: 'initializing',
      sessionId: 'codex-thread-1',
      rawType: 'thread.started',
    });
  });
});
