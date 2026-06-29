import { describe, expect, it } from 'vitest';
import { reviewVerdictSchema } from '../src/supervisor/schema.js';

describe('reviewVerdictSchema', () => {
  it('normalizes optional finding file and line values from model JSON', () => {
    const verdict = reviewVerdictSchema.parse({
      status: 'continue',
      summary: 'partial progress',
      findings: [
        {
          severity: 'info',
          description: 'worker is still running',
          file: 'undefined',
          line: 'undefined',
        },
        {
          severity: 'warning',
          description: 'line as string',
          file: 'src/example.ts',
          line: '42',
        },
      ],
      missingVerification: [],
      recommendedReply: 'wait',
    });

    expect(verdict.findings[0]?.file).toBeNull();
    expect(verdict.findings[0]?.line).toBeNull();
    expect(verdict.findings[1]?.file).toBe('src/example.ts');
    expect(verdict.findings[1]?.line).toBe(42);
  });
});
