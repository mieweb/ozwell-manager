import { StrictMode, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentConfigGenerator } from '@mieweb/q';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  Select,
  SpinnerWithLabel,
  ThemeProvider,
  ThemeToggle,
} from '@mieweb/ui';
import { ArrowLeft, Bell, Check, ChevronRight, Copy, Eye, KeyRound, Plus, RefreshCw, RotateCcw, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import {
  AgentModelPolicyResponse,
  AgentDetail,
  AgentListItem,
  ApiError,
  KeyResponse,
  ManagerNotification,
  MeResponse,
  ModelListItem,
  ModelRef,
  ParentKeyResponse,
  claimParentKey,
  createAgent,
  deleteAgent,
  getAgent,
  getAgentModelPolicy,
  getMe,
  listNotifications,
  listAgents,
  listEffectiveModels,
  listModels,
  markAllNotificationsRead,
  markNotificationRead,
  revealParentKey,
  revealAgentKey,
  rotateAgentKey,
  updateAgentModelPolicy,
  updateAgent,
} from './api';
import { AdminConsole } from './AdminConsole';
import { BrandInitializer, useBrand } from './brand';
import '@mieweb/q/style.css';
import './styles.css';

type LoadState = 'loading' | 'ready' | 'error';
type Page = 'agents' | 'editor' | 'admin';
type EditorMode = 'create' | 'edit';
type KeyMode = 'reveal' | 'rotate' | 'created' | 'saved';
type ParentKeyDialogMode = 'reveal' | 'claim';

const baseOzwellSchema = {
  schemaType: 'mieforms-v1.0',
  title: 'Ozwell Agent Configuration',
  fields: [
    {
      id: 'sec-basic',
      fieldType: 'section',
      title: 'Basic Info',
      fields: [
        { id: 'name', fieldType: 'text', question: 'Agent Name', answer: 'My Agent', required: true },
        {
          id: 'instructions',
          fieldType: 'longtext',
          question: 'Instructions',
          answer: 'You are a helpful assistant.',
          required: true,
        },
      ],
    },
    {
      id: 'sec-generation',
      fieldType: 'section',
      title: 'Generation Settings',
      fields: [
        {
          id: 'temperature',
          fieldType: 'text',
          question: 'Temperature (0.0 - 1.0)',
          answer: '0.7',
          required: false,
          configType: 'number',
        },
      ],
    },
  ],
};

function cloneSchema() {
  return structuredClone(baseOzwellSchema);
}

function getDisplayName(me?: MeResponse) {
  if (!me) return 'Manager';
  const firstLast = [me.identity.first_name, me.identity.last_name].filter(Boolean).join(' ');
  return firstLast || me.identity.username || me.identity.email || 'Manager';
}

function formatDate(timestamp?: number) {
  if (!timestamp) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp * 1000));
}

function countTools(tools: unknown) {
  return Array.isArray(tools) ? tools.length : 0;
}

function modelProvider(model: ModelListItem | ModelRef) {
  return model.provider || 'unknown';
}

function providerLabel(provider: string) {
  const labels: Record<string, string> = {
    anthropic: 'Anthropic',
    ollama: 'Ollama',
    openai: 'OpenAI',
  };
  return labels[provider.toLowerCase()] || provider;
}

function modelName(model: ModelListItem | ModelRef) {
  return model.model || ('id' in model ? model.id : '');
}

function modelKey(model: ModelListItem | ModelRef) {
  return `${modelProvider(model)}:${modelName(model)}`;
}

function providerWideKey(provider: string) {
  return `${provider}:*`;
}

function selectionKey(model: ModelRef) {
  return model.model ? modelKey(model) : providerWideKey(model.provider);
}

function modelLabel(model: ModelListItem | ModelRef) {
  if ('label' in model && model.label) return model.label;
  const provider = modelProvider(model);
  const name = modelName(model);
  if (!name && provider && provider !== 'unknown') return `${provider} / all models`;
  return provider && provider !== 'unknown' ? `${provider} / ${name}` : name;
}

function enabledModels(models: ModelListItem[]) {
  return models.filter((model) => model.enabled !== false && modelName(model));
}

function groupModelsByProvider(models: ModelListItem[]) {
  return enabledModels(models).reduce<Record<string, ModelListItem[]>>((groups, model) => {
    const provider = modelProvider(model);
    groups[provider] = groups[provider] || [];
    groups[provider].push(model);
    return groups;
  }, {});
}

function agentDisplayProvider(agent: Pick<AgentListItem, 'provider'>): string {
  return agent.provider || '';
}

function initialConfigFromAgent(agent: AgentDetail) {
  return {
    name: agent.name,
    instructions: agent.instructions,
    temperature: agent.temperature,
    tools: Array.isArray(agent.tools) ? agent.tools : [],
    behavior: agent.behavior,
  } as Record<string, unknown>;
}

