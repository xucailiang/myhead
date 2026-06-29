export type MyHeadSseEvent =
  | ({ type: 'hub_status'; status: string; snapshot?: boolean } & EventScope)
  | ({ type: 'hub_message'; id?: string; role: string; content: string; timestamp: number; snapshot?: boolean } & EventScope)
  | ({ type: 'hub_message_delta'; streamId: string; role: string; delta: string; timestamp: number } & EventScope)
  | ({ type: 'review_started' } & EventScope)
  | ({ type: 'review_completed'; verdict: unknown } & EventScope)
  | ({ type: 'worker_dispatch'; agent: string; stepId: string } & EventScope)
  | ({ type: 'worker_output'; agent: string; text: string } & EventScope)
  | ({ type: 'error'; message: string; code: string } & Partial<EventScope>);

export type EventScope = {
  workspaceId: string;
  runId: string;
  hubId: string;
};
