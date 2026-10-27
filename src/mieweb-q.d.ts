declare module '@mieweb/q' {
  import type { ComponentType } from 'react';

  export type AgentConfigGeneratorProps = {
    initialConfig?: Record<string, unknown>;
    schema?: Record<string, unknown>;
    showEditor?: boolean;
    onConfigChange?: (config: Record<string, unknown>) => void;
    onDownload?: (content: string, mode: 'yaml' | 'json') => void;
    onSubmit?: (yaml: string, secrets: Record<string, string | null>) => void;
    secretNames?: string[];
    onDiscoverTools?: (
      server: Record<string, unknown>,
      secrets: Record<string, string | null>,
    ) => Promise<Array<{ name: string; description?: string }>>;
  };

  export const AgentConfigGenerator: ComponentType<AgentConfigGeneratorProps>;
  export function configToYaml(config: Record<string, unknown>): string;
  export function yamlToConfig(yaml: string): Record<string, unknown>;
}
