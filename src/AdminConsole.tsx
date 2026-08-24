import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  Radio,
  RadioGroup,
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
  ServerDefaultModelResponse,
  MonthlyQuota,
  MonthlyQuotaUpdate,
  UsageMetrics,
  demoteAdminUser,
  getAdminAgentQuota,
  getAdminSummary,
  getAdminUser,
  getAdminUserQuota,
  getModelRestrictions,
  getServerDefaultModel,
  getServerModelRestrictions,
  listModels,
  listAdminUsers,
  promoteAdminUser,
  revokeAdminParentKey,
  transferAdminAgent,
  updateAdminAgentQuota,
  updateModelRestrictions,
  updateServerDefaultModel,
  updateServerModelRestrictions,
  updateAdminUserQuota,
} from './api';
import {
  enabledModels,
  groupModelsByProvider,
  modelKey,
  modelName,
  modelProvider,
  providerLabel,
  providerWideKey,
  selectionKey,
} from './models';

type ConfirmAction = {
  title: string;
  body: string;
  actionLabel: string;
  tone: 'promote' | 'demote' | 'revoke';
  run: () => Promise<void>;
};

type AdminState = 'loading' | 'ready' | 'error' | 'access-denied';

function modelLabel(model: ModelListItem | ModelRef) {
  if ('label' in model && model.label) return model.label;
  const provider = modelProvider(model);
  const name = modelName(model);
  return provider && provider !== 'unknown' ? `${provider} / ${name}` : name;
}

function displayKeyHint(parentKey?: AdminParentKey | null) {
  const value = parentKey?.key_hint || parentKey?.id || '';
  return value.replace(/^ozw_(?:\.\.\.ozw_)+/, 'ozw_');
}

function displayName(user: AdminUser) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.email || user.external_user_id || user.id;
}

