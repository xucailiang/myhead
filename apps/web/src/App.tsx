import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { MyHeadSseEvent, WorkspaceContextDto } from '@myhead/contracts';
import { useSse } from './hooks/useSse';

type Phase = 'planning' | 'executing';
type WorkerStrategy = 'codex' | 'claude' | 'both';
type PlanStatus = 'idle' | 'drafting' | 'ready' | 'failed';

type Message = {
  id: string;
  serverId?: string;
  streamId?: string;
  role: string;
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  isLocal?: boolean;
  pendingLabel?: string;
  snapshot?: boolean;
};

type ImplementationPlan = {
  goal: string;
  steps: Array<{
    id: string;
    description: string;
    expectedOutput: string;
    dependsOn?: string[] | null;
  }>;
  constraints: string[];
  successCriteria: string[];
  risks: Array<{
    description: string;
    severity: 'low' | 'medium' | 'high';
    mitigation: string;
  }>;
  workerStrategy: WorkerStrategy;
  collaborationPlan?: {
    mode: 'single_worker' | 'parallel_cooperate';
    assignments: Record<string, string[]>;
    coordinationRules: string[];
  } | null;
  verificationPlan: Array<{
    command: string;
    expectedExitCode?: number | null;
    description: string;
  }>;
};

type PlanningMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type ConfigInfo = {
  configured: boolean;
  protocol?: 'openai' | 'claude';
  baseUrl?: string;
  model?: string;
  configPath?: string;
};

type ConfigFormState = {
  protocol: 'openai' | 'claude';
  apiKey: string;
  baseUrl: string;
  model: string;
};

const TERMINAL_STATUSES = new Set(['accepted', 'failed', 'blocked', 'cancelled']);
const WORKER_ROLES = new Set(['codex', 'claude']);

