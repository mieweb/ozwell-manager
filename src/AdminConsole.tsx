import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
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
  SpinnerWithLabel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@mieweb/ui';
import { ChevronRight, PanelRightClose, RefreshCw } from 'lucide-react';
import {
  AdminAgent,
  AdminParentKey,
  AdminSummary,
  AdminUser,
  AdminUserDetail,
  ApiError,
  ModelListItem,
  ModelRef,
  MonthlyQuota,
  MonthlyQuotaUpdate,
  UsageMetrics,
  demoteAdminUser,
  getAdminAgentQuota,
  getAdminSummary,
  getAdminUser,
  getAdminUserQuota,
  getModelRestrictions,
  listModels,
  listAdminUsers,
  promoteAdminUser,
  revokeAdminParentKey,
  updateAdminAgentQuota,
  updateModelRestrictions,
  updateAdminUserQuota,
} from './api';

type ConfirmAction = {
  title: string;
  body: string;
  actionLabel: string;
  tone: 'promote' | 'demote' | 'revoke';
  run: () => Promise<void>;
};

type AdminState = 'loading' | 'ready' | 'error' | 'access-denied';

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

function displayKeyHint(parentKey?: AdminParentKey | null) {
  const value = parentKey?.key_hint || parentKey?.id || '';
  return value.replace(/^ozw_(?:\.\.\.ozw_)+/, 'ozw_');
}

function displayName(user: AdminUser) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.email || user.external_user_id || user.id;
}

function formatNumber(value?: number | null) {
  if (value == null || Number.isNaN(value)) return '0';
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value);
}

function formatTokens(totalTokens?: number | null, requestCount?: number | null) {
  const tokens = totalTokens || 0;
  if (tokens === 0 && (requestCount || 0) > 0) return '0 known tokens';
  return `${formatNumber(tokens)} recorded tokens`;
}

function formatRequests(requestCount?: number | null) {
  return `${formatNumber(requestCount || 0)} requests`;
}