function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="empty-state" variant="outlined" padding="xl">
      <CardHeader>
        <CardTitle as="h2">{title}</CardTitle>
        <CardDescription>{children}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function Notice({ tone = 'neutral', children }: { tone?: 'neutral' | 'danger' | 'success'; children: React.ReactNode }) {
  const variant = tone === 'neutral' ? 'info' : tone;
  return (
    <Alert className="notice" variant={variant}>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function AgentsPage({
  me,
  agents,
  loading,
  onNew,
  onOpen,
  onRefresh,
  onRevealParentKey,
  onClaimParentKey,
  onModelAccess,
  onReveal,
  onRotate,
  onDelete,
}: {
  me: MeResponse;
  agents: AgentListItem[];
  loading: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRefresh: () => void;
  onRevealParentKey: () => void;
  onClaimParentKey: () => void;
  onModelAccess: (agent: AgentListItem) => void;
  onReveal: (agent: AgentListItem) => void;
  onRotate: (agent: AgentListItem) => void;
  onDelete: (agent: AgentListItem) => void;
}) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredAgents = normalizedQuery
    ? agents.filter((agent) =>
        [agent.name, agent.id, agent.model, agent.key_hint]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(normalizedQuery)),
      )
    : agents;

  return (
    <Card className="agents-page" variant="outlined" padding="none">
      <CardHeader className="panel-head">
        <div>
          <p className="eyebrow">Agents</p>
          <CardTitle as="h2">Your agents</CardTitle>
          <CardDescription>Manage agent configuration, keys, and Q editor access.</CardDescription>
        </div>
        <div className="button-row">
          <Button
            variant="secondary"
            type="button"
            onClick={onRefresh}
            leftIcon={<RefreshCw aria-hidden="true" size={16} />}
          >
            Refresh
          </Button>
          <Button variant="primary" type="button" onClick={onNew} leftIcon={<Plus aria-hidden="true" size={16} />}>
            New agent
          </Button>
        </div>
      </CardHeader>

      {loading ? (
        <CardContent className="loading-content">
          <SpinnerWithLabel label="Fetching your Ozwell agents" />
        </CardContent>
      ) : agents.length === 0 ? (
        <EmptyState title="No agents yet">Create your first agent with the Ozwell Q builder.</EmptyState>
      ) : (
        <CardContent className="agent-list-content">
          <div className="agent-toolbar">
            <label className="agent-search">
              <Search aria-hidden="true" size={16} />
              <span className="sr-only">Search agents</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name, id, model, or key"
              />
            </label>
            <div className="agent-count">
              {filteredAgents.length} of {agents.length} agents
            </div>
          </div>

          <div className="agent-table-scroll">
          <div className="agent-grid-head" aria-hidden="true">
            <span>Name</span>
            <span>Model</span>
            <span>Tools</span>
            <span>Key</span>
            <span>Created</span>
            <span>Actions</span>
          </div>

          {filteredAgents.length === 0 ? (
            <div className="agent-filter-empty">No agents match the current search.</div>
          ) : (
            <div className="agent-grid">
              {filteredAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="agent-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(agent.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpen(agent.id);
                    }
                  }}
                  aria-label={`Open ${agent.name || 'untitled agent'} in Q`}
                >
                  <div className="agent-name-cell">
                    <strong>{agent.name || 'Untitled agent'}</strong>
                    <span>{agent.id}</span>
                  </div>
                  <span className="agent-model-chip">
                    {agentDisplayProvider(agent) && (
                      <span className="agent-model-chip-provider">{providerLabel(agentDisplayProvider(agent))}</span>
                    )}
                    <span className="agent-model-chip-name">{agent.model || 'Not set'}</span>
                  </span>
                  <span className="agent-tools-cell">{countTools(agent.tools)}</span>
                  <span className="agent-key-cell">{agent.key_hint || '-'}</span>
                  <span className="agent-created-cell">{formatDate(agent.created_at)}</span>
                  <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => onModelAccess(agent)}
                      aria-label={`Edit model access for ${agent.name || agent.id}`}
                    >
                      Models
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => onReveal(agent)}
                      leftIcon={<Eye aria-hidden="true" size={15} />}
                      aria-label={`Reveal key for ${agent.name || agent.id}`}
                    >
                      Show
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => onRotate(agent)}
                      leftIcon={<RotateCcw aria-hidden="true" size={15} />}
                      aria-label={`Rotate key for ${agent.name || agent.id}`}
                    >
                      Rotate
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      type="button"
                      onClick={() => onDelete(agent)}
                      leftIcon={<Trash2 aria-hidden="true" size={15} />}
                      aria-label={`Delete ${agent.name || agent.id}`}
                    >
                      Delete
                    </Button>
                    <ChevronRight className="agent-row-chevron" aria-hidden="true" size={17} />
                  </div>
                </div>
              ))}
            </div>
          )}
          </div>{/* agent-table-scroll */}
        </CardContent>
      )}
      <CardContent className="manager-key-panel">
        <div>
          <p className="manager-key-label">Ozwell account key</p>
          <p className="manager-key-copy">
            {me.parent_key_hint || (me.has_parent_key ? 'Available for this manager account' : 'No account key found')}
          </p>
        </div>
        <div className="button-row">
          <Button
            variant="secondary"
            type="button"
            onClick={onRevealParentKey}
            leftIcon={<KeyRound aria-hidden="true" size={16} />}
            disabled={!me.has_parent_key}
          >
            Reveal / Copy Ozwell key
          </Button>
          <Button variant="secondary" type="button" onClick={onClaimParentKey}>
            Claim existing Ozwell key
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function firstModelRef(models: ModelListItem[]): ModelRef | null {
  const first = enabledModels(models)[0];
  return first ? { provider: modelProvider(first), model: modelName(first) } : null;
}

function legacyModelRef(agent: Pick<AgentDetail, 'default_model'> | Pick<AgentListItem, 'default_model'> | null, models: ModelListItem[]) {
  if (agent?.default_model) return agent.default_model;
  return firstModelRef(models);
}

function modelRefInList(ref: ModelRef | null, models: ModelListItem[]) {
  return !!ref?.provider && !!ref.model && enabledModels(models).some((model) => modelKey(model) === modelKey(ref));
}

function normalizeDefaultModel(ref: ModelRef | null, models: ModelListItem[], fallback: ModelRef | null) {
  if (modelRefInList(ref, models)) return { model: ref, changed: false };
  const next = firstModelRef(models) || fallback;
  return { model: next, changed: !!ref?.provider || !!ref?.model };
}

function refsToKeys(models: ModelRef[]) {
  return new Set(models.filter((model) => model.provider).map(selectionKey));
}

function refsFromKeys(keys: Set<string>, models: ModelListItem[]) {
  const refs: ModelRef[] = [];
  const enabled = enabledModels(models);
  const providers = Array.from(new Set(enabled.map(modelProvider))).sort();

  for (const provider of providers) {
    if (keys.has(providerWideKey(provider))) {
      refs.push({ provider });
      continue;
    }
    refs.push(
      ...enabled
        .filter((model) => modelProvider(model) === provider && keys.has(modelKey(model)))
        .map((model) => ({ provider, model: modelName(model) })),
    );
  }

  return refs;
}

function conflictExists(allowedKeys: Set<string>, defaultModel: ModelRef | null) {
  if (!allowedKeys.size) return false;
  if (!defaultModel?.provider || !defaultModel.model) return false;
  return !allowedKeys.has(modelKey(defaultModel)) && !allowedKeys.has(providerWideKey(defaultModel.provider));
}

