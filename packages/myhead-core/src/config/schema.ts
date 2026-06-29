import { z } from 'zod';

export const MyHeadConfigSchema = z.object({
  protocol: z.enum(['openai', 'claude']),
  apiKey: z.string().min(1),
  baseUrl: z.string().trim().optional(),
  model: z.string().min(1),
  systemPromptPath: z.string().optional(),
});

export type MyHeadConfig = z.infer<typeof MyHeadConfigSchema>;

export function defaultConfigPath(): string {
  const os = process.platform;
  const home = os === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  if (!home) throw new Error('Unable to determine home directory');
  return `${home}/.myhead/config.json`;
}