function userSearchText(user: AdminUser) {
  return [displayName(user), user.email, user.username, user.external_user_id, user.id].filter(Boolean).join(' ').toLowerCase();
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

function AgentControlsModal({
  user,
  users,
  agents,
  unattributedUsage,
  onClose,
  onTransferred,
}: {
  user: AdminUser;
  users: AdminUser[];
  agents: AdminAgent[];
  unattributedUsage?: UsageMetrics;
  onClose: () => void;
  onTransferred: () => Promise<void>;
}) {
  const name = displayName(user);
  const showUnattributedUsage = (unattributedUsage?.request_count || 0) > 0;
  const [transferAgent, setTransferAgent] = useState<AdminAgent | null>(null);
  const [destinationQuery, setDestinationQuery] = useState('');
  const [destinationUserId, setDestinationUserId] = useState('');
  const [reason, setReason] = useState('');
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState('');
  const [transferSuccess, setTransferSuccess] = useState('');
  const normalizedQuery = destinationQuery.trim().toLowerCase();
  const destinationOptions = users
    .filter((candidate) => candidate.id !== user.id)
    .filter((candidate) => !normalizedQuery || userSearchText(candidate).includes(normalizedQuery))
    .slice(0, 8);
  const destinationUser = users.find((candidate) => candidate.id === destinationUserId) || null;

  function beginTransfer(agent: AdminAgent) {
    setTransferAgent(agent);
    setDestinationQuery('');
    setDestinationUserId('');
    setReason('');
    setTransferError('');
    setTransferSuccess('');
  }

  async function submitTransfer() {
    if (!transferAgent || !destinationUser) {
      setTransferError('Select a destination user.');
      return;
    }
    setTransferring(true);
    setTransferError('');
    setTransferSuccess('');
    try {
      await transferAdminAgent(transferAgent.id, destinationUser.id, reason);
      await onTransferred();
      setTransferSuccess(`${transferAgent.name || transferAgent.id} transferred to ${displayName(destinationUser)}.`);
      setTransferAgent(null);
      setDestinationUserId('');
      setReason('');
    } catch (err) {
      setTransferError(
        err instanceof ApiError && err.status === 403
          ? 'Admin access is required to transfer agents. Refresh and try again.'
          : err instanceof Error
            ? err.message
            : 'Agent transfer failed.',
      );
    } finally {
      setTransferring(false);
    }
  }

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} size="lg" aria-labelledby="admin-agents-title">
      <ModalHeader>
        <div>
          <p className="eyebrow">Agent controls</p>
          <ModalTitle id="admin-agents-title">{name}'s agents</ModalTitle>
        </div>
      </ModalHeader>
      <ModalBody>
        <div className="admin-quotas-modal">
          {transferSuccess && <p className="quota-saved-copy">{transferSuccess}</p>}
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
                      <div className="admin-agent-control-actions">
                        <div className="admin-agent-control-usage">
                          <span>{formatTokens(agent.metrics?.total_tokens, agent.metrics?.request_count)}</span>
                          <span>{formatRequests(agent.metrics?.request_count)}</span>
                        </div>
                        <Button variant="secondary" size="sm" type="button" disabled={transferring} onClick={() => beginTransfer(agent)}>
                          Transfer
                        </Button>
                      </div>
                    </div>
                    {transferAgent?.id === agent.id && (
                      <section className="admin-transfer-panel" aria-label={`Transfer ${transferAgent.name || transferAgent.id}`}>
                        <div className="admin-quota-modal-section-head">
                          <div>
                            <h4>Transfer ownership</h4>
                            <p className="admin-muted">Move manager access to another user. The existing agent key keeps working.</p>
                          </div>
                          <Button variant="ghost" size="sm" type="button" disabled={transferring} onClick={() => setTransferAgent(null)}>
                            Cancel
                          </Button>
                        </div>

                        <div className="admin-transfer-summary">
                          <div>
                            <span>Agent</span>
                            <strong>{transferAgent.name || transferAgent.id}</strong>
                          </div>
                          <div>
                            <span>Current owner</span>
                            <strong>{name}</strong>
                          </div>
                          <div>
                            <span>Destination owner</span>
                            <strong>{destinationUser ? displayName(destinationUser) : 'Select a user'}</strong>
                          </div>
                        </div>

                        <label className="admin-transfer-field">
                          <span>Search destination users</span>
                          <input
                            type="search"
                            value={destinationQuery}
                            onChange={(event) => setDestinationQuery(event.target.value)}
                            placeholder="Search by name, email, username, or id"
                            disabled={transferring}
                          />
                        </label>

                        {destinationOptions.length ? (
                          <div className="admin-destination-list" role="listbox" aria-label="Destination users">
                            {destinationOptions.map((candidate) => {
                              const selected = candidate.id === destinationUserId;
                              const hasKey = !!candidate.current_parent_key || (candidate.active_parent_key_count || 0) > 0;
                              return (
                                <button
                                  className={`admin-destination-option${selected ? ' selected' : ''}`}
                                  key={candidate.id}
                                  type="button"
                                  onClick={() => {
                                    setDestinationUserId(candidate.id);
                                    setTransferError('');
                                  }}
                                  disabled={transferring}
                                  role="option"
                                  aria-selected={selected}
                                >
                                  <span>
                                    <strong>{displayName(candidate)}</strong>
                                    <small>{candidate.email || candidate.username || candidate.id}</small>
                                  </span>
                                  <Badge variant={hasKey ? 'outline' : 'danger'} size="sm">
                                    {hasKey ? 'Key ready' : 'No active key'}
                                  </Badge>
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="admin-muted">No users match that search.</p>
                        )}

                        <label className="admin-transfer-field">
                          <span>Reason</span>
                          <textarea
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                            placeholder="Optional admin note for audit history"
                            disabled={transferring}
                            rows={3}
                          />
                        </label>

                        <p className="admin-transfer-warning">
                          {name} will lose manager access to this agent. {destinationUser ? displayName(destinationUser) : 'The destination owner'} will
                          gain access. Existing agent key credentials remain unchanged and keep working.
                        </p>

                        {transferError && <p className="dialog-copy danger-copy">{transferError}</p>}

                        <div className="quota-actions">
                          <Button variant="danger" type="button" disabled={transferring || !destinationUser} onClick={submitTransfer}>
                            {transferring ? 'Transferring...' : 'Transfer ownership'}
                          </Button>
                        </div>
                      </section>
                    )}
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

// One picker, two scopes. 'key' restricts a single user's Ozwell key; 'server' restricts the whole
// server and sits outside the selected-user panel. Keeping a single component means the two controls
// can never drift apart visually or behaviourally.
type RestrictionScope = 'key' | 'server';

function restrictionSummary(scope: RestrictionScope, restricted: boolean, approvedCount: number, totalCount: number) {
  if (scope !== 'server') {
    // Names the level above, so it is obvious this narrows the approved list rather than replacing it.
    return restricted
      ? `This user can use ${approvedCount} of the ${totalCount} approved models.`
      : `This user can use all ${totalCount} approved models.`;
  }
  if (!restricted) return `Everyone here can use all ${totalCount} models.`;
  return `Everyone here can use ${approvedCount} of ${totalCount} models.`;
}

function saveSuccessMessage(scope: RestrictionScope, selectedCount: number) {
  if (scope !== 'server') {
    return selectedCount ? 'Model restrictions updated.' : 'Model restrictions reset.';
  }
  return selectedCount
    ? 'Approved models updated. Everyone sees the change straight away.'
    : 'Every model is approved again. Everyone sees the change straight away.';
}

// The model used when a request names none. Saves on its own, separately from the allow-list below
// it: the two are different writes, and one failing must not roll back or block the other.
// Deliberately mirrors the per-agent fallback controls in main.tsx — same wording, same markup, same
// classes — since it is the same choice made at a different scope.
// onSaved reports the new value rather than asking the console to reload. Reloading would refetch
// the model registry — seconds of discovery — and unmount this dialog mid-edit.
function ServerDefaultModelEditor({ onSaved }: { onSaved?: (saved: ModelRef | null) => void }) {
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [stored, setStored] = useState<ModelRef | null>(null);
  const [environment, setEnvironment] = useState<{ provider: string; model: string } | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const grouped = useMemo(() => groupModelsByProvider(models), [models]);
  const providerNames = useMemo(() => Object.keys(grouped).sort(), [grouped]);
  const providerModels = useMemo(() => grouped[provider] || [], [grouped, provider]);

  // With nothing stored the controls show the environment's fallback rather than sitting empty —
  // the server is always using something, and an empty pair claims otherwise. Saving then pins that
  // value, which is a reasonable thing to want.
  function applyResponse(response: ServerDefaultModelResponse) {
    const shown = response.default_model || response.environment_model;
    setStored(response.default_model);
    setEnvironment(response.environment_model ?? null);
    setModels(response.effective_models || []);
    setProvider(shown?.provider || '');
    setModel(shown?.model || '');
  }

  useEffect(() => {
    let cancelled = false;
    getServerDefaultModel()
      .then((response) => {
        if (!cancelled) applyResponse(response);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load the default model.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Switching provider carries the model with it only when that provider also has it; otherwise the
  // first model of the new provider, so the pair is never a combination the server would reject.
  function changeProvider(nextProvider: string) {
    const list = grouped[nextProvider] || [];
    const keptModel = list.find((item) => modelName(item) === model);
    setProvider(nextProvider);
    setModel(modelName(keptModel || list[0] || { provider: nextProvider, model: '' }));
  }

  async function save(nextDefault: ModelRef | null) {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const response = await updateServerDefaultModel(nextDefault);
      applyResponse(response);
      setSuccess(
        response.default_model
          ? `Requests that name no model now use ${providerLabel(response.default_model.provider)} ${response.default_model.model}.`
          : response.environment_model
            ? `Back to the server environment, which uses ${response.environment_model.model}.`
            : 'Default model cleared. The server falls back to its environment setting.',
      );
      onSaved?.(response.default_model);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save the default model.');
    } finally {
      setSaving(false);
    }
  }

  const dirty = (stored?.provider || '') !== provider || (stored?.model || '') !== model;
  const busy = loading || saving;
  // The selection can be a model the allow-list does not permit — the environment's model is shown
  // even when it is not approved, so the control reports what the server really uses. Saving that
  // would come straight back as default_model_not_allowed, so it is caught here instead.
  const modelApproved = Boolean(model) && providerModels.some((item) => modelName(item) === model);

  return (
    <div className="server-default-model">
      <div className="server-default-model-head">
        <h4>Default model</h4>
        <p className="admin-muted">
          {stored
            ? `Requests that name no model use ${providerLabel(stored.provider)} ${stored.model}, set here.`
            : environment
              ? `Requests that name no model use ${providerLabel(environment.provider)} ${environment.model}, from the server environment. Saving here overrides it.`
              : 'Requests that name no model use the model set in the server environment.'}
        </p>
      </div>

      {loading && <SpinnerWithLabel label="Loading the default model" />}
      {error && <p className="dialog-copy danger-copy">{error}</p>}
      {success && <p className="dialog-copy success-copy">{success}</p>}

      {!loading && providerNames.length === 0 ? (
        <p className="admin-muted">No approved models to choose from. Approve at least one below first.</p>
      ) : (
        !loading && (
          <>
            <div className="agent-model-defaults">
              <label>
                <span>Fallback provider</span>
                <select value={provider} onChange={(event) => changeProvider(event.target.value)} disabled={busy}>
                  <option value="">None</option>
                  {providerNames.map((name) => (
                    <option key={name} value={name}>{providerLabel(name)}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Fallback model</span>
                <select
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={busy || !providerModels.length}
                >
                  <option value="">None</option>
                  {/* The environment's model may not be in the approved list — an allow-list that
                      excludes it, or a name discovery has never returned. Shown anyway, so the
                      control still reports what the server is really using. */}
                  {model && !modelApproved && (
                    <option value={model}>{model} (not in the approved list)</option>
                  )}
                  {providerModels.map((item) => (
                    <option key={modelKey(item)} value={modelName(item)}>{modelName(item)}</option>
                  ))}
                </select>
              </label>
              <p className="agent-model-restriction-hint">
                Used when a request does not specify a model. Only approved models are listed, and the change applies
                to the next request — no restart.
              </p>
            </div>

            {model && !modelApproved && (
              <p className="agent-model-conflict-warning">
                {model} is not approved below, so it cannot be the default. Approve it first, or pick another model.
              </p>
            )}

            <div className="model-restrictions-actions">
              <Button
                variant="primary"
                size="sm"
                type="button"
                disabled={busy || !dirty || !provider || !modelApproved}
                onClick={() => save({ provider, model })}
              >
                {saving ? 'Saving...' : 'Save default'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={busy || !stored}
                onClick={() => save(null)}
              >
                Use environment default
              </Button>
            </div>
          </>
        )
      )}
    </div>
  );
}

function ModelRestrictionsEditor({
  parentKey,
  allModels,
  scope = 'key',
  onSaved,
  onCancel,
}: {
  parentKey: AdminParentKey | null;
  allModels: ModelListItem[];
  scope?: RestrictionScope;
  onSaved?: () => void;
  /** Given when the editor is in a dialog: the second button becomes Cancel and closes it. */
  onCancel?: () => void;
}) {
  const isServer = scope === 'server';
  const [filterQuery, setFilterQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [allowedKeys, setAllowedKeys] = useState<Set<string>>(new Set());
  const [unrestricted, setUnrestricted] = useState(true);
  const [effectiveModels, setEffectiveModels] = useState<ModelListItem[]>([]);
  const [discoveredModels, setDiscoveredModels] = useState<ModelListItem[]>([]);

  // The server policy narrows listModels(), so the server picker must offer the unfiltered
  // discovered list or an excluded model could never be re-enabled.
  const sourceModels = isServer ? discoveredModels : allModels;
  const ready = isServer || Boolean(parentKey);

  const groupedModels = useMemo(() => groupModelsByProvider(sourceModels), [sourceModels]);
  const providerNames = useMemo(() => Object.keys(groupedModels).sort(), [groupedModels]);
  const restrictionsEnabled = !unrestricted;
  const selectedKeys = useMemo(() => {
    if (!unrestricted) return allowedKeys;
    return new Set(enabledModels(sourceModels).map(modelKey));
  }, [allowedKeys, sourceModels, unrestricted]);
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

  function applyRestrictions(allowed?: ModelRef[], effective?: ModelListItem[]) {
    setAllowedKeys(new Set((allowed || []).map(selectionKey)));
    setUnrestricted((allowed || []).length === 0);
    setEffectiveModels(effective || []);
  }

  async function loadRestrictions() {
    if (!ready) return;
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      if (isServer) {
        const restrictions = await getServerModelRestrictions();
        applyRestrictions(restrictions.allowed_models, restrictions.effective_models);
        setDiscoveredModels(restrictions.discovered_models || []);
      } else if (parentKey) {
        const restrictions = await getModelRestrictions(parentKey.id);
        applyRestrictions(restrictions.allowed_models, restrictions.effective_models);
      }
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
  }, [scope, parentKey?.id]);

  function providerSelected(provider: string) {
    const models = groupedModels[provider] || [];
    return selectedKeys.has(providerWideKey(provider)) || (models.length > 0 && models.every((model) => selectedKeys.has(modelKey(model))));
  }

  function modelSelected(model: ModelListItem) {
    return selectedKeys.has(providerWideKey(modelProvider(model))) || selectedKeys.has(modelKey(model));
  }

  // For the server scope this must reflect the current ticks, not the last save, because the label
  // promises what happens after saving. The per-key scope keeps showing what the API returned.
  const previewModels = isServer ? sourceModels.filter(modelSelected) : effectiveModels;

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
        // next is seeded from selectedKeys, so unchecking has to delete — skipping the add leaves
        // the model selected and the checkbox never turns off.
        if (enabled) next.add(key);
        else next.delete(key);
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
    setAllowedKeys(new Set(enabledModels(sourceModels).map(modelKey)));
  }

  async function saveRestrictions(nextKeys = allowedKeys) {
    if (!ready) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const enabled = enabledModels(sourceModels);
      const providers = Array.from(new Set(enabled.map(modelProvider))).sort();
      const allowedModels = nextKeys.size
        ? providers.flatMap((provider) => {
            if (nextKeys.has(providerWideKey(provider))) return [{ provider }];
            return enabled
              .filter((model) => modelProvider(model) === provider && nextKeys.has(modelKey(model)))
              .map((model) => ({ provider, model: modelName(model) }));
          })
        : [];
      if (isServer) {
        const saved = await updateServerModelRestrictions(allowedModels);
        applyRestrictions(saved.allowed_models, saved.effective_models);
        setDiscoveredModels(saved.discovered_models || discoveredModels);
      } else if (parentKey) {
        const saved = await updateModelRestrictions(parentKey.id, allowedModels);
        applyRestrictions(saved.allowed_models, saved.effective_models);
      }
      setSuccess(saveSuccessMessage(scope, nextKeys.size));
      window.dispatchEvent(new Event('ozwell:notifications-refresh'));
      // A server change narrows every other model list in the console, so refresh them.
      onSaved?.();
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
          {/* The server scope lives in a dialog that already carries the title. */}
          {!isServer && <h4>Models this user can pick</h4>}
          <p className="admin-muted">
            {restrictionSummary(scope, restrictionsEnabled, previewModels.length, sourceModels.length)}
          </p>
        </div>
      </div>

      {!ready && <p className="admin-muted">No active Ozwell key.</p>}
      {ready && loading && <SpinnerWithLabel label={isServer ? 'Loading server model access' : 'Loading model restrictions'} />}
      {error && <p className="dialog-copy danger-copy">{error}</p>}
      {success && <p className="dialog-copy success-copy">{success}</p>}

      {ready && providerNames.length > 0 && (
        <>
          {/* Two states of one policy, so radios rather than a segmented control, which reads as a
              switch between views. */}
          <RadioGroup
            name={`model-access-${scope}`}
            value={unrestricted ? 'any' : 'selected'}
            onValueChange={(value) => {
              if (value === 'any') {
                setUnrestricted(true);
                setAllowedKeys(new Set());
              } else {
                enableRestrictions();
              }
            }}
            disabled={loading || saving}
          >
            <Radio
              value="any"
              label={isServer ? 'Approve every model' : 'Allow every approved model'}
              description={
                isServer ? 'Including any model added later.' : 'Including any model approved later.'
              }
            />
            <Radio
              value="selected"
              label={isServer ? 'Approve only selected models' : 'Allow only selected models'}
              description={
                isServer
                  ? 'Everything else disappears from model pickers for everyone.'
                  : 'Everything else disappears from this user’s model pickers.'
              }
            />
          </RadioGroup>

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
              // The summary line above already says this for the server scope; repeating it here
              // just gave the dialog two sentences saying the same thing.
              isServer ? null : (
                <p className="admin-muted">
                  This user can pick from every approved model. Narrowing here only affects this user.
                </p>
              )
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
                      {/* Indeterminate when only part of a provider is selected, so a half-picked
                          group no longer looks identical to an untouched one. */}
                      <Checkbox
                        className="model-option model-provider-toggle-row"
                        label={`All ${providerLabel(provider)} models`}
                        checked={providerSelected(provider)}
                        indeterminate={selectedCount > 0 && selectedCount < providerList.length}
                        disabled={loading || saving}
                        onChange={(event) => setProvider(provider, event.target.checked)}
                      />
                      {providerList.map((model) => (
                        <Checkbox
                          key={modelKey(model)}
                          className="model-option model-option-indent"
                          label={modelLabel(model)}
                          checked={modelSelected(model)}
                          disabled={loading || saving}
                          onChange={(event) => setModel(model, event.target.checked)}
                        />
                      ))}
                    </div>
                  </details>
                );
              })
            ) : (
              <p className="agent-model-filter-empty">No models match "{filterQuery}"</p>
            )}
          </div>

          {/* Says what Save does, before it is pressed. The old panel never stated the consequence. */}
          {isServer && restrictionsEnabled && (
            allowedKeys.size === 0 ? (
              <Alert variant="warning">
                <AlertTitle>Nothing is selected</AlertTitle>
                <AlertDescription>
                  An empty list means no restriction, so saving now would approve every model again. Pick at least one
                  model to narrow the list.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="info">
                <AlertDescription>
                  After saving, everyone here can use {previewModels.length} of {sourceModels.length} models.
                </AlertDescription>
              </Alert>
            )
          )}

          {!isServer && (
            <div className="effective-models">
              <span>Effective models</span>
              {previewModels.length ? (
                <div className="model-chip-list" aria-label={`${previewModels.length} effective models`}>
                  <strong>{previewModels.length}</strong>
                  {previewModels.slice(0, 8).map((model) => (
                    <span className="model-chip" key={modelKey(model)}>
                      {modelLabel(model)}
                    </span>
                  ))}
                  {previewModels.length > 8 && <span className="model-chip">+{previewModels.length - 8} more</span>}
                </div>
              ) : (
                <strong>None returned</strong>
              )}
            </div>
          )}
        </>
      )}
      {ready && !loading && providerNames.length === 0 && <p className="admin-muted">No discovered models returned.</p>}

      {/* Actions sit last, where a dialog puts them. Kept inside the editor because it owns the
          saving state; lifting them into ModalFooter would mean exposing save() to the parent. */}
      <div className="model-restrictions-actions">
        <Button
          variant={isServer ? 'primary' : 'secondary'}
          size="sm"
          type="button"
          disabled={!ready || loading || saving || (restrictionsEnabled && allowedKeys.size === 0)}
          onClick={() => saveRestrictions()}
        >
          {saving ? 'Saving...' : 'Save'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          disabled={!ready || loading || saving}
          onClick={onCancel ?? resetRestrictions}
        >
          {onCancel ? 'Cancel' : 'Reset'}
        </Button>
      </div>
    </div>
  );
}

function Inspector({
  detail,
  loading,
  allModels,
  users,
  onClose,
  onConfirm,
  onRefreshUser,
}: {
  detail: AdminUserDetail | null;
  loading: boolean;
  allModels: ModelListItem[];
  users: AdminUser[];
  onClose: () => void;
  onConfirm: (action: ConfirmAction) => void;
  onRefreshUser: (userId: string) => Promise<void>;
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
                Manage agents
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
            <AgentControlsModal
              user={user}
              users={users}
              agents={agents}
              unattributedUsage={unattributedUsage}
              onClose={() => setQuotasOpen(false)}
              onTransferred={() => onRefreshUser(user.id)}
            />
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
  const [modelAccessOpen, setModelAccessOpen] = useState(false);
  // Summary for the collapsed bar. listModels() is already narrowed by this policy, so the totals
  // have to come from the policy endpoint itself, which also returns the unfiltered registry.
  const [serverModels, setServerModels] = useState<{
    allowed: number;
    approved: number;
    discovered: number;
    defaultModel: ModelRef | null;
    // Optional: a manager deployed ahead of the matching API gets a response without this field.
    // Never dereferenced unguarded — a missing field must degrade the sentence, not blank the page.
    environmentModel?: { provider: string; model: string };
  } | null>(null);

  async function loadAdmin() {
    setState('loading');
    setError('');
    try {
      const [nextSummary, nextUsers, nextModels] = await Promise.all([getAdminSummary(), listAdminUsers(), listModels()]);
      setSummary(nextSummary);
      setUsers(nextUsers);
      setModels(nextModels);
      // Loaded on its own: this endpoint only exists once the matching API change is deployed, and a
      // slow or missing one must not take the whole console down with it.
      // The default-model endpoint is newer than the restrictions one, so it is caught separately:
      // an API without it yet costs the fallback line, not the model counts beside it.
      Promise.all([getServerModelRestrictions(), getServerDefaultModel().catch(() => null)])
        .then(([nextServer, nextDefault]) =>
          setServerModels({
            allowed: (nextServer.allowed_models || []).length,
            approved: (nextServer.effective_models || []).length,
            discovered: (nextServer.discovered_models || []).length,
            defaultModel: nextDefault?.default_model ?? null,
            environmentModel: nextDefault?.environment_model,
          }),
        )
        .catch(() => setServerModels(null));
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

  async function refreshSelectedUser(userId: string) {
    const [nextSummary, nextUsers, nextModels] = await Promise.all([getAdminSummary(), listAdminUsers(), listModels()]);
    setSummary(nextSummary);
    setUsers(nextUsers);
    setModels(nextModels);
    const selected = nextUsers.find((user) => user.id === userId);
    if (selected) {
      setSelectedUserId(selected.id);
      setSelectedDetail(await getAdminUser(selected.id));
    } else {
      setSelectedUserId('');
      setSelectedDetail(null);
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

        {/* Server-wide, so it sits outside the workspace grid and is never tied to a selected user. */}
        {/* One line in the console, the panel itself in a modal. It is a rarely-touched setting, so it
            should not take a screenful above the table people actually came here for. */}
        <div className="admin-server-models-bar">
          <div>
            <strong>Model access</strong>
            <span className="admin-muted">
              {!serverModels
                ? 'Everyone here can use these.'
                : serverModels.allowed === 0
                  ? `Everyone here can use all ${serverModels.discovered} models.`
                  : `Everyone here can use ${serverModels.approved} of ${serverModels.discovered} models.`}
            </span>
            {/* The fallback reads here too, so the current default is visible without opening the
                modal. Loaded with the counts below, and absent while that request is in flight. */}
            {serverModels && (
              <span className="admin-muted">
                {serverModels.defaultModel
                  ? `Default ${serverModels.defaultModel.model}.`
                  : serverModels.environmentModel
                    ? `Default ${serverModels.environmentModel.model}, from the server environment.`
                    : 'Default set in the server environment.'}
              </span>
            )}
          </div>
          <Button variant="secondary" size="sm" type="button" onClick={() => setModelAccessOpen(true)}>
            Change
          </Button>
        </div>

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
            users={users}
            onClose={() => {
              setSelectedUserId('');
              setSelectedDetail(null);
            }}
            onConfirm={setConfirmAction}
            onRefreshUser={refreshSelectedUser}
          />
        </div>
      </CardContent>

      {modelAccessOpen && (
        <Modal open onOpenChange={(open) => !open && setModelAccessOpen(false)} size="lg" aria-labelledby="server-model-access-title">
          <ModalHeader>
            <div>
              <ModalTitle id="server-model-access-title">Model access</ModalTitle>
            </div>
            <Badge variant="warning" size="sm">
              Affects everyone
            </Badge>
          </ModalHeader>
          <ModalBody className="model-access-modal">
            {/* Which model is picked when none is asked for, above which models are allowed at all.
                Its own save — the allow-list below can reject this one, never the reverse. */}
            <ServerDefaultModelEditor
              onSaved={(saved) => setServerModels((prev) => (prev ? { ...prev, defaultModel: saved } : prev))}
            />
            <ModelRestrictionsEditor
              scope="server"
              parentKey={null}
              allModels={models}
              onSaved={() => {
                setModelAccessOpen(false);
                void loadAdmin();
              }}
              onCancel={() => setModelAccessOpen(false)}
            />
          </ModalBody>
        </Modal>
      )}

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
