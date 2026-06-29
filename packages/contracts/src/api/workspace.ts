export type WorkspaceContextDto = {
  workspaceId: string;
  absolutePath: string;
  stateDir: string;
  displayName: string;
  createdAt: number;
  lastUsedAt: number;
};

export type WorkspaceRegisterRequest = {
  path: string;
};

export type WorkspaceRegisterResponse = {
  workspace: WorkspaceContextDto;
};

export type WorkspaceListResponse = {
  workspaces: WorkspaceContextDto[];
};