function App() {
  const [workspacePath, setWorkspacePath] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceContextDto[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceContextDto | null>(null);
  const [phase, setPhase] = useState<Phase>('planning');
  const [hubId, setHubId] = useState<string | null>(null);
  const [workerStrategy, setWorkerStrategy] = useState<WorkerStrategy>('codex');
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const [input, setInput] = useState('');
  const [hubStatus, setHubStatus] = useState<string>('listening');
  const [structuredPlan, setStructuredPlan] = useState<ImplementationPlan | null>(null);
  const [confirmedPlanText, setConfirmedPlanText] = useState<string | null>(null);
  const [planStatus, setPlanStatus] = useState<PlanStatus>('idle');
  const [planningBusy, setPlanningBusy] = useState(false);
  const [structureBusy, setStructureBusy] = useState(false);
  const [confirmingPlan, setConfirmingPlan] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [streamingRoles, setStreamingRoles] = useState<Set<string>>(new Set());
  const [activeWorkers, setActiveWorkers] = useState<Set<string>>(new Set());
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [configForm, setConfigForm] = useState<ConfigFormState>({
    protocol: 'openai',
    apiKey: '',
    baseUrl: '',
    model: '',
  });
  const [showConfig, setShowConfig] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const revealTimersRef = useRef<Map<string, number>>(new Map());
  const phaseRef = useRef<Phase>('planning');
  const structuredPlanRequestRef = useRef(0);
  const workspaceId = workspace?.workspaceId ?? null;
  const scopedApi = workspaceId ? `/api/workspaces/${workspaceId}` : null;

  const latestMyHeadMessage = useMemo(() => (
    [...messages].reverse().find((message) => message.role === 'myhead')
  ), [messages]);
  const latestPlanText = latestMyHeadMessage?.content.trim() ?? '';
  const hasConfirmablePlan = phase === 'planning' && Boolean(latestPlanText) && !latestMyHeadMessage?.isStreaming;

  const activityLabel = useMemo(() => {
    if (confirmingPlan) return '正在创建执行 Hub';
    if (planningBusy) return 'MyHead 正在回复';
    if (structureBusy && phase === 'planning') return '正在抽取结构化实施计划';
    if (streamingRoles.size > 0) return `${[...streamingRoles].map(formatRole).join('、')} 正在输出`;
    if (reviewing) return 'MyHead 正在审查 hub 消息';
    if (activeWorkers.size > 0) return `${[...activeWorkers].map(formatRole).join('、')} 正在执行`;
    if (TERMINAL_STATUSES.has(hubStatus)) return `Hub 已结束：${hubStatus}`;
    return phase === 'planning' ? '等待你描述任务' : '监听 Message Hub';
  }, [activeWorkers, confirmingPlan, hubStatus, phase, planningBusy, reviewing, streamingRoles, structureBusy]);

  const statusTone = hubStatus === 'accepted' ? 'bg-emerald-400'
    : hubStatus === 'failed' ? 'bg-rose-400'
    : hubStatus === 'listening' ? 'bg-sky-400'
    : 'bg-amber-300';

  const scrollToBottom = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  const updateMessages = useCallback((updater: (prev: Message[]) => Message[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      messagesRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => () => {
    for (const timer of revealTimersRef.current.values()) window.clearTimeout(timer);
    revealTimersRef.current.clear();
  }, []);

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((data: ConfigInfo) => {
        setConfig(data);
        setShowConfig(!data.configured);
        setConfigForm((prev) => ({
          ...prev,
          protocol: data.protocol ?? prev.protocol,
          baseUrl: data.baseUrl ?? prev.baseUrl,
          model: data.model ?? prev.model,
        }));
      })
      .catch(() => {
        setConfig({ configured: false });
        setShowConfig(true);
      });
  }, []);

  const selectWorkspace = useCallback((nextWorkspace: WorkspaceContextDto) => {
    setWorkspace(nextWorkspace);
    setWorkspacePath(nextWorkspace.absolutePath);
    setWorkspaces((prev) => {
      const without = prev.filter((w) => w.workspaceId !== nextWorkspace.workspaceId);
      return [nextWorkspace, ...without];
    });
    setPhase('planning');
    setHubId(null);
    messagesRef.current = [];
    setMessages([]);
    setInput('');
    setHubStatus('listening');
    setStructuredPlan(null);
    setConfirmedPlanText(null);
    setPlanStatus('idle');
    setPlanningBusy(false);
    setStructureBusy(false);
    setConfirmingPlan(false);
    setReviewing(false);
    setStreamingRoles(new Set());
    setActiveWorkers(new Set());
    setError(null);
  }, []);

  useEffect(() => {
    fetch('/api/workspaces')
      .then((res) => res.json())
      .then((data: { workspaces?: WorkspaceContextDto[] }) => {
        const nextWorkspaces = data.workspaces ?? [];
        setWorkspaces(nextWorkspaces);
        if (!workspace && nextWorkspaces.length > 0) {
          selectWorkspace(nextWorkspaces[0]);
        }
      })
      .catch(() => {
        setError('无法连接 MyHead daemon。');
      });
  }, [selectWorkspace, workspace]);

  const appendDelta = useCallback((streamId: string, role: string, delta: string, timestamp = Date.now()) => {
    if (!delta) return;
    updateMessages((prev) => {
      const id = `stream:${streamId}`;
      const index = prev.findIndex((message) => message.id === id);
      if (index === -1) {
        return [...prev, {
          id,
          streamId,
          role,
          content: delta,
          timestamp,
          isStreaming: true,
        }];
      }
      const next = [...prev];
      const updated = {
        ...next[index],
        content: `${next[index].content}${delta}`,
        timestamp,
        isStreaming: true,
      };
      delete updated.pendingLabel;
      next[index] = updated;
      return next;
    });
  }, [updateMessages]);

  const updateStreamPendingLabel = useCallback((streamId: string, label: string) => {
    updateMessages((prev) => prev.map((message) => (
      message.id === `stream:${streamId}` && message.content.length === 0
        ? { ...message, pendingLabel: label, isStreaming: true }
        : message
    )));
  }, [updateMessages]);

  const revealMessage = useCallback((message: Message) => {
    const fullText = message.content;
    const id = message.id;
    const step = Math.max(1, Math.ceil(fullText.length / 90));

    let cursor = 0;
    const tick = () => {
      cursor = Math.min(fullText.length, cursor + step);
      updateMessages((prev) => prev.map((item) => (
        item.id === id
          ? { ...item, content: fullText.slice(0, cursor), isStreaming: cursor < fullText.length }
          : item
      )));
      if (cursor < fullText.length) {
        const timer = window.setTimeout(tick, 14);
        revealTimersRef.current.set(id, timer);
      } else {
        revealTimersRef.current.delete(id);
      }
    };
    tick();
  }, [updateMessages]);

  const addLiveHubMessage = useCallback((ev: Extract<MyHeadSseEvent, { type: 'hub_message' }>) => {
    const message: Message = {
      id: ev.id ? `hub:${ev.id}` : `hub:${ev.role}:${ev.timestamp}`,
      serverId: ev.id,
      role: ev.role,
      content: ev.content,
      timestamp: ev.timestamp,
      ...(ev.snapshot ? { snapshot: true } : {}),
    };
    const isSnapshot = ev.snapshot === true;
    const current = messagesRef.current;
    const hasDuplicate = Boolean(message.serverId && current.some((item) => item.serverId === message.serverId));
    const localIndex = findLastIndex(current, (item) => (
      item.isLocal === true && item.role === ev.role && item.content.trim() === ev.content.trim()
    ));
    const streamIndex = !isSnapshot && ev.role !== 'user'
      ? findLastIndex(current, (item) => item.isStreaming === true && item.role === ev.role)
      : -1;
    const shouldReveal = !hasDuplicate && localIndex === -1 && streamIndex === -1 && !isSnapshot;

    updateMessages((prev) => {
      if (message.serverId && prev.some((item) => item.serverId === message.serverId)) return prev;

      const nextLocalIndex = findLastIndex(prev, (item) => (
        item.isLocal === true && item.role === ev.role && item.content.trim() === ev.content.trim()
      ));
      if (nextLocalIndex !== -1) {
        const next = [...prev];
        next[nextLocalIndex] = message;
        return next;
      }

      const nextStreamIndex = !isSnapshot && ev.role !== 'user'
        ? findLastIndex(prev, (item) => item.isStreaming === true && item.role === ev.role)
        : -1;
      if (nextStreamIndex !== -1) {
        const next = [...prev];
        next[nextStreamIndex] = message;
        return next;
      }

      if (isSnapshot) return [...prev, message];
      return [...prev, { ...message, content: '', isStreaming: true }];
    });

    if (shouldReveal) {
      window.setTimeout(() => revealMessage(message), 0);
    }
  }, [revealMessage, updateMessages]);

  const handleSseEvent = useCallback((ev: MyHeadSseEvent) => {
    switch (ev.type) {
      case 'hub_status':
        setHubStatus(ev.status);
        if (TERMINAL_STATUSES.has(ev.status)) {
          setActiveWorkers(new Set());
          setStreamingRoles(new Set());
          setReviewing(false);
        }
        break;
      case 'hub_message_delta':
        appendDelta(ev.streamId, ev.role, ev.delta, ev.timestamp);
        setStreamingRoles((prev) => new Set(prev).add(ev.role));
        break;
      case 'hub_message':
        addLiveHubMessage(ev);
        if (!ev.snapshot) {
          setStreamingRoles((prev) => {
            const next = new Set(prev);
            next.delete(ev.role);
            return next;
          });
          if (WORKER_ROLES.has(ev.role)) {
            setActiveWorkers((prev) => {
              const next = new Set(prev);
              next.delete(ev.role);
              return next;
            });
          }
          if (ev.role === 'myhead') setReviewing(false);
        }
        break;
      case 'worker_dispatch':
        setActiveWorkers((prev) => new Set(prev).add(ev.agent));
        break;
      case 'review_started':
        setReviewing(true);
        break;
      case 'review_completed':
        setReviewing(false);
        break;
      case 'worker_output':
        appendDelta(`legacy:${ev.agent}:${Date.now()}`, ev.agent, ev.text);
        break;
      case 'error':
        setError(ev.message);
        break;
    }
  }, [addLiveHubMessage, appendDelta]);

  useSse(hubId && scopedApi ? `${scopedApi}/hub/${hubId}/events` : null, handleSseEvent);

  const pickWorkspace = async () => {
    try {
      const res = await fetch('/api/pick-workspace', { method: 'POST' });
      const data = await res.json() as { path?: string; workspace?: WorkspaceContextDto };
      if (data.workspace) {
        selectWorkspace(data.workspace);
      } else if (data.path) {
        setWorkspacePath(data.path);
      }
      setError(null);
    } catch {
      setError('无法打开工作区选择器。');
    }
  };

  const registerWorkspace = async () => {
    if (!workspacePath.trim()) return;
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: workspacePath.trim() }),
    });
    const data = await res.json() as { workspace?: WorkspaceContextDto; error?: string; message?: string };
    if (data.workspace) {
      selectWorkspace(data.workspace);
      setError(null);
    } else {
      setError(data.message ?? data.error ?? '工作区注册失败。');
    }
  };

  const toPlanningMessages = (source: Message[]): PlanningMessage[] => source
    .filter((message) => message.role === 'user' || message.role === 'myhead')
    .map((message) => ({
      role: message.role === 'user' ? 'user' : 'assistant',
      content: message.content,
    }));

  const refreshStructuredPlan = async (planningMessages: PlanningMessage[]) => {
    if (!scopedApi || planningMessages.length === 0) return;
    const requestId = ++structuredPlanRequestRef.current;
    setPlanStatus('drafting');
    setStructureBusy(true);
    try {
      const res = await fetch(`${scopedApi}/plan/structured`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: planningMessages }),
      });
      const data = await res.json() as { plan?: ImplementationPlan; error?: string; message?: string };
      if (requestId !== structuredPlanRequestRef.current || phaseRef.current !== 'planning') return;
      if (!res.ok || !data.plan) {
        setPlanStatus('failed');
        return;
      }
      setStructuredPlan(data.plan);
      setWorkerStrategy(data.plan.workerStrategy);
      setPlanStatus('ready');
    } catch {
      if (requestId !== structuredPlanRequestRef.current || phaseRef.current !== 'planning') return;
      setPlanStatus('failed');
    } finally {
      if (requestId === structuredPlanRequestRef.current && phaseRef.current === 'planning') {
        setStructureBusy(false);
      }
    }
  };

  const sendPlanningMessage = async () => {
    if (!input.trim() || !scopedApi || planningBusy) return;
    if (!config?.configured) {
      setShowConfig(true);
      setError('请先配置 MyHead 使用的 supervisor 模型。');
      return;
    }
    const content = input.trim();
    const userMsg: Message = {
      id: `local:user:${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
      isLocal: true,
    };
    const assistantStreamId = `planning:${Date.now()}`;
    const myHeadPlaceholder: Message = {
      id: `stream:${assistantStreamId}`,
      streamId: assistantStreamId,
      role: 'myhead',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      pendingLabel: '已连接 MyHead，等待模型输出...',
    };
    const messagesWithUser = [...messages, userMsg];
    const visibleMessages = [...messages, { ...userMsg, content: '', isStreaming: true }, myHeadPlaceholder];
    messagesRef.current = visibleMessages;
    setMessages(visibleMessages);
    window.setTimeout(() => revealMessage(userMsg), 0);
    setInput('');
    setPlanningBusy(true);
    setStructuredPlan(null);
    setPlanStatus('idle');
    setError(null);

    try {
      const planningMessages = toPlanningMessages(messagesWithUser);
      const res = await fetch(`${scopedApi}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, messages: planningMessages }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { message?: string; error?: string } | null;
        const message = data?.message ?? data?.error ?? `规划请求失败：HTTP ${res.status}`;
        setError(message);
        updateMessages((prev) => prev.map((item) => (
          item.id === `stream:${assistantStreamId}`
            ? clearPendingLabel({ ...item, content: message, isStreaming: false })
            : item
        )));
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        const message = '规划请求没有返回可读取的流。';
        setError(message);
        updateMessages((prev) => prev.map((item) => (
          item.id === `stream:${assistantStreamId}`
            ? clearPendingLabel({ ...item, content: message, isStreaming: false })
            : item
        )));
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';

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
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as { type?: string; content?: string; message?: string };
            if (parsed.type === 'text_delta' && parsed.content) {
              assistantText += parsed.content;
              appendDelta(assistantStreamId, 'myhead', parsed.content);
            } else if (parsed.type === 'status' && parsed.message) {
              updateStreamPendingLabel(assistantStreamId, parsed.message);
            } else if (parsed.type === 'error') {
              const message = parsed.message ?? '规划失败。';
              setError(message);
              updateMessages((prev) => prev.map((item) => (
                item.id === `stream:${assistantStreamId}`
                  ? clearPendingLabel({ ...item, content: message, isStreaming: false })
                  : item
              )));
            }
          } catch {
            // Ignore malformed SSE frames.
          }
        }
      }

      if (assistantText) {
        const finalMyHeadMessage: Message = {
          id: `planning:myhead:${Date.now()}`,
          role: 'myhead',
          content: assistantText,
          timestamp: Date.now(),
        };
        updateMessages((prev) => {
          const streamIndex = prev.findIndex((message) => message.id === `stream:${assistantStreamId}`);
          if (streamIndex === -1) return [...prev, finalMyHeadMessage];
          const next = [...prev];
          next[streamIndex] = finalMyHeadMessage;
          return next;
        });
        void refreshStructuredPlan(toPlanningMessages([...messagesWithUser, finalMyHeadMessage]));
      } else {
        updateMessages((prev) => prev.map((item) => (
          item.id === `stream:${assistantStreamId}`
            ? clearPendingLabel({
                ...item,
                content: item.content || 'MyHead 本次没有返回文本。请检查模型配置或稍后重试。',
                isStreaming: false,
              })
            : item
        )));
      }
    } catch (err) {
      setError(`规划错误：${err instanceof Error ? err.message : String(err)}`);
      updateMessages((prev) => prev.map((item) => (
        item.id === `stream:${assistantStreamId}`
          ? clearPendingLabel({
              ...item,
              content: `规划错误：${err instanceof Error ? err.message : String(err)}`,
              isStreaming: false,
            })
          : item
      )));
    } finally {
      setPlanningBusy(false);
    }
  };

  const confirmPlan = async () => {
    if (!scopedApi || !hasConfirmablePlan || confirmingPlan) return;
    if (!config?.configured) {
      setShowConfig(true);
      setError('请先配置 MyHead 使用的 supervisor 模型。');
      return;
    }

    const planToConfirm = structuredPlan ? { ...structuredPlan, workerStrategy } : null;
    setConfirmingPlan(true);
    try {
      const res = await fetch(`${scopedApi}/hub`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planText: planToConfirm ? undefined : latestPlanText,
          planEncoded: planToConfirm ? encodePlan(planToConfirm) : undefined,
          workerStrategy,
        }),
      });
      const data = await res.json() as { hubId?: string; error?: string; message?: string };
      if (data.hubId) {
        setConfirmedPlanText(latestPlanText);
        structuredPlanRequestRef.current += 1;
        setStructureBusy(false);
        messagesRef.current = [];
        setMessages([]);
        setHubStatus('listening');
        setHubId(data.hubId);
        setPhase('executing');
        setError(null);
      } else {
        setError(data.message ?? data.error ?? 'Hub 创建失败。');
      }
    } catch (err) {
      setError(`Hub 创建错误：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConfirmingPlan(false);
    }
  };

  const sendHubMessage = async () => {
    if (!input.trim() || !hubId || !scopedApi) return;
    const content = input.trim();
    setInput('');
    try {
      const res = await fetch(`${scopedApi}/hub/${hubId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { message?: string; error?: string } | null;
        setError(data?.message ?? data?.error ?? `Hub 消息发送失败：HTTP ${res.status}`);
        return;
      }
      setError(null);
    } catch (err) {
      setError(`Hub 消息错误：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const cancelHub = async () => {
    if (!hubId || !scopedApi) return;
    try {
      const res = await fetch(`${scopedApi}/hub/${hubId}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { message?: string; error?: string } | null;
        setError(data?.message ?? data?.error ?? `取消失败：HTTP ${res.status}`);
        return;
      }
      setHubStatus('cancelled');
      setError(null);
    } catch (err) {
      setError(`取消错误：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const saveConfig = async () => {
    if (!configForm.apiKey.trim() || !configForm.model.trim()) {
      setError('API key 和 model 都必须填写。');
      return;
    }
    setConfigSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocol: configForm.protocol,
          apiKey: configForm.apiKey.trim(),
          baseUrl: configForm.baseUrl.trim() || undefined,
          model: configForm.model.trim(),
        }),
      });
      const data = await res.json() as ConfigInfo & { error?: string; message?: string };
      if (!res.ok || !data.configured) {
        setError(data.message ?? data.error ?? '模型配置保存失败。');
        return;
      }
      setConfig(data);
      setConfigForm((prev) => ({
        ...prev,
        apiKey: '',
        protocol: data.protocol ?? prev.protocol,
        baseUrl: data.baseUrl ?? '',
        model: data.model ?? prev.model,
      }));
      setShowConfig(false);
      setError(null);
    } catch (err) {
      setError(`模型配置保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConfigSaving(false);
    }
  };

  const handleSend = () => {
    if (!input.trim()) return;
    if (phase === 'planning') void sendPlanningMessage();
    else void sendHubMessage();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey || e.altKey) return;
    if (isComposingRef.current || e.nativeEvent.isComposing) return;
    e.preventDefault();
    handleSend();
  };

  const canSend = Boolean(
    workspaceId &&
    config?.configured &&
    !confirmingPlan &&
    !planningBusy &&
    (phase === 'planning' || !TERMINAL_STATUSES.has(hubStatus)),
  );
  const canSubmitMessage = canSend && input.trim().length > 0;

  return (
    <div className="h-[100dvh] overflow-hidden bg-[#090b0c] text-[#e7ecec]">
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        <TopBar
          workspacePath={workspacePath}
          workspaces={workspaces}
          workspaceId={workspaceId}
          hubStatus={hubStatus}
          statusTone={statusTone}
          config={config}
          onWorkspacePathChange={setWorkspacePath}
          onPickWorkspace={pickWorkspace}
          onRegisterWorkspace={registerWorkspace}
          onToggleConfig={() => setShowConfig((visible) => !visible)}
          onSelectWorkspace={(selectedId) => {
            const selected = workspaces.find((item) => item.workspaceId === selectedId);
            if (selected) selectWorkspace(selected);
          }}
        />

        <main className="grid min-h-0 grid-cols-[minmax(0,1fr)_420px] overflow-hidden border-t border-white/8">
          <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden border-r border-white/8">
            <WorkspaceHeader
              phase={phase}
              hubId={hubId}
              activityLabel={activityLabel}
              busy={planningBusy || structureBusy || confirmingPlan || reviewing || streamingRoles.size > 0 || activeWorkers.size > 0}
            />

            <div className="min-h-0 overflow-y-auto overscroll-contain px-6 py-5">
              <div className="mx-auto flex max-w-5xl flex-col gap-4">
                {error && <InlineError message={error} />}
                {showConfig && (
                  <ConfigPanel
                    config={config}
                    form={configForm}
                    saving={configSaving}
                    onChange={setConfigForm}
                    onSave={saveConfig}
                    onClose={() => setShowConfig(false)}
                  />
                )}
                {messages.length === 0 && !showConfig ? <EmptyTimeline phase={phase} /> : null}
                <MessageTimeline messages={messages} />
                <div ref={chatEndRef} />
              </div>
            </div>

            <Composer
              phase={phase}
              input={input}
              canSubmit={canSubmitMessage}
              disabled={!canSend}
              terminal={TERMINAL_STATUSES.has(hubStatus)}
              planningBusy={planningBusy}
              onInputChange={setInput}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { isComposingRef.current = true; }}
              onCompositionEnd={() => { isComposingRef.current = false; }}
              onSend={handleSend}
              hasConfirmablePlan={hasConfirmablePlan}
              confirmingPlan={confirmingPlan}
              structureBusy={structureBusy}
              workerStrategy={workerStrategy}
              onWorkerStrategyChange={setWorkerStrategy}
              onConfirmPlan={confirmPlan}
              showCancel={phase === 'executing' && !TERMINAL_STATUSES.has(hubStatus)}
              onCancel={cancelHub}
            />
          </section>

          <aside className="min-h-0 overflow-y-auto overscroll-contain bg-[#0d1011]">
            <SidePanel
              phase={phase}
              hubId={hubId}
              hubStatus={hubStatus}
              config={config}
              plan={structuredPlan}
              planStatus={planStatus}
              structureBusy={structureBusy}
              fallbackText={confirmedPlanText ?? (phase === 'planning' ? latestPlanText : null)}
              activeWorkers={activeWorkers}
              streamingRoles={streamingRoles}
              reviewing={reviewing}
            />
          </aside>
        </main>
      </div>
    </div>
  );
}