function formatDate(value?: number | string | null) {
  if (!value) return '-';
  const date = typeof value === 'number' ? new Date(value < 10_000_000_000 ? value * 1000 : value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function metricTokens(user: AdminUser) {
  return user.metrics?.total_tokens ?? user.total_tokens ?? 0;
}

function metricRequests(user: AdminUser) {
  return user.metrics?.request_count ?? user.request_count ?? 0;
}

function userKey(user: AdminUser) {
  return user.current_parent_key || null;
}

function activeParentKey(parentKeys?: AdminParentKey[]) {
  return parentKeys?.find((key) => key.status !== 'revoked') || null;
}

function SummaryMetrics({ summary }: { summary: AdminSummary | null }) {
  const metrics = [
    ['Users', summary?.users_total || 0],
    ['Admins', summary?.admins_total || 0],
    ['Agents', summary?.agents_total || 0],
    ['Recorded tokens', formatNumber(summary?.usage?.total_tokens || 0)],
  ];

  return (
    <div className="admin-metrics compact" aria-label="Admin summary metrics">
      {metrics.map(([label, value]) => (
        <div className="admin-metric" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function ConfirmModal({
  action,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  action: ConfirmAction;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isDanger = action.tone === 'demote' || action.tone === 'revoke';
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} size="md" aria-labelledby="admin-confirm-title">
      <ModalHeader>
        <div>
          <p className="eyebrow">Confirm admin action</p>
          <ModalTitle id="admin-confirm-title">{action.title}</ModalTitle>
        </div>
      </ModalHeader>
      <ModalBody>
        <p className="dialog-copy">{action.body}</p>
        {error && <p className="dialog-copy danger-copy">{error}</p>}
      </ModalBody>
      <ModalFooter>
        <Button variant={isDanger ? 'danger' : 'primary'} type="button" disabled={busy} onClick={onConfirm}>
          {busy ? 'Working...' : action.actionLabel}
        </Button>
        <Button variant="secondary" type="button" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function UserActions({
  user,
  currentKey,
  onConfirm,
}: {
  user: AdminUser;
  currentKey?: AdminParentKey | null;
  onConfirm: (action: ConfirmAction) => void;
}) {
  const name = displayName(user);
  const actionableKey = currentKey === undefined ? userKey(user) : currentKey;

  return (
    <div className="admin-row-actions" onClick={(event) => event.stopPropagation()}>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        aria-label={user.is_admin ? `Demote ${name}` : `Promote ${name}`}
        onClick={() =>
          onConfirm(
            user.is_admin
              ? {
                  tone: 'demote',
                  title: `Demote ${name}?`,
                  body: 'This removes Admin Console access. Their agents and keys remain unchanged.',
                  actionLabel: 'Demote user',
                  run: () => demoteAdminUser(user.id).then(() => undefined),
                }
              : {
                  tone: 'promote',
                  title: `Promote ${name}?`,
                  body: 'This grants access to admin data and admin actions.',
                  actionLabel: 'Promote user',
                  run: () => promoteAdminUser(user.id).then(() => undefined),
                },
          )
        }
      >
        {user.is_admin ? 'Demote' : 'Promote'}
      </Button>
      <Button
        variant="danger"
        size="sm"
        type="button"
        disabled={!actionableKey}
        aria-label={`Revoke current Ozwell key for ${name}`}
        onClick={() =>
          actionableKey &&
          onConfirm({
            tone: 'revoke',
            title: `Revoke ${actionableKey.key_hint || actionableKey.id}?`,
            body: `This disables all agents under ${name}'s current Ozwell key.`,
            actionLabel: 'Revoke key',
            run: () => revokeAdminParentKey(actionableKey.id).then(() => undefined),
          })
        }
      >
        Revoke
      </Button>
    </div>
  );
}

function UsersTable({
  users,
  selectedUserId,
  onSelect,
  onConfirm,
}: {
  users: AdminUser[];
  selectedUserId: string;
  onSelect: (user: AdminUser) => void;
  onConfirm: (action: ConfirmAction) => void;
}) {
  return (
    <Table responsive>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Total usage</TableHead>
          <TableHead>Ozwell key</TableHead>
          <TableHead>Admin actions</TableHead>
          <TableHead aria-label="Open user" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => {
          const currentKey = userKey(user);
          return (
            <TableRow
              key={user.id}
              selected={selectedUserId === user.id}
              className="admin-select-row"
              onClick={() => onSelect(user)}
            >
              <TableCell>
                <div className="admin-primary-cell">
                  <div className="admin-user-line">
                    <strong>{displayName(user)}</strong>
                    {user.is_admin && (
                      <Badge variant="success" size="sm">
                        Admin
                      </Badge>
                    )}
                  </div>
                  <span>{user.email || user.username || `External ID ${user.external_user_id || '-'}`}</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="admin-usage-cell">
                  <strong>{formatTokens(metricTokens(user), metricRequests(user))}</strong>
                  <span>{formatRequests(metricRequests(user))}</span>
                </div>
              </TableCell>
              <TableCell>
                {currentKey ? (
                  <div className="admin-key-inline">
                    <strong>{displayKeyHint(currentKey)}</strong>
                  </div>
                ) : (
                  <Badge variant="danger" size="sm">
                    No active key
                  </Badge>
                )}
              </TableCell>
              <TableCell>
                <UserActions user={user} onConfirm={onConfirm} />
              </TableCell>
              <TableCell>
                <ChevronRight aria-hidden="true" size={16} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function CurrentKey({ parentKey }: { parentKey: AdminParentKey | null }) {
  return (
    <div className="admin-inspector-section">
      <h4>Current Ozwell key</h4>
      {parentKey ? (
        <div className="admin-key-card">
          <div>
            <strong>{displayKeyHint(parentKey)}</strong>
            <span>{parentKey.source || 'active key'}</span>
          </div>
          <Badge variant={parentKey.status === 'revoked' ? 'danger' : 'success'} size="sm">
            {parentKey.status || 'active'}
          </Badge>
        </div>
      ) : (
        <p className="admin-muted">No active Ozwell key.</p>
      )}
    </div>
  );
}

function quotaWindow(quota: MonthlyQuota | null) {
  if (!quota) return '-';
  return `${formatDate(quota.window_start)} - ${formatDate(quota.window_end)}`;
}

function remainingQuota(quota: MonthlyQuota | null) {
  if (!quota) return '-';
  if (quota.remaining_tokens == null) return 'No limit';
  return `${formatNumber(quota.remaining_tokens)} tokens`;
}

function quotaIsBlocked(quota: MonthlyQuota | null) {
  return !!quota && quota.status === 'active' && (!quota.allowed || quota.remaining_tokens === 0);
}

function quotaStatusCopy(quota: MonthlyQuota | null, enabled: boolean) {
  if (quotaIsBlocked(quota)) return 'Monthly token quota exceeded.';
  return enabled ? 'Monthly quota active.' : 'Monthly quota disabled.';
}

function quotaStatusLabel(quota: MonthlyQuota | null, enabled: boolean) {
  if (quotaIsBlocked(quota)) return 'Exceeded';
  return enabled ? 'Active' : 'Disabled';
}

function QuotaEditor({
  scope,
  scopeId,
  title,
}: {
  scope: 'user' | 'agent';
  scopeId: string;
  title: string;
}) {
  const [quota, setQuota] = useState<MonthlyQuota | null>(null);
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [limitValue, setLimitValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const blocked = quotaIsBlocked(quota);
  const savedEnabled = quota?.status === 'active';
  const displayedEnabled = quota ? draftEnabled : savedEnabled;
  const normalizedLimit = quota?.monthly_token_limit == null ? '' : String(quota.monthly_token_limit);
  const isDirty = !!quota && (draftEnabled !== savedEnabled || (draftEnabled && limitValue.trim() !== normalizedLimit));

  async function loadQuota() {
    setLoading(true);
    setError('');
    setSaved('');
    try {
      const nextQuota = scope === 'user' ? await getAdminUserQuota(scopeId) : await getAdminAgentQuota(scopeId);
      setQuota(nextQuota);
      setDraftEnabled(nextQuota.status === 'active');
      setLimitValue(nextQuota.monthly_token_limit == null ? '' : String(nextQuota.monthly_token_limit));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to load ${scope} quota.`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setQuota(null);
    setDraftEnabled(false);
    setLimitValue('');
    void loadQuota();
  }, [scope, scopeId]);

  async function saveQuota(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSaved('');

    const trimmedLimit = limitValue.trim();
    const parsedLimit = Number(trimmedLimit);

    if (draftEnabled && (!trimmedLimit || !Number.isInteger(parsedLimit) || parsedLimit < 0)) {
      setError('Enter a whole-number monthly token limit.');
      setSaving(false);
      return;
    }

    const nextUpdate: MonthlyQuotaUpdate = draftEnabled
      ? { status: 'active', monthly_token_limit: parsedLimit }
      : { status: 'disabled', monthly_token_limit: null };

    try {
      const nextQuota =
        scope === 'user'
          ? await updateAdminUserQuota(scopeId, nextUpdate)
          : await updateAdminAgentQuota(scopeId, nextUpdate);
      setQuota(nextQuota);
      setDraftEnabled(nextQuota.status === 'active');
      setLimitValue(nextQuota.monthly_token_limit == null ? '' : String(nextQuota.monthly_token_limit));
      setSaved('Quota saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to save ${scope} quota.`);
    } finally {
      setSaving(false);
    }
  }

  async function toggleQuotaStatus() {
    if (!quota) return;
    setError('');
    setSaved('');
    setDraftEnabled((current) => !current);
  }

  return (
    <form className={`quota-editor${blocked ? ' quota-blocked' : displayedEnabled ? ' quota-active' : ''}`} onSubmit={saveQuota}>
      <div className="quota-editor-head">
        <div>
          <h4>{title}</h4>
          <p className="admin-muted">{quotaStatusCopy(quota, displayedEnabled)}</p>
        </div>
        <Badge variant={blocked ? 'danger' : displayedEnabled ? 'success' : 'outline'} size="sm">
          {quotaStatusLabel(quota, displayedEnabled)}
        </Badge>
      </div>

      {loading ? (
        <SpinnerWithLabel label={`Loading ${scope} quota`} />
      ) : (
        <>
          <div className="quota-stats" aria-label={`${title} usage`}>
            <div>
              <span>Used</span>
              <strong>{formatNumber(quota?.used_tokens || 0)}</strong>
            </div>
            <div>
              <span>Remaining</span>
              <strong>{remainingQuota(quota)}</strong>
            </div>
            <div>
              <span>Requested</span>
              <strong>{formatNumber(quota?.requested_tokens || 0)}</strong>
            </div>
          </div>

          <div className="quota-window">
            <span>Window</span>
            <strong>{quotaWindow(quota)}</strong>
          </div>

          {blocked && <p className="quota-exceeded-copy">Monthly token quota exceeded.</p>}

          <div className="quota-edit-row">
            <label className="quota-limit-field">
              <span>Monthly token limit</span>
              <input
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={draftEnabled ? limitValue : ''}
                disabled={!draftEnabled || saving}
                onChange={(event) => {
                  setLimitValue(event.target.value);
                  setSaved('');
                }}
                placeholder={draftEnabled ? '100000' : 'No active monthly limit'}
              />
            </label>
          </div>

          {error && <p className="dialog-copy danger-copy">{error}</p>}
          {saved && <p className="quota-saved-copy">{saved}</p>}

          <div className="quota-actions">
            <Button
              variant={draftEnabled ? 'danger' : 'primary'}
              size="sm"
              type="button"
              disabled={loading || saving || !quota}
              onClick={toggleQuotaStatus}
            >
              {draftEnabled ? 'Disable quota' : 'Enable quota'}
            </Button>
            <Button variant="secondary" size="sm" type="button" disabled={loading || saving} onClick={loadQuota}>
              Refresh
            </Button>
            {isDirty && (
              <Button variant="primary" size="sm" type="submit" disabled={loading || saving}>
                {saving ? 'Saving...' : 'Save quota'}
              </Button>
            )}
          </div>
        </>
      )}
    </form>
  );
}

function QuotasModal({
  user,
  agents,
  unattributedUsage,
  onClose,
}: {
  user: AdminUser;
  agents: AdminAgent[];
  unattributedUsage?: UsageMetrics;
  onClose: () => void;
}) {
  const name = displayName(user);
  const showUnattributedUsage = (unattributedUsage?.request_count || 0) > 0;

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} size="lg" aria-labelledby="admin-quotas-title">
      <ModalHeader>
        <div>
          <p className="eyebrow">Monthly token quotas</p>
          <ModalTitle id="admin-quotas-title">{name}'s quotas</ModalTitle>
        </div>
      </ModalHeader>
      <ModalBody>
        <div className="admin-quotas-modal">
          <section className="admin-quota-modal-section">
            <div className="admin-quota-modal-section-head">
              <div>
                <h4>User quota</h4>
                <p className="admin-muted">Applies to this user's monthly token usage across agents.</p>
              </div>
            </div>
            <QuotaEditor scope="user" scopeId={user.id} title="User monthly token quota" />
          </section>

          <section className="admin-quota-modal-section">
            <div className="admin-quota-modal-section-head">
              <div>
                <h4>Agent quotas</h4>
                <p className="admin-muted">Set optional monthly limits for individual agents.</p>
              </div>
              {agents.length > 0 && (
                <Badge variant="outline" size="sm">
                  {agents.length} agents
                </Badge>
              )}
            </div>

            {agents.length ? (
              <div className="admin-agents-modal-list">
                {agents.map((agent) => (
                  <section className="admin-agent-control-row" key={agent.id} aria-label={`${agent.name || agent.id} quota controls`}>
                    <div className="admin-agent-control-head">
                      <div>
                        <strong>{agent.name || agent.id}</strong>
                        <span>{agent.model || 'No model recorded'}</span>
                      </div>
                      <div className="admin-agent-control-usage">
                        <span>{formatTokens(agent.metrics?.total_tokens, agent.metrics?.request_count)}</span>
                        <span>{formatRequests(agent.metrics?.request_count)}</span>
                      </div>
                    </div>
                    <QuotaEditor scope="agent" scopeId={agent.id} title="Agent monthly token quota" />
                  </section>
                ))}
              </div>
            ) : (
              <p className="admin-muted">No active agents.</p>
            )}
            {showUnattributedUsage && (
              <div className="admin-unattributed-usage modal-note">
                <div>
                  <strong>Unattributed usage</strong>
                  <span>Not tied to a specific agent · {formatTokens(unattributedUsage?.total_tokens, unattributedUsage?.request_count)}</span>
                </div>
                <span>{formatRequests(unattributedUsage?.request_count)}</span>
              </div>
            )}
          </section>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" type="button" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function ModelRestrictionsEditor({
  parentKey,
  allModels,
}: {
  parentKey: AdminParentKey | null;
  allModels: ModelListItem[];
}) {
  const [filterQuery, setFilterQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [allowedKeys, setAllowedKeys] = useState<Set<string>>(new Set());
  const [unrestricted, setUnrestricted] = useState(true);
  const [effectiveModels, setEffectiveModels] = useState<ModelListItem[]>([]);

  const groupedModels = useMemo(() => groupModelsByProvider(allModels), [allModels]);
  const providerNames = useMemo(() => Object.keys(groupedModels).sort(), [groupedModels]);
  const restrictionsEnabled = !unrestricted;
  const selectedKeys = useMemo(() => {
    if (!unrestricted) return allowedKeys;
    return new Set(enabledModels(allModels).map(modelKey));
  }, [allowedKeys, allModels, unrestricted]);
  const filteredGrouped = useMemo(() => {
    if (!filterQuery.trim()) return groupedModels;
    const query = filterQuery.toLowerCase();
    const result: Record<string, ModelListItem[]> = {};
    for (const [provider, list] of Object.entries(groupedModels)) {
      const filtered = list.filter((model) => modelName(model).toLowerCase().includes(query) || provider.toLowerCase().includes(query));
      if (filtered.length) result[provider] = filtered;
    }
    return result;
  }, [filterQuery, groupedModels]);
  const filteredProviderNames = useMemo(() => Object.keys(filteredGrouped).sort(), [filteredGrouped]);

  async function loadRestrictions() {
    if (!parentKey) return;
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const restrictions = await getModelRestrictions(parentKey.id);
      setAllowedKeys(new Set((restrictions.allowed_models || []).map(selectionKey)));
      setUnrestricted((restrictions.allowed_models || []).length === 0);
      setEffectiveModels(restrictions.effective_models || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load model restrictions.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setAllowedKeys(new Set());
    setUnrestricted(true);
    setEffectiveModels([]);
    void loadRestrictions();
  }, [parentKey?.id]);

  function providerSelected(provider: string) {
    const models = groupedModels[provider] || [];
    return selectedKeys.has(providerWideKey(provider)) || (models.length > 0 && models.every((model) => selectedKeys.has(modelKey(model))));
  }

  function modelSelected(model: ModelListItem) {
    return selectedKeys.has(providerWideKey(modelProvider(model))) || selectedKeys.has(modelKey(model));
  }

  function setProvider(provider: string, enabled: boolean) {
    const next = new Set(selectedKeys);
    for (const model of groupedModels[provider] || []) {
      next.delete(modelKey(model));
    }
    if (enabled) next.add(providerWideKey(provider));
    else next.delete(providerWideKey(provider));
    setUnrestricted(false);
    setAllowedKeys(next);
  }

  function setModel(model: ModelListItem, enabled: boolean) {
    const provider = modelProvider(model);
    const providerModels = groupedModels[provider] || [];
    const next = new Set(selectedKeys);
    next.delete(providerWideKey(provider));
    for (const item of providerModels) {
      const key = modelKey(item);
      if (key === modelKey(model)) {
        if (enabled) next.add(key);
      } else if (modelSelected(item)) {
        next.add(key);
      }
    }
    setUnrestricted(false);
    setAllowedKeys(next);
  }

  function enableRestrictions() {
    if (!unrestricted) return;
    setUnrestricted(false);
    setAllowedKeys(new Set(enabledModels(allModels).map(modelKey)));
  }

  async function saveRestrictions(nextKeys = allowedKeys) {
    if (!parentKey) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const enabled = enabledModels(allModels);
      const providers = Array.from(new Set(enabled.map(modelProvider))).sort();
      const allowedModels = nextKeys.size
        ? providers.flatMap((provider) => {
            if (nextKeys.has(providerWideKey(provider))) return [{ provider }];
            return enabled
              .filter((model) => modelProvider(model) === provider && nextKeys.has(modelKey(model)))
              .map((model) => ({ provider, model: modelName(model) }));
          })
        : [];
      const saved = await updateModelRestrictions(parentKey.id, allowedModels);
      setAllowedKeys(new Set((saved.allowed_models || []).map(selectionKey)));
      setUnrestricted((saved.allowed_models || []).length === 0);
      setEffectiveModels(saved.effective_models || []);
      setSuccess(nextKeys.size ? 'Model restrictions updated.' : 'Model restrictions reset.');
      window.dispatchEvent(new Event('ozwell:notifications-refresh'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save model restrictions.');
    } finally {
      setSaving(false);
    }
  }

  async function resetRestrictions() {
    const empty = new Set<string>();
    setAllowedKeys(empty);
    setUnrestricted(true);
    await saveRestrictions(empty);
  }

  return (
    <div className="admin-inspector-section model-restrictions">
      <div className="model-restrictions-head">
        <div>
          <h4>Model restrictions</h4>
          <p className="admin-muted">
            {restrictionsEnabled ? 'Only selected models are available for this Ozwell key.' : 'All enabled models allowed.'}
          </p>
        </div>
        <div className="model-restrictions-actions">
          <Button variant="secondary" size="sm" type="button" disabled={!parentKey || loading || saving} onClick={() => saveRestrictions()}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
          <Button variant="secondary" size="sm" type="button" disabled={!parentKey || loading || saving} onClick={resetRestrictions}>
            Reset model restrictions
          </Button>
        </div>
      </div>

      {!parentKey && <p className="admin-muted">No active Ozwell key.</p>}
      {parentKey && loading && <SpinnerWithLabel label="Loading model restrictions" />}
      {error && <p className="dialog-copy danger-copy">{error}</p>}
      {success && <p className="dialog-copy success-copy">{success}</p>}

      {parentKey && providerNames.length > 0 && (
        <>
          <div className="agent-model-mode-toggle">
            <button
              type="button"
              className={`agent-model-mode-btn${unrestricted ? ' active' : ''}`}
              onClick={() => {
                setUnrestricted(true);
                setAllowedKeys(new Set());
              }}
              disabled={loading || saving}
            >
              Any model
            </button>
            <button
              type="button"
              className={`agent-model-mode-btn${!unrestricted ? ' active' : ''}`}
              onClick={enableRestrictions}
              disabled={loading || saving}
            >
              Specific models
              {!unrestricted && <span className="agent-model-mode-count">{allowedKeys.size}</span>}
            </button>
          </div>

          {!unrestricted && (
            <input
              className="agent-model-filter"
              type="search"
              placeholder="Filter models..."
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
              disabled={loading || saving}
            />
          )}

          <div className="model-restrictions-groups">
            {unrestricted ? (
              <p className="admin-muted">All enabled models are allowed for this Ozwell key.</p>
            ) : filteredProviderNames.length ? (
              filteredProviderNames.map((provider) => {
                const providerList = filteredGrouped[provider] || [];
                const selectedCount = selectedKeys.has(providerWideKey(provider))
                  ? providerList.length
                  : providerList.filter((model) => selectedKeys.has(modelKey(model))).length;
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
                          checked={providerSelected(provider)}
                          disabled={loading || saving}
                          onChange={(event) => setProvider(provider, event.target.checked)}
                        />
                        <span>All {providerLabel(provider)} models</span>
                      </label>
                      {providerList.map((model) => (
                        <label className="model-option model-option-indent" key={modelKey(model)}>
                          <input
                            type="checkbox"
                            checked={modelSelected(model)}
                            disabled={loading || saving}
                            onChange={(event) => setModel(model, event.target.checked)}
                          />
                          <span>{modelLabel(model)}</span>
                        </label>
                      ))}
                    </div>
                  </details>
                );
              })
            ) : (
              <p className="agent-model-filter-empty">No models match "{filterQuery}"</p>
            )}
          </div>

          <div className="effective-models">
            <span>Effective models</span>
            {effectiveModels.length ? (
              <div className="model-chip-list" aria-label={`${effectiveModels.length} effective models`}>
                <strong>{effectiveModels.length}</strong>
                {effectiveModels.slice(0, 8).map((model) => (
                  <span className="model-chip" key={modelKey(model)}>
                    {modelLabel(model)}
                  </span>
                ))}
                {effectiveModels.length > 8 && <span className="model-chip">+{effectiveModels.length - 8} more</span>}
              </div>
            ) : (
              <strong>None returned</strong>
            )}
          </div>
        </>
      )}
      {parentKey && !loading && providerNames.length === 0 && <p className="admin-muted">No discovered models returned.</p>}
    </div>
  );
}

function Inspector({
  detail,
  loading,
  allModels,
  onClose,
  onConfirm,
}: {
  detail: AdminUserDetail | null;
  loading: boolean;
  allModels: ModelListItem[];
  onClose: () => void;
  onConfirm: (action: ConfirmAction) => void;
}) {
  const [quotasOpen, setQuotasOpen] = useState(false);

  if (!detail) return null;
  const { user } = detail;
  const agents = detail.agents || [];
  const currentKey = user.current_parent_key || activeParentKey(detail.parent_keys);
  const unattributedUsage = detail.unattributed_usage;
  const showUnattributedUsage = (unattributedUsage?.request_count || 0) > 0;

  return (
    <aside className="admin-inspector" aria-label={`Admin actions for ${displayName(user)}`}>
      <div className="admin-inspector-head">
        <div>
          <p className="eyebrow">Selected user</p>
          <h3>{displayName(user)}</h3>
          <p>
            {user.email || user.username || 'No email'} · ID {user.external_user_id || user.id}
          </p>
        </div>
        <div className="admin-inspector-head-actions">
          <Badge variant={user.is_admin ? 'success' : 'outline'} size="sm">
            {user.is_admin ? 'Admin' : 'User'}
          </Badge>
          <Button variant="ghost" size="sm" type="button" aria-label="Close user inspector" onClick={onClose}>
            <PanelRightClose aria-hidden="true" size={16} />
          </Button>
        </div>
      </div>

      {loading ? (
        <SpinnerWithLabel label="Loading user details" />
      ) : (
        <>
          <section className="admin-inspector-section admin-usage-overview" aria-label="Usage overview">
            <div className="admin-section-title-row">
              <div>
                <h4>Usage</h4>
                <p className="admin-muted">
                  Monthly quotas cover this user and {agents.length ? `${agents.length} agent scopes.` : 'their future agents.'}
                </p>
              </div>
              <Button variant="secondary" size="sm" type="button" onClick={() => setQuotasOpen(true)}>
                Manage quotas
              </Button>
            </div>

            <div className="admin-status-strip">
              <div>
                <span>Recorded tokens</span>
                <strong>{formatNumber(metricTokens(user))}</strong>
              </div>
              <div>
                <span>Requests</span>
                <strong>{formatNumber(metricRequests(user))}</strong>
              </div>
              <div>
                <span>Unattributed</span>
                <strong>{formatNumber(unattributedUsage?.total_tokens || 0)}</strong>
              </div>
            </div>

            <details className="admin-disclosure">
              <summary>Usage breakdown</summary>
              {agents.length || showUnattributedUsage ? (
                <div className="admin-mini-list">
                  {agents.map((agent) => (
                    <div key={agent.id}>
                      <div>
                        <strong>{agent.name || agent.id}</strong>
                        <span>
                          {agent.model || 'No model'} · {formatTokens(agent.metrics?.total_tokens, agent.metrics?.request_count)}
                        </span>
                      </div>
                      <span>{formatRequests(agent.metrics?.request_count)}</span>
                  </div>
                  ))}
                  {showUnattributedUsage && (
                    <div className="admin-unattributed-usage">
                      <div>
                        <strong>Unattributed usage</strong>
                        <span>Not tied to a specific agent · {formatTokens(unattributedUsage?.total_tokens, unattributedUsage?.request_count)}</span>
                      </div>
                      <span>{formatRequests(unattributedUsage?.request_count)}</span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="admin-muted">No active agent usage.</p>
              )}
            </details>
          </section>

          <CurrentKey parentKey={currentKey} />

          <section className="admin-inspector-section admin-controls-section">
            <h4>Admin controls</h4>
            <UserActions user={user} currentKey={currentKey} onConfirm={onConfirm} />
          </section>

          <ModelRestrictionsEditor parentKey={currentKey} allModels={allModels} />

          {quotasOpen && (
            <QuotasModal user={user} agents={agents} unattributedUsage={unattributedUsage} onClose={() => setQuotasOpen(false)} />
          )}
        </>
      )}
    </aside>
  );
}

export function AdminConsole() {
  const [state, setState] = useState<AdminState>('loading');
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedDetail, setSelectedDetail] = useState<AdminUserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState('');

  async function loadAdmin() {
    setState('loading');
    setError('');
    try {
      const [nextSummary, nextUsers, nextModels] = await Promise.all([getAdminSummary(), listAdminUsers(), listModels()]);
      setSummary(nextSummary);
      setUsers(nextUsers);
      setModels(nextModels);
      setState('ready');
      return nextUsers;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setState('access-denied');
        return [];
      }
      setError(err instanceof Error ? err.message : 'Unable to load Admin Console.');
      setState('error');
      return [];
    }
  }

  async function selectUser(user: AdminUser) {
    if (selectedUserId === user.id) {
      setSelectedUserId('');
      setSelectedDetail(null);
      return;
    }

    setSelectedUserId(user.id);
    setSelectedDetail({ user, agents: [], parent_keys: [] });
    setDetailLoading(true);
    try {
      setSelectedDetail(await getAdminUser(user.id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setState('access-denied');
      } else {
        setError(err instanceof Error ? err.message : 'Unable to load user details.');
      }
    } finally {
      setDetailLoading(false);
    }
  }

  async function runConfirmedAction() {
    if (!confirmAction) return;
    setConfirmBusy(true);
    setConfirmError('');
    try {
      await confirmAction.run();
      setConfirmAction(null);
      const nextUsers = await loadAdmin();
      if (selectedUserId) {
        const selected = nextUsers.find((user) => user.id === selectedUserId);
        if (selected) {
          setSelectedUserId(selected.id);
          setSelectedDetail(await getAdminUser(selected.id));
        } else {
          setSelectedUserId('');
          setSelectedDetail(null);
        }
      }
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : 'Admin action failed.');
    } finally {
      setConfirmBusy(false);
    }
  }

  useEffect(() => {
    void loadAdmin();
  }, []);

  const selectedUser = useMemo(() => users.find((user) => user.id === selectedUserId), [selectedUserId, users]);

  useEffect(() => {
    if (!selectedUser && selectedUserId) {
      setSelectedUserId('');
      setSelectedDetail(null);
    }
  }, [selectedUser, selectedUserId]);

  if (state === 'loading') {
    return (
      <Card className="state-card" variant="outlined" padding="lg">
        <SpinnerWithLabel label="Loading Admin Console" />
      </Card>
    );
  }

  if (state === 'access-denied') {
    return (
      <Card className="state-card" variant="outlined" padding="lg">
        <h2>Admin access required</h2>
        <p className="admin-muted">This page is only available to Ozwell administrators.</p>
      </Card>
    );
  }

  if (state === 'error') {
    return (
      <Card className="state-card" variant="outlined" padding="lg">
        <p className="dialog-copy danger-copy">{error}</p>
        <div className="panel-actions state-actions">
          <Button variant="secondary" type="button" leftIcon={<RefreshCw aria-hidden="true" size={16} />} onClick={loadAdmin}>
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="admin-page" variant="outlined" padding="none">
      <CardHeader className="panel-head">
        <div>
          <p className="eyebrow">Admin Console</p>
          <CardTitle as="h2">Users and usage</CardTitle>
          <CardDescription>Select a user to see their top agent, usage evidence, and admin actions.</CardDescription>
        </div>
        <div className="button-row">
          <Button variant="secondary" type="button" leftIcon={<RefreshCw aria-hidden="true" size={16} />} onClick={loadAdmin}>
            Refresh
          </Button>
        </div>
      </CardHeader>

      <CardContent className="admin-content">
        <SummaryMetrics summary={summary} />

        <div className={selectedDetail ? 'admin-workspace' : 'admin-workspace table-only'}>
          <section className="admin-section">
            <div className="admin-section-head">
              <div>
                <p className="eyebrow">Primary admin table</p>
                <h3>Manager users</h3>
              </div>
            </div>
            <UsersTable users={users} selectedUserId={selectedUserId} onSelect={selectUser} onConfirm={setConfirmAction} />
          </section>

          <Inspector
            detail={selectedDetail}
            loading={detailLoading}
            allModels={models}
            onClose={() => {
              setSelectedUserId('');
              setSelectedDetail(null);
            }}
            onConfirm={setConfirmAction}
          />
        </div>
      </CardContent>

      {confirmAction && (
        <ConfirmModal
          action={confirmAction}
          busy={confirmBusy}
          error={confirmError}
          onClose={() => {
            setConfirmAction(null);
            setConfirmError('');
          }}
          onConfirm={runConfirmedAction}
        />
      )}
    </Card>
  );
}