function ModelAccessControls({
  models,
  defaultModel,
  allowedKeys,
  effectiveModels,
  source,
  disabled = false,
  savingPolicy = false,
  onReset,
  onSave,
  onDefaultModelChange,
  onAllowedKeysChange,
}: {
  models: ModelListItem[];
  defaultModel: ModelRef | null;
  allowedKeys: Set<string>;
  effectiveModels?: ModelListItem[];
  source?: AgentModelPolicyResponse['source'];
  disabled?: boolean;
  savingPolicy?: boolean;
  onReset?: () => void;
  onSave?: () => Promise<void>;
  onDefaultModelChange: (model: ModelRef | null) => void;
  onAllowedKeysChange: (keys: Set<string>) => void;
}) {
  const [filterQuery, setFilterQuery] = useState('');
  const groupedModels = useMemo(() => groupModelsByProvider(models), [models]);
  const providerNames = useMemo(() => Object.keys(groupedModels).sort(), [groupedModels]);
  const selectedProvider = defaultModel?.provider && groupedModels[defaultModel.provider] ? defaultModel.provider : providerNames[0] || '';
  const providerModels = groupedModels[selectedProvider] || [];
  const defaultModelAvailable = defaultModel ? providerModels.some((model) => modelKey(model) === modelKey(defaultModel)) : false;
  const selectedModel = defaultModelAvailable ? defaultModel?.model || '' : modelName(providerModels[0] || { id: '' });
  const restricted = allowedKeys.size > 0;

  const filteredGrouped = useMemo(() => {
    if (!filterQuery.trim()) return groupedModels;
    const q = filterQuery.toLowerCase();
    const result: Record<string, ModelListItem[]> = {};
    for (const [provider, list] of Object.entries(groupedModels)) {
      const filtered = list.filter((m) => modelName(m).toLowerCase().includes(q) || provider.toLowerCase().includes(q));
      if (filtered.length) result[provider] = filtered;
    }
    return result;
  }, [groupedModels, filterQuery]);
  const filteredProviderNames = useMemo(() => Object.keys(filteredGrouped).sort(), [filteredGrouped]);

  function changeProvider(provider: string) {
    const firstForProvider = groupedModels[provider]?.[0];
    onDefaultModelChange(firstForProvider ? { provider, model: modelName(firstForProvider) } : null);
  }

  function changeModel(model: string) {
    onDefaultModelChange(selectedProvider && model ? { provider: selectedProvider, model } : null);
  }

  function enableRestriction() {
    if (restricted) return;
    const seed = new Set<string>();
    if (defaultModel?.provider && defaultModel?.model) seed.add(modelKey(defaultModel));
    onAllowedKeysChange(seed);
  }

  function providerSelected(provider: string) {
    const models = groupedModels[provider] || [];
    return allowedKeys.has(providerWideKey(provider)) || (models.length > 0 && models.every((model) => allowedKeys.has(modelKey(model))));
  }

  function providerModelSelected(model: ModelListItem) {
    return allowedKeys.has(providerWideKey(modelProvider(model))) || allowedKeys.has(modelKey(model));
  }

  function toggleProvider(provider: string, enabled: boolean) {
    const next = new Set(allowedKeys);
    for (const model of groupedModels[provider] || []) {
      next.delete(modelKey(model));
    }
    if (enabled) next.add(providerWideKey(provider));
    else next.delete(providerWideKey(provider));
    onAllowedKeysChange(next);
  }

  function toggleAllowedModel(model: ModelListItem, enabled: boolean) {
    const provider = modelProvider(model);
    const providerModels = groupedModels[provider] || [];
    const next = new Set(allowedKeys);
    next.delete(providerWideKey(provider));
    for (const item of providerModels) {
      const key = modelKey(item);
      if (key === modelKey(model)) {
        if (enabled) next.add(key);
      } else if (providerModelSelected(item)) {
        next.add(key);
      }
    }
    onAllowedKeysChange(next);
  }

  const hasConflict = conflictExists(allowedKeys, defaultModel);

  return (
    <div className="agent-model-controls" aria-label="Model access controls">
      <div className="agent-model-controls-header">
        <span className="agent-model-controls-label">Model access</span>
        <div className="agent-model-controls-actions">
          {onReset && (
            <button type="button" className="agent-model-revert-btn" onClick={onReset} disabled={disabled || savingPolicy}>
              Revert
            </button>
          )}
          {onSave && (
            <button
              type="button"
              className="agent-model-save-btn"
              onClick={onSave}
              disabled={disabled || savingPolicy || hasConflict}
            >
              {savingPolicy ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>

      <div className="agent-model-defaults">
        <label>
          <span>Fallback provider</span>
          <select value={selectedProvider} onChange={(event) => changeProvider(event.target.value)} disabled={disabled || !providerNames.length}>
            {!providerNames.length && <option value="">No providers</option>}
            {providerNames.map((provider) => (
              <option key={provider} value={provider}>{providerLabel(provider)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Fallback model</span>
          <select value={selectedModel} onChange={(event) => changeModel(event.target.value)} disabled={disabled || !providerModels.length}>
            {!providerModels.length && <option value="">No models</option>}
            {providerModels.map((model) => (
              <option key={modelKey(model)} value={modelName(model)}>{modelLabel(model)}</option>
            ))}
          </select>
        </label>
        <p className="agent-model-restriction-hint">Used when a request does not specify a model.</p>
      </div>

      {hasConflict && (
        <p className="agent-model-conflict-warning">Fallback model is not in the allowed list — add it below or change the fallback.</p>
      )}
      {!providerNames.length && <p className="agent-model-restriction-hint">No provider models are currently available.</p>}

      <div className="agent-model-restriction-section">
        <span className="agent-model-controls-sublabel">Allowed models</span>
        <div className="agent-model-mode-toggle">
          <button
            type="button"
            className={`agent-model-mode-btn${!restricted ? ' active' : ''}`}
            onClick={() => onAllowedKeysChange(new Set())}
            disabled={disabled}
          >
            Any model
          </button>
          <button
            type="button"
            className={`agent-model-mode-btn${restricted ? ' active' : ''}`}
            onClick={enableRestriction}
            disabled={disabled}
          >
            Specific models
            {restricted && <span className="agent-model-mode-count">{allowedKeys.size}</span>}
          </button>
        </div>

        {!restricted && (
          <p className="agent-model-restriction-hint">Agent can use any model allowed by the parent key.</p>
        )}

        {restricted && (
          <div className="agent-model-allowlist">
            <input
              className="agent-model-filter"
              type="search"
              placeholder="Filter models…"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              disabled={disabled}
            />
            {filteredProviderNames.length === 0 && (
              <p className="agent-model-filter-empty">No models match "{filterQuery}"</p>
            )}
            <div className="model-restrictions-groups agent-model-groups">
              {filteredProviderNames.map((provider) => {
                const providerList = filteredGrouped[provider] || [];
                const selectedCount = allowedKeys.has(providerWideKey(provider))
                  ? providerList.length
                  : providerList.filter((m) => allowedKeys.has(modelKey(m))).length;
                const allChecked = providerSelected(provider);
                return (
                  <details className="model-provider-group" key={provider} open={!!filterQuery || selectedCount > 0}>
                    <summary>
                      <span>{providerLabel(provider)}</span>
                      <span className={`model-provider-count${selectedCount > 0 ? ' has-selected' : ''}`}>
                        {selectedCount > 0 ? `${selectedCount} of ${providerList.length}` : `${providerList.length} models`}
                      </span>
                    </summary>
                    <div className="model-option-list">
                      <label className="model-option model-provider-toggle-row">
                        <input
                          type="checkbox"
                          checked={allChecked}
                          disabled={disabled}
                          onChange={(event) => toggleProvider(provider, event.target.checked)}
                        />
                        <span>All {providerLabel(provider)} models</span>
                      </label>
                      {providerList.map((model) => (
                        <label className="model-option model-option-indent" key={modelKey(model)}>
                          <input
                            type="checkbox"
                            checked={providerModelSelected(model)}
                            disabled={disabled}
                            onChange={(event) => toggleAllowedModel(model, event.target.checked)}
                          />
                          <span>{modelLabel(model)}</span>
                        </label>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
            {effectiveModels && effectiveModels.length > 0 && (
              <div className="effective-models">
                <span>Active for agent</span>
                <div>
                  {effectiveModels.slice(0, 8).map((model) => (
                    <Badge key={modelKey(model)} variant="secondary" size="sm">{modelLabel(model)}</Badge>
                  ))}
                  {effectiveModels.length > 8 && <Badge variant="secondary" size="sm">+{effectiveModels.length - 8} more</Badge>}
                </div>
              </div>
            )}
          </div>
        )}

        {source === 'legacy_yaml' && (
          <p className="model-policy-help">Policy was read from agent YAML — saving will move it to the database.</p>
        )}
      </div>
    </div>
  );
}

function AgentModelPolicyDialog({
  agent,
  models,
  onClose,
  onSaved,
}: {
  agent: Pick<AgentListItem, 'id' | 'name' | 'provider' | 'model' | 'default_model'>;
  models: ModelListItem[];
  onClose: () => void;
  onSaved?: () => Promise<void>;
}) {
  const [state, setState] = useState<LoadState>('loading');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [success, setSuccess] = useState('');
  const fallbackDefault = useMemo(() => legacyModelRef(agent, models), [agent, models]);
  const [defaultModel, setDefaultModel] = useState<ModelRef | null>(fallbackDefault);
  const [allowedKeys, setAllowedKeys] = useState<Set<string>>(new Set());
  const [policy, setPolicy] = useState<AgentModelPolicyResponse | null>(null);
  const modelOptions = policy ? policy.effective_models : [];
  const hasConflict = conflictExists(allowedKeys, defaultModel);

  useEffect(() => {
    let active = true;
    setState('loading');
    getAgentModelPolicy(agent.id)
      .then((payload) => {
        if (!active) return;
        setPolicy(payload);
        const normalized = normalizeDefaultModel(payload.default_model, payload.effective_models, fallbackDefault);
        setDefaultModel(normalized.model);
        setWarning(normalized.changed ? 'Previous fallback model is no longer available. Choose and save a new fallback.' : '');
        setAllowedKeys(refsToKeys(payload.allowed_models));
        setState('ready');
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Unable to load model policy.');
        setState('error');
      });
    return () => {
      active = false;
    };
  }, [agent.id, fallbackDefault]);

  function resetPolicy() {
    const normalized = normalizeDefaultModel(policy?.default_model || null, policy?.effective_models || [], fallbackDefault);
    setDefaultModel(normalized.model);
    setAllowedKeys(refsToKeys(policy?.allowed_models || []));
    setError('');
    setWarning(normalized.changed ? 'Previous fallback model is no longer available. Choose and save a new fallback.' : '');
  }

  async function savePolicy() {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const saved = await updateAgentModelPolicy(agent.id, defaultModel, refsFromKeys(allowedKeys, modelOptions));
      setPolicy(saved);
      const normalized = normalizeDefaultModel(saved.default_model, saved.effective_models, defaultModel);
      setDefaultModel(normalized.model);
      setAllowedKeys(refsToKeys(saved.allowed_models));
      setWarning('');
      setSuccess('Provider and model settings updated.');
      await onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} size="lg" aria-labelledby="model-policy-title">
      <ModalHeader>
        <div>
          <p className="eyebrow">Model access</p>
          <ModalTitle id="model-policy-title">{agent.name || agent.id}</ModalTitle>
        </div>
      </ModalHeader>
      <ModalBody className="model-policy-modal-body">
        {state === 'loading' && <Notice>Loading model policy...</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
        {warning && <Notice>{warning}</Notice>}
        {success && <Notice tone="success">{success}</Notice>}
        {state === 'ready' && (
          <ModelAccessControls
            models={modelOptions}
            defaultModel={defaultModel}
            allowedKeys={allowedKeys}
            effectiveModels={policy?.effective_models}
            source={policy?.source}
            disabled={saving}
            onReset={resetPolicy}
            onDefaultModelChange={setDefaultModel}
            onAllowedKeysChange={setAllowedKeys}
          />
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" type="button" onClick={savePolicy} disabled={state !== 'ready' || saving || hasConflict}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
        <Button variant="secondary" type="button" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function AgentEditorPage({
  mode,
  agent,
  schema,
  models,
  onBack,
  onSubmitted,
  onModelPolicySaved,
  onReveal,
  onRotate,
  onDelete,
}: {
  mode: EditorMode;
  agent: AgentDetail | null;
  schema: Record<string, unknown>;
  models: ModelListItem[];
  onBack: () => void;
  onSubmitted: (agentId: string, key?: KeyResponse) => void;
  onModelPolicySaved?: () => Promise<void>;
  onReveal: (agent: AgentDetail) => void;
  onRotate: (agent: AgentDetail) => void;
  onDelete: (agent: AgentDetail) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [policyWarning, setPolicyWarning] = useState('');
  const [policySuccess, setPolicySuccess] = useState('');
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policy, setPolicy] = useState<AgentModelPolicyResponse | null>(null);
  const [createModels, setCreateModels] = useState<ModelListItem[]>([]);
  const modelOptions = mode === 'create' ? createModels : policy ? policy.effective_models : [];
  const createFallback = useMemo(() => firstModelRef(createModels), [createModels]);
  const editFallback = useMemo(() => legacyModelRef(agent, models), [agent, models]);
  const fallbackDefault = mode === 'create' ? createFallback : editFallback;
  const [defaultModel, setDefaultModel] = useState<ModelRef | null>(fallbackDefault);
  const [allowedKeys, setAllowedKeys] = useState<Set<string>>(new Set());
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const hasConflict = conflictExists(allowedKeys, defaultModel);

  const initialConfig = useMemo(() => (agent ? initialConfigFromAgent(agent) : undefined), [agent]);
  const title = mode === 'create' ? 'Create agent' : agent?.name || 'Edit agent';

  useEffect(() => {
    let active = true;
    setPolicy(null);
    setAllowedKeys(new Set());
    setDefaultModel(fallbackDefault);
    setPolicyWarning('');
    setPolicySuccess('');
    if (mode === 'create' || !agent) return undefined;

    setPolicyLoading(true);
    getAgentModelPolicy(agent.agent_id)
      .then((payload) => {
        if (!active) return;
        setPolicy(payload);
        const normalized = normalizeDefaultModel(payload.default_model, payload.effective_models, fallbackDefault);
        setDefaultModel(normalized.model);
        setPolicyWarning(normalized.changed ? 'Previous fallback model is no longer available. Choose and save a new fallback.' : '');
        setAllowedKeys(refsToKeys(payload.allowed_models));
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Unable to load model policy.');
      })
      .finally(() => {
        if (active) setPolicyLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agent, mode, fallbackDefault]);

  useEffect(() => {
    let active = true;
    if (mode !== 'create') {
      setCreateModels([]);
      return undefined;
    }

    setPolicyLoading(true);
    setError('');
    revealParentKey()
      .then((payload) => {
        const parentKey = payload.parent_key || payload.key;
        return parentKey ? listEffectiveModels(parentKey) : [];
      })
      .then((nextModels) => {
        if (!active) return;
        setCreateModels(nextModels);
        setDefaultModel(firstModelRef(nextModels));
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Unable to load effective models.');
      })
      .finally(() => {
        if (active) setPolicyLoading(false);
      });

    return () => {
      active = false;
    };
  }, [mode]);

  async function submit(yaml: string) {
    if (hasConflict) {
      setError('Default model is not in the allowed list. Fix the model policy before saving.');
      return;
    }
    if (policyLoading) {
      setError('Model policy is still loading. Wait for it to finish before saving.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const allowedModels = refsFromKeys(allowedKeys, modelOptions);
      if (mode === 'create') {
        const created = await createAgent(yaml);
        await updateAgentModelPolicy(created.agent_id, defaultModel, allowedModels);
        onSubmitted(created.agent_id, created);
      } else if (agent) {
        await updateAgent(agent.agent_id, yaml);
        await updateAgentModelPolicy(agent.agent_id, defaultModel, allowedModels);
        onSubmitted(agent.agent_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function saveModelPolicy() {
    if (!agent || hasConflict) return;
    setSavingPolicy(true);
    setError('');
    setPolicySuccess('');
    try {
      const saved = await updateAgentModelPolicy(agent.agent_id, defaultModel, refsFromKeys(allowedKeys, modelOptions));
      setPolicy(saved);
      const normalized = normalizeDefaultModel(saved.default_model, saved.effective_models, defaultModel);
      setDefaultModel(normalized.model);
      setAllowedKeys(refsToKeys(saved.allowed_models));
      setPolicyWarning('');
      setPolicySuccess('Provider and model settings updated.');
      await onModelPolicySaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save model policy.');
    } finally {
      setSavingPolicy(false);
    }
  }

  return (
    <Card className="editor-page" variant="outlined" padding="none">
      <CardHeader className="panel-head">
        <div>
          <p className="eyebrow">{mode === 'create' ? 'New agent' : 'Editing agent'}</p>
          <CardTitle as="h2">{title}</CardTitle>
          {agent && <p className="subtle">{agent.agent_id}</p>}
        </div>
        <div className="button-row">
          <Button variant="secondary" type="button" onClick={onBack} leftIcon={<ArrowLeft aria-hidden="true" size={16} />}>
            Back to agents
          </Button>
          {agent && (
            <>
              <Button
                variant="secondary"
                type="button"
                onClick={() => onReveal(agent)}
                leftIcon={<Eye aria-hidden="true" size={16} />}
              >
                Reveal key
              </Button>
              <Button
                variant="secondary"
                type="button"
                onClick={() => onRotate(agent)}
                leftIcon={<RotateCcw aria-hidden="true" size={16} />}
              >
                Rotate key
              </Button>
              <Button variant="danger" type="button" onClick={() => onDelete(agent)} leftIcon={<Trash2 aria-hidden="true" size={16} />}>
                Delete
              </Button>
            </>
          )}
        </div>
      </CardHeader>

      {(saving || error || policyWarning || policySuccess || policyLoading) && (
        <div className="editor-notices">
          {saving && <Notice>{mode === 'create' ? 'Creating agent...' : 'Saving agent...'}</Notice>}
          {error && <Notice tone="danger">{error}</Notice>}
          {policyWarning && <Notice>{policyWarning}</Notice>}
          {policySuccess && <Notice tone="success">{policySuccess}</Notice>}
          {policyLoading && <Notice>Loading model policy...</Notice>}
        </div>
      )}

      <div className="editor-body">
        <div className="editor-main">
          <div className="q-editor-frame">
            <AgentConfigGenerator
              key={agent?.agent_id || 'new-agent'}
              schema={schema}
              initialConfig={initialConfig}
              showEditor
              onSubmit={submit}
            />
          </div>
        </div>
        <aside className={`editor-sidebar${mobileSidebarOpen ? ' sidebar-open' : ''}`}>
          <button
            className="editor-sidebar-toggle"
            onClick={() => setMobileSidebarOpen(v => !v)}
            aria-expanded={mobileSidebarOpen}
          >
            <span>Model access</span>
            <span className="editor-sidebar-toggle-chevron">{mobileSidebarOpen ? '▲' : '▼'}</span>
          </button>
          <div className="editor-sidebar-content">
            <ModelAccessControls
              models={modelOptions}
              defaultModel={defaultModel}
              allowedKeys={allowedKeys}
              effectiveModels={policy?.effective_models}
              source={policy?.source}
              disabled={saving || savingPolicy}
              savingPolicy={savingPolicy}
              onReset={mode === 'edit' ? () => {
                const normalized = normalizeDefaultModel(policy?.default_model || null, policy?.effective_models || [], fallbackDefault);
                setDefaultModel(normalized.model);
                setAllowedKeys(refsToKeys(policy?.allowed_models || []));
                setError('');
                setPolicyWarning(normalized.changed ? 'Previous fallback model is no longer available. Choose and save a new fallback.' : '');
                setPolicySuccess('');
              } : undefined}
              onSave={mode === 'edit' && agent ? saveModelPolicy : undefined}
              onDefaultModelChange={setDefaultModel}
              onAllowedKeysChange={setAllowedKeys}
            />
          </div>
        </aside>
      </div>
    </Card>
  );
}


function formatNotificationTime(value?: number | string | null) {
  if (!value) return '';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notifications, setNotifications] = useState<ManagerNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState('');
  const controlRef = useRef<HTMLDivElement | null>(null);

  async function loadNotifications() {
    setLoading(true);
    setError('');
    try {
      const payload = await listNotifications();
      setNotifications(payload.data || []);
      setUnreadCount(payload.unread_count || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load notifications.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadNotifications();
  }, []);

  useEffect(() => {
    function refreshFromEvent() {
      void loadNotifications();
    }

    window.addEventListener('ozwell:notifications-refresh', refreshFromEvent);
    return () => window.removeEventListener('ozwell:notifications-refresh', refreshFromEvent);
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event: PointerEvent) {
      if (!controlRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    function closePanel() {
      setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('popstate', closePanel);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('popstate', closePanel);
    };
  }, [open]);

  async function readOne(notificationId: string) {
    await markNotificationRead(notificationId);
    await loadNotifications();
  }

  async function readAll() {
    await markAllNotificationsRead();
    await loadNotifications();
  }

  return (
    <div className="notification-control" ref={controlRef}>
      <div className="notification-bell-wrapper">
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => {
            const nextOpen = !open;
            setOpen(nextOpen);
            if (nextOpen) void loadNotifications();
          }}
          leftIcon={<Bell aria-hidden="true" size={15} />}
          aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}
        >
          Notifications
        </Button>
        {unreadCount > 0 && (
          <span className="notification-unread-dot" aria-hidden="true">{unreadCount}</span>
        )}
      </div>
      {open && (
        <div className="notification-panel" role="dialog" aria-label="Notifications">
          <div className="notification-panel-head">
            <strong>Notifications</strong>
            <Button variant="ghost" size="sm" type="button" onClick={readAll} disabled={!unreadCount || loading}>
              <Check size={13} aria-hidden="true" /> Mark all read
            </Button>
          </div>
          {loading && <p className="notification-empty">Loading...</p>}
          {error && <p className="notification-error">{error}</p>}
          {!loading && !error && notifications.length === 0 && <p className="notification-empty">No notifications.</p>}
          {!loading && !error && notifications.length > 0 && (
            <div className="notification-list">
              {notifications.slice(0, 8).map((notification) => (
                <div className={notification.read_at ? 'notification-item' : 'notification-item unread'} key={notification.id}>
                  {!notification.read_at && <span className="notification-unread-indicator" aria-hidden="true" />}
                  <div className="notification-item-body">
                    <strong>{notification.message || notification.type || 'Notification'}</strong>
                    <span>{formatNotificationTime(notification.created_at)}</span>
                  </div>
                  {!notification.read_at && (
                    <button
                      className="notification-dismiss"
                      type="button"
                      aria-label="Mark as read"
                      onClick={() => readOne(notification.id)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KeyDialog({
  mode,
  agent,
  onClose,
  onRotated,
}: {
  mode: KeyMode;
  agent: Pick<AgentDetail, 'agent_id' | 'name'>;
  onClose: () => void;
  onRotated: () => void;
}) {
  const [state, setState] = useState<LoadState>(mode === 'saved' ? 'ready' : 'loading');
  const [result, setResult] = useState<KeyResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef<Promise<KeyResponse> | null>(null);
  const handledOperation = useRef(false);

  useEffect(() => {
    let active = true;
    if (mode === 'saved') return undefined;
    const action = mode === 'rotate' ? rotateAgentKey : revealAgentKey;
    operation.current ??= action(agent.agent_id);
    operation.current
      .then((payload) => {
        if (!active || handledOperation.current) return;
        handledOperation.current = true;
        setResult(payload);
        setState('ready');
        if (mode === 'rotate') onRotated();
      })
      .catch((err) => {
        if (!active || handledOperation.current) return;
        handledOperation.current = true;
        setError(err instanceof Error ? err.message : 'Key operation failed.');
        setState('error');
      });
    return () => {
      active = false;
    };
  }, [agent.agent_id, mode, onRotated]);

  async function copy() {
    if (!result?.agent_key) return;
    await navigator.clipboard.writeText(result.agent_key);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} size="lg" aria-labelledby="key-dialog-title">
      <ModalHeader>
          <div>
            <p className="eyebrow">{mode === 'rotate' ? 'Rotated key' : mode === 'saved' ? 'Saved' : 'Agent key'}</p>
            <ModalTitle id="key-dialog-title">{agent.name || agent.agent_id}</ModalTitle>
          </div>
      </ModalHeader>

      <ModalBody>
        {mode === 'saved' && <Notice tone="success">Agent saved. The agent key is unchanged.</Notice>}
        {state === 'loading' && <Notice>Retrieving key...</Notice>}
        {state === 'error' && <Notice tone="danger">{error}</Notice>}
        {state === 'ready' && result && (
          <div>
            <div className="key-box">
              <code>{result.agent_key}</code>
            </div>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        {state === 'ready' && result && (
          <Button variant="primary" type="button" onClick={copy} leftIcon={<Copy aria-hidden="true" size={16} />}>
            {copied ? 'Copied' : 'Copy key'}
          </Button>
        )}
        <Button variant="secondary" type="button" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function ParentKeyRevealDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<LoadState>('loading');
  const [result, setResult] = useState<ParentKeyResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    revealParentKey()
      .then((payload) => {
        if (!active) return;
        setResult(payload);
        setState('ready');
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Unable to reveal the Ozwell key.');
        setState('error');
      });
    return () => {
      active = false;
    };
  }, []);

  const parentKey = result?.parent_key || result?.key || '';

  async function copy() {
    if (!parentKey) return;
    await navigator.clipboard.writeText(parentKey);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} size="lg" aria-labelledby="parent-key-dialog-title">
      <ModalHeader>
        <div>
          <p className="eyebrow">Ozwell key</p>
          <ModalTitle id="parent-key-dialog-title">Reveal / Copy Ozwell key</ModalTitle>
        </div>
      </ModalHeader>
      <ModalBody>
        {state === 'loading' && <Notice>Retrieving your Ozwell key...</Notice>}
        {state === 'error' && <Notice tone="danger">{error}</Notice>}
        {state === 'ready' && parentKey && (
          <div className="key-box">
            <code>{parentKey}</code>
          </div>
        )}
        {state === 'ready' && !parentKey && <Notice tone="danger">The API response did not include an Ozwell key.</Notice>}
      </ModalBody>
      <ModalFooter>
        {state === 'ready' && parentKey && (
          <Button variant="primary" type="button" onClick={copy} leftIcon={<Copy aria-hidden="true" size={16} />}>
            {copied ? 'Copied' : 'Copy key'}
          </Button>
        )}
        <Button variant="secondary" type="button" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function ClaimParentKeyDialog({ onClose, onClaimed }: { onClose: () => void; onClaimed: () => Promise<void> }) {
  const [parentKey, setParentKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedKey = parentKey.trim();
    if (!trimmedKey) {
      setError('Enter an existing Ozwell key to claim.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await claimParentKey(trimmedKey);
      await onClaimed();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'parent_key_already_claimed') {
        setError('That Ozwell key has already been claimed by another manager account.');
      } else {
        setError(err instanceof Error ? err.message : 'Unable to claim the Ozwell key.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} size="lg" aria-labelledby="claim-key-dialog-title">
      <form onSubmit={submit}>
        <ModalHeader>
          <div>
            <p className="eyebrow">Claim key</p>
            <ModalTitle id="claim-key-dialog-title">Claim existing Ozwell key</ModalTitle>
          </div>
        </ModalHeader>
        <ModalBody>
          <p className="dialog-copy">
            Enter an existing <code>ozw_</code> key. Agents created under the temporary auto-created key will move to the
            claimed key after this succeeds.
          </p>
          <label className="claim-key-field">
            <span>Existing Ozwell key</span>
            <input
              value={parentKey}
              onChange={(event) => setParentKey(event.target.value)}
              placeholder="ozw_..."
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {error && <Notice tone="danger">{error}</Notice>}
        </ModalBody>
        <ModalFooter>
          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting ? 'Claiming...' : 'Claim key'}
          </Button>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function App() {
  const { brand, brandOptions: availableBrands, setBrand } = useBrand();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentDetail | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [page, setPage] = useState<Page>(() => (window.location.pathname === '/admin' ? 'admin' : 'agents'));
  const [editorMode, setEditorMode] = useState<EditorMode>('create');
  const schema = useMemo(() => cloneSchema(), []);
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [error, setError] = useState('');
  const [keyDialog, setKeyDialog] = useState<{ mode: KeyMode; agent: Pick<AgentDetail, 'agent_id' | 'name'> } | null>(null);
  const [modelPolicyDialogAgent, setModelPolicyDialogAgent] = useState<Pick<AgentListItem, 'id' | 'name' | 'provider' | 'model' | 'default_model'> | null>(null);
  const [parentKeyDialog, setParentKeyDialog] = useState<ParentKeyDialogMode | null>(null);

  async function refreshAgents() {
    setAgentsLoading(true);
    try {
      setAgents(await listAgents());
    } finally {
      setAgentsLoading(false);
    }
  }

  async function refreshManagerState() {
    const identity = await getMe();
    setMe(identity);
    if (identity.provisioned) {
      await refreshAgents();
      void refreshModels();
    }
  }

  async function refreshModels() {
    try {
      setModels(await listModels());
    } catch {
      setModels([]);
    }
  }

  async function load() {
    setState('loading');
    setError('');
    try {
      const identity = await getMe();
      setMe(identity);
      if (identity.provisioned) {
        await refreshAgents();
        void refreshModels();
      }
      setState('ready');
    } catch (err) {
      const message =
        err instanceof ApiError && err.code === 'trusted_headers_disabled'
          ? 'Trusted manager auth is not enabled on the API. Use the local auth proxy on port 3100.'
          : err instanceof Error
            ? err.message
            : 'Unable to reach Ozwell.';
      setError(message);
      setState('error');
    }
  }

  async function openAgent(agentId: string) {
    setState('loading');
    setError('');
    try {
      const detail = await getAgent(agentId);
      setSelectedAgent(detail);
      setEditorMode('edit');
      setPage('editor');
      setState('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent.');
      setState('error');
    }
  }

  function newAgent() {
    setSelectedAgent(null);
    setEditorMode('create');
    setPage('editor');
  }

  function openAdmin() {
    window.history.pushState(null, '', '/admin');
    setSelectedAgent(null);
    setPage('admin');
  }

  function closeAdmin() {
    window.history.pushState(null, '', '/');
    setPage('agents');
    if (!me) {
      void load();
    }
  }

  async function removeAgent(agent: Pick<AgentDetail, 'agent_id' | 'name'>) {
    const confirmed = window.confirm(`Delete "${agent.name || agent.agent_id}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      await deleteAgent(agent.agent_id);
      await refreshAgents();
      setSelectedAgent(null);
      setPage('agents');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
      setState('error');
    }
  }

  function requestRotate(agent: Pick<AgentDetail, 'agent_id' | 'name'>) {
    const confirmed = window.confirm(
      `Rotate key for "${agent.name || agent.agent_id}"? The current key will stop working immediately.`,
    );
    if (!confirmed) return;
    setKeyDialog({ mode: 'rotate', agent });
  }

  async function onSubmitted(agentId: string, key?: KeyResponse) {
    await refreshAgents();
    const detail = await getAgent(agentId);
    setSelectedAgent(detail);
    setEditorMode('edit');
    setPage('editor');
    setKeyDialog({
      mode: key ? 'created' : 'saved',
      agent: { agent_id: agentId, name: detail.name || 'New agent' },
    });
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    function syncPageFromPath() {
      if (window.location.pathname === '/admin') setPage('admin');
      else setPage('agents');
    }
    window.addEventListener('popstate', syncPageFromPath);
    syncPageFromPath();
    return () => window.removeEventListener('popstate', syncPageFromPath);
  }, []);

  const displayName = getDisplayName(me || undefined);

  return (
    <main className="app-shell">
      <BrandInitializer brand={brand} />
      <header className="topbar">
        <div>
          <p className="eyebrow">Ozwell Manager</p>
          <h1>{page === 'editor' ? 'Agent editor' : page === 'admin' ? 'Admin Console' : 'Agent management'}</h1>
        </div>
        <div className="topbar-meta">
          <span>{displayName}</span>
          <div className="topbar-controls">
            {me?.provisioned && <NotificationBell />}
            {me?.is_admin && (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={page === 'admin' ? closeAdmin : openAdmin}
                leftIcon={<ShieldCheck aria-hidden="true" size={15} />}
              >
                {page === 'admin' ? 'Agents' : 'Admin Console'}
              </Button>
            )}
            <Select
              className="brand-select"
              hideLabel
              label="Brand"
              aria-label="Brand"
              size="sm"
              value={brand}
              options={availableBrands}
              onValueChange={(value) => setBrand(value as typeof brand)}
            />
            <ThemeToggle aria-label="Toggle color theme" size="sm" />
          </div>
        </div>
      </header>

      {state === 'loading' && (
        <EmptyState title="Connecting to Ozwell">Checking the current manager session.</EmptyState>
      )}

      {state === 'error' && (
        <Card className="state-card" variant="outlined" padding="lg">
          <Notice tone="danger">{error}</Notice>
          <div className="panel-actions state-actions">
            <Button variant="secondary" type="button" onClick={load}>
              Retry
            </Button>
          </div>
        </Card>
      )}

      {state === 'ready' && me && !me.provisioned && page !== 'admin' && (
        <Card className="state-card" variant="outlined" padding="lg">
          <EmptyState title="Account not provisioned yet">
            This Ozwell account is signed in, but agent management has not been enabled for it yet. Once provisioning is complete,
            this console will show your agents automatically.
          </EmptyState>
        </Card>
      )}

      {state === 'ready' && page === 'admin' && (me?.is_admin ? <AdminConsole /> : (
        <Card className="state-card" variant="outlined" padding="lg">
          <EmptyState title="Admin access required">This page is only available to Ozwell administrators.</EmptyState>
        </Card>
      ))}

      {state === 'ready' && me?.provisioned && page === 'agents' && (
        <AgentsPage
          me={me}
          agents={agents}
          loading={agentsLoading}
          onNew={newAgent}
          onOpen={openAgent}
          onRefresh={() => refreshAgents().catch((err) => setError(err instanceof Error ? err.message : 'Refresh failed.'))}
          onRevealParentKey={() => setParentKeyDialog('reveal')}
          onClaimParentKey={() => setParentKeyDialog('claim')}
          onModelAccess={(agent) => setModelPolicyDialogAgent({ id: agent.id, name: agent.name, provider: agent.provider, model: agent.model, default_model: agent.default_model })}
          onReveal={(agent) => setKeyDialog({ mode: 'reveal', agent: { agent_id: agent.id, name: agent.name } })}
          onRotate={(agent) => requestRotate({ agent_id: agent.id, name: agent.name })}
          onDelete={(agent) => removeAgent({ agent_id: agent.id, name: agent.name })}
        />
      )}

      {state === 'ready' && me?.provisioned && page === 'editor' && (
        <AgentEditorPage
          mode={editorMode}
          agent={selectedAgent}
          schema={schema}
          models={models}
          onBack={() => {
            setPage('agents');
            setSelectedAgent(null);
          }}
          onSubmitted={onSubmitted}
          onModelPolicySaved={refreshAgents}
          onReveal={(agent) => setKeyDialog({ mode: 'reveal', agent })}
          onRotate={requestRotate}
          onDelete={removeAgent}
        />
      )}

      {keyDialog && (
        <KeyDialog
          mode={keyDialog.mode}
          agent={keyDialog.agent}
          onClose={() => setKeyDialog(null)}
          onRotated={() => refreshAgents().catch((err) => setError(err instanceof Error ? err.message : 'Refresh failed.'))}
        />
      )}

      {modelPolicyDialogAgent && (
        <AgentModelPolicyDialog
          agent={modelPolicyDialogAgent}
          models={models}
          onClose={() => setModelPolicyDialogAgent(null)}
          onSaved={refreshAgents}
        />
      )}

      {parentKeyDialog === 'reveal' && <ParentKeyRevealDialog onClose={() => setParentKeyDialog(null)} />}

      {parentKeyDialog === 'claim' && (
        <ClaimParentKeyDialog
          onClose={() => setParentKeyDialog(null)}
          onClaimed={() => refreshManagerState().catch((err) => setError(err instanceof Error ? err.message : 'Refresh failed.'))}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="light">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