function TopBar({
  workspacePath,
  workspaces,
  workspaceId,
  hubStatus,
  statusTone,
  config,
  onWorkspacePathChange,
  onPickWorkspace,
  onRegisterWorkspace,
  onToggleConfig,
  onSelectWorkspace,
}: {
  workspacePath: string;
  workspaces: WorkspaceContextDto[];
  workspaceId: string | null;
  hubStatus: string;
  statusTone: string;
  config: ConfigInfo | null;
  onWorkspacePathChange: (value: string) => void;
  onPickWorkspace: () => void;
  onRegisterWorkspace: () => void;
  onToggleConfig: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
}) {
  return (
    <header className="grid min-h-16 grid-cols-[auto_minmax(240px,1fr)_auto_auto_auto] items-center gap-3 bg-[#0b0e0f] px-4">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/[0.03] font-mono text-sm font-semibold text-emerald-200">
          mh
        </div>
        <div>
          <div className="text-sm font-semibold text-white">MyHead</div>
          <div className="text-[11px] text-white/40">agent supervisor shell</div>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <button className="control-button" onClick={onPickWorkspace}>打开</button>
        <input
          value={workspacePath}
          onChange={(event) => onWorkspacePathChange(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs text-white/80 outline-none transition focus:border-emerald-300/50"
          placeholder="工作区路径"
        />
        <button className="control-button" onClick={onRegisterWorkspace}>使用</button>
      </div>

      {workspaces.length > 0 && (
        <select
          value={workspaceId ?? ''}
          onChange={(event) => onSelectWorkspace(event.target.value)}
          className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/75 outline-none focus:border-emerald-300/50"
        >
          <option value="" disabled>Workspace</option>
          {workspaces.map((item) => (
            <option key={item.workspaceId} value={item.workspaceId}>{item.displayName}</option>
          ))}
        </select>
      )}

      <button
        onClick={onToggleConfig}
        className={`control-button ${config?.configured ? '' : 'border-amber-300/40 text-amber-100'}`}
      >
        模型配置
      </button>

      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
        <span className={`h-2 w-2 rounded-full ${statusTone}`} />
        <span className="font-mono text-xs text-white/55">{hubStatus}</span>
      </div>
    </header>
  );
}

function WorkspaceHeader({
  phase,
  hubId,
  activityLabel,
  busy,
}: {
  phase: Phase;
  hubId: string | null;
  activityLabel: string;
  busy: boolean;
}) {
  return (
    <div className="border-b border-white/8 bg-[#0b0e0f]/95 px-6 py-4">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase text-white/40">
            {phase === 'planning' ? 'Planning Chat' : 'Message Hub'}
          </div>
          <h1 className="mt-1 text-xl font-semibold tracking-[-0.01em] text-white">
            {phase === 'planning' ? '先和 MyHead 定实施方案' : '观察 MyHead 与 worker 的全部交互'}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {hubId && <span className="rounded-md bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-white/40">{hubId.slice(0, 8)}</span>}
          <ActivityPill label={activityLabel} busy={busy} />
        </div>
      </div>
    </div>
  );
}

function ActivityPill({ label, busy }: { label: string; busy: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/65">
      <span className={`h-1.5 w-1.5 rounded-full ${busy ? 'animate-pulse bg-emerald-300' : 'bg-white/25'}`} />
      {label}
    </div>
  );
}

function MessageTimeline({ messages }: { messages: Message[] }) {
  return (
    <div className="flex flex-col gap-3">
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <article className={`group grid min-w-0 grid-cols-[74px_minmax(0,1fr)] gap-3 ${isUser ? 'opacity-95' : ''}`}>
      <div className="pt-2 text-right font-mono text-[11px] text-white/35">
        {formatRole(message.role)}
      </div>
      <div className={`${isUser ? 'justify-self-end bg-emerald-300 text-[#06100d]' : roleSurface(message.role)} min-w-0 max-w-[min(860px,88%)] rounded-xl border px-4 py-3 shadow-[0_20px_80px_rgba(0,0,0,0.22)]`}>
        {message.content ? (
          <pre className="min-w-0 whitespace-pre-wrap break-words font-sans text-sm leading-6">{message.content}</pre>
        ) : message.pendingLabel ? (
          <div className="flex items-center gap-2 text-sm leading-6 opacity-70">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            {message.pendingLabel}
          </div>
        ) : null}
        {message.isStreaming && (
          <span className="mt-2 inline-flex items-center gap-1 font-mono text-[11px] opacity-60">
            streaming<span className="inline-block h-3 w-1 animate-pulse bg-current" />
          </span>
        )}
      </div>
    </article>
  );
}

function Composer({
  phase,
  input,
  canSubmit,
  disabled,
  terminal,
  planningBusy,
  onInputChange,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onSend,
  hasConfirmablePlan,
  confirmingPlan,
  structureBusy,
  workerStrategy,
  onWorkerStrategyChange,
  onConfirmPlan,
  showCancel,
  onCancel,
}: {
  phase: Phase;
  input: string;
  canSubmit: boolean;
  disabled: boolean;
  terminal: boolean;
  planningBusy: boolean;
  onInputChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onSend: () => void;
  hasConfirmablePlan: boolean;
  confirmingPlan: boolean;
  structureBusy: boolean;
  workerStrategy: WorkerStrategy;
  onWorkerStrategyChange: (value: WorkerStrategy) => void;
  onConfirmPlan: () => void;
  showCancel: boolean;
  onCancel: () => void;
}) {
  return (
    <footer className="border-t border-white/8 bg-[#0b0e0f] px-6 py-4">
      <div className="mx-auto max-w-5xl">
        {phase === 'planning' && hasConfirmablePlan && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select
              value={workerStrategy}
              onChange={(event) => onWorkerStrategyChange(event.target.value as WorkerStrategy)}
              className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/75 outline-none"
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
              <option value="both">Codex + Claude</option>
            </select>
            <button
              onClick={onConfirmPlan}
              disabled={confirmingPlan}
              className="rounded-lg bg-emerald-300 px-4 py-2 text-sm font-semibold text-[#06100d] transition hover:bg-emerald-200 active:translate-y-px disabled:opacity-60"
            >
              {confirmingPlan ? '创建 Hub 中' : '确认方案并开始'}
            </button>
            {structureBusy && (
              <span className="text-xs text-white/45">结构化计划仍在生成，你可以先确认当前文本方案。</span>
            )}
          </div>
        )}

        {showCancel && (
          <div className="mb-3">
            <button onClick={onCancel} className="rounded-lg border border-rose-300/25 bg-rose-500/10 px-4 py-2 text-sm text-rose-100 transition hover:bg-rose-500/15">
              取消执行
            </button>
          </div>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)_92px] gap-3">
          <textarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            disabled={disabled || terminal}
            placeholder={
              terminal ? 'Hub 已结束'
                : phase === 'planning' ? '描述你想让 MyHead 监督 agent 完成的任务'
                : '向 MyHead 发送补充要求'
            }
            className="min-h-20 resize-none rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm leading-6 text-white/85 outline-none transition placeholder:text-white/25 focus:border-emerald-300/45 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            onClick={onSend}
            disabled={!canSubmit}
            className="rounded-xl bg-white px-4 py-3 text-sm font-semibold text-[#070909] transition hover:bg-emerald-100 active:translate-y-px disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/30"
          >
            {planningBusy ? '等待' : '发送'}
          </button>
        </div>
      </div>
    </footer>
  );
}

function SidePanel({
  phase,
  hubId,
  hubStatus,
  config,
  plan,
  planStatus,
  structureBusy,
  fallbackText,
  activeWorkers,
  streamingRoles,
  reviewing,
}: {
  phase: Phase;
  hubId: string | null;
  hubStatus: string;
  config: ConfigInfo | null;
  plan: ImplementationPlan | null;
  planStatus: PlanStatus;
  structureBusy: boolean;
  fallbackText: string | null;
  activeWorkers: Set<string>;
  streamingRoles: Set<string>;
  reviewing: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 p-5">
      <PanelBlock title="Hub">
        <dl className="grid gap-3 text-xs">
          <InfoRow label="Status" value={hubStatus} />
          <InfoRow label="ID" value={hubId ? `${hubId.slice(0, 8)}...` : '尚未创建'} />
          <InfoRow label="Mode" value={phase === 'planning' ? 'Planning' : 'Execution'} />
        </dl>
      </PanelBlock>

      <PanelBlock title="Agents">
        <div className="space-y-3 text-xs">
          <div className="rounded-lg border border-white/8 bg-black/18 p-3">
            <div className="mb-1 text-white/35">MyHead Model</div>
            <div className="text-white/75">{config?.configured ? `${config.protocol} / ${config.model}` : '未配置'}</div>
          </div>
          <AgentLine name="MyHead" active={reviewing || streamingRoles.has('myhead')} tone="bg-emerald-300" />
          <AgentLine name="Claude Code" active={activeWorkers.has('claude') || streamingRoles.has('claude')} tone="bg-violet-300" />
          <AgentLine name="Codex CLI" active={activeWorkers.has('codex') || streamingRoles.has('codex')} tone="bg-sky-300" />
        </div>
      </PanelBlock>

      <PlanPanel
        plan={plan}
        status={planStatus}
        structureBusy={structureBusy}
        fallbackText={fallbackText}
      />
    </div>
  );
}

function AgentLine({ name, active, tone }: { name: string; active: boolean; tone: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-white/8 bg-white/[0.025] px-3 py-2">
      <span className="text-white/65">{name}</span>
      <span className="flex items-center gap-2 text-white/40">
        <span className={`h-1.5 w-1.5 rounded-full ${active ? `${tone} animate-pulse` : 'bg-white/20'}`} />
        {active ? 'active' : 'idle'}
      </span>
    </div>
  );
}

function PanelBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/8 bg-white/[0.025] p-4">
      <h2 className="mb-3 text-[11px] font-semibold uppercase text-white/35">{title}</h2>
      {children}
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-white/35">{label}</dt>
      <dd className="font-mono text-white/65">{value}</dd>
    </div>
  );
}

