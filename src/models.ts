import type { ModelListItem, ModelRef } from './api';

export function modelProvider(model: ModelListItem | ModelRef) {
  return model.provider || 'unknown';
}

export function providerLabel(provider: string) {
  const labels: Record<string, string> = {
    anthropic: 'Anthropic',
    ollama: 'Ollama',
    openai: 'OpenAI',
  };
  return labels[provider.toLowerCase()] || provider;
}

export function modelName(model: ModelListItem | ModelRef) {
  return model.model || ('id' in model ? model.id : '');
}

export function modelKey(model: ModelListItem | ModelRef) {
  return `${modelProvider(model)}:${modelName(model)}`;
}

export function providerWideKey(provider: string) {
  return `${provider}:*`;
}

export function selectionKey(model: ModelRef) {
  return model.model ? modelKey(model) : providerWideKey(model.provider);
}

export function enabledModels(models: ModelListItem[]) {
  return models.filter((model) => model.enabled !== false && modelName(model));
}

export function groupModelsByProvider(models: ModelListItem[]) {
  return enabledModels(models).reduce<Record<string, ModelListItem[]>>((groups, model) => {
    const provider = modelProvider(model);
    groups[provider] = groups[provider] || [];
    groups[provider].push(model);
    return groups;
  }, {});
}
