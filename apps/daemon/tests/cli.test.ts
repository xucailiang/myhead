import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { parseCliArgs } from '../src/cli.js';

const originalWorkspace = process.env.MYHEAD_WORKSPACE;

describe('parseCliArgs', () => {
  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.MYHEAD_WORKSPACE;
    } else {
      process.env.MYHEAD_WORKSPACE = originalWorkspace;
    }
  });

  it('binds myhead dot to the current working directory', () => {
    delete process.env.MYHEAD_WORKSPACE;

    expect(parseCliArgs(['.']).workspacePath).toBe(process.cwd());
  });

  it('allows source dev startup without an implicit workspace', () => {
    delete process.env.MYHEAD_WORKSPACE;

    expect(parseCliArgs([]).workspacePath).toBeNull();
  });

  it('allows MYHEAD_WORKSPACE to provide the startup workspace', () => {
    process.env.MYHEAD_WORKSPACE = 'some-workspace';

    expect(parseCliArgs([]).workspacePath).toBe(path.resolve('some-workspace'));
  });
});