function PlanPanel({
  plan,
  status,
  structureBusy,
  fallbackText,
}: {
  plan: ImplementationPlan | null;
  status: PlanStatus;
  structureBusy: boolean;
  fallbackText?: string | null;
}) {
  return (
    <PanelBlock title="Implementation Plan">
      <div className="mb-3 flex items-center justify-between text-xs">
        <span className="text-white/40">{structureBusy ? 'function call 生成中' : statusText(status)}</span>
        {structureBusy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />}
      </div>
      {!plan ? (
        fallbackText ? (
          <pre className="max-h-[520px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/8 bg-black/20 p-3 text-xs leading-5 text-white/65">
            {fallbackText}
          </pre>
        ) : (
          <div className="rounded-lg border border-dashed border-white/10 p-4 text-sm text-white/35">
            MyHead 回复实施方案后，这里会显示可确认的计划。
          </div>
        )
      ) : (
        <div className="space-y-4 text-sm">
          <section>
            <h3 className="mb-1 text-xs font-semibold text-white/35">Goal</h3>
            <p className="leading-6 text-white/78">{plan.goal}</p>
          </section>
          <section>
            <h3 className="mb-2 text-xs font-semibold text-white/35">Steps</h3>
            <div className="space-y-2">
              {plan.steps.map((step) => (
                <div key={step.id} className="rounded-lg border border-white/8 bg-black/16 p-3">
                  <div className="mb-1 font-mono text-[11px] text-emerald-200/70">{step.id}</div>
                  <div className="text-white/75">{step.description}</div>
                  <div className="mt-1 text-xs text-white/35">{step.expectedOutput}</div>
                </div>
              ))}
            </div>
          </section>
          <PlanList title="Success Criteria" items={plan.successCriteria} />
          <PlanList title="Constraints" items={plan.constraints} />
          {plan.collaborationPlan && (
            <section>
              <h3 className="mb-2 text-xs font-semibold text-white/35">Collaboration</h3>
              <div className="space-y-2">
                {Object.entries(plan.collaborationPlan.assignments).map(([agent, assignments]) => (
                  <div key={agent} className="rounded-lg border border-white/8 bg-black/16 p-3 text-xs">
                    <div className="mb-1 font-semibold text-white/75">{formatRole(agent)}</div>
                    <ul className="space-y-1 text-white/55">
                      {assignments.map((assignment, index) => <li key={`${assignment}-${index}`}>{assignment}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}
          {plan.verificationPlan.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold text-white/35">Verification</h3>
              <div className="space-y-2">
                {plan.verificationPlan.map((check, index) => (
                  <div key={`${check.command}-${index}`} className="rounded-lg border border-white/8 bg-black/16 p-3 text-xs">
                    <code className="font-mono text-emerald-100/80">{check.command}</code>
                    <div className="mt-1 text-white/38">{check.description}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </PanelBlock>
  );
}

function PlanList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-white/35">{title}</h3>
      <ul className="space-y-1 text-xs leading-5 text-white/58">
        {items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
      </ul>
    </section>
  );
}

function ConfigPanel({
  config,
  form,
  saving,
  onChange,
  onSave,
  onClose,
}: {
  config: ConfigInfo | null;
  form: ConfigFormState;
  saving: boolean;
  onChange: (form: ConfigFormState) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <section className="rounded-xl border border-emerald-200/15 bg-emerald-200/[0.04] p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-white">MyHead 模型配置</h2>
          <p className="mt-1 text-xs leading-5 text-white/45">
            这里配置的是 MyHead 规划和审查用的 supervisor 模型，不会修改 worker CLI 的账号。
          </p>
          {config?.configPath && <p className="mt-1 font-mono text-[11px] text-white/30">{config.configPath}</p>}
        </div>
        {config?.configured && <button className="text-xs text-white/45 hover:text-white" onClick={onClose}>关闭</button>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Protocol">
          <select
            value={form.protocol}
            onChange={(event) => onChange({ ...form, protocol: event.target.value as ConfigFormState['protocol'] })}
            className="field-input"
          >
            <option value="openai">OpenAI compatible</option>
            <option value="claude">Claude / Anthropic</option>
          </select>
        </Field>
        <Field label="Model">
          <input
            value={form.model}
            onChange={(event) => onChange({ ...form, model: event.target.value })}
            className="field-input"
            placeholder="qwen3.6-plus"
          />
        </Field>
        <Field label="Base URL" wide>
          <input
            value={form.baseUrl}
            onChange={(event) => onChange({ ...form, baseUrl: event.target.value })}
            className="field-input"
            placeholder={form.protocol === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'}
          />
        </Field>
        <Field label="API Key" wide>
          <input
            type="password"
            value={form.apiKey}
            onChange={(event) => onChange({ ...form, apiKey: event.target.value })}
            className="field-input"
            placeholder={config?.configured ? '输入新 key 后保存会覆盖当前配置' : '必填'}
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        {config?.configured && <button className="control-button" onClick={onClose}>取消</button>}
        <button
          onClick={onSave}
          disabled={saving}
          className="rounded-lg bg-emerald-300 px-4 py-2 text-sm font-semibold text-[#06100d] disabled:opacity-60"
        >
          {saving ? '保存中' : '保存配置'}
        </button>
      </div>
    </section>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`text-xs text-white/45 ${wide ? 'col-span-2' : ''}`}>
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function EmptyTimeline({ phase }: { phase: Phase }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-8 text-center">
      <div className="mx-auto max-w-md">
        <div className="text-sm font-semibold text-white/70">
          {phase === 'planning' ? '从任务目标开始' : '等待 hub 消息'}
        </div>
        <p className="mt-2 text-sm leading-6 text-white/38">
          {phase === 'planning'
            ? '告诉 MyHead 你想让 agent 做什么。MyHead 会流式回复方案，方案结束后你可以立即确认。'
            : 'MyHead、worker 和用户消息都会按时间线进入这里。'}
        </p>
      </div>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="max-h-40 overflow-y-auto overscroll-contain break-words rounded-xl border border-rose-300/20 bg-rose-500/10 px-4 py-3 text-sm leading-6 text-rose-100">
      {message}
    </div>
  );
}

function roleSurface(role: string): string {
  if (role === 'myhead') return 'border-emerald-200/15 bg-emerald-200/[0.055] text-emerald-50';
  if (role === 'codex') return 'border-sky-200/15 bg-sky-200/[0.052] text-sky-50';
  if (role === 'claude') return 'border-violet-200/15 bg-violet-200/[0.052] text-violet-50';
  return 'border-white/10 bg-white/[0.04] text-white/78';
}

function formatRole(role: string): string {
  const names: Record<string, string> = {
    myhead: 'MyHead',
    codex: 'Codex',
    claude: 'Claude',
    user: 'You',
  };
  return names[role] ?? role;
}

function statusText(status: PlanStatus): string {
  const names: Record<PlanStatus, string> = {
    idle: '等待方案',
    drafting: '结构化中',
    ready: '已结构化',
    failed: '文本方案可用',
  };
  return names[status];
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function clearPendingLabel(message: Message): Message {
  delete message.pendingLabel;
  return message;
}

function encodePlan(plan: ImplementationPlan): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(plan))));
}

export default App;
