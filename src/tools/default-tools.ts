import { ToolRegistry } from './contracts.ts';
import type { AppConfig } from '../config/config.ts';
import { registerFilesystemTools } from './filesystem-tools.ts';
import type { FileOperationApprovalPort } from '../desktop/contracts.ts';
import { registerActionTools, registerWebTools } from './action-tools.ts';
import type { ActionToolPorts } from './action-tools.ts';
import { registerPlanTool } from './plan-tool.ts';
import { registerMemoryTool } from './memory-tool.ts';
import { registerUtilityTools } from './utility-tools.ts';
import { registerGitTools } from './git-tools.ts';
import { registerProblemsTool } from './problems-tool.ts';
import type { MemoryStore } from '../storage/memory-store.ts';

export interface ToolRegistryOptions {
  readonly includeFilesystemTools?: boolean;
  /** Enables write_file, edit_file, create_directory, and delete_path (each reviewed by the user). */
  readonly fileOperationApproval?: FileOperationApprovalPort;
  /** Enables run_command, open_application, open_url, fetch_url, web_search (each approved by the user). */
  readonly actions?: ActionToolPorts;
  /** Enables remember: lasting facts for future conversations. */
  readonly memory?: MemoryStore;
}

export function createDefaultToolRegistry(
  config: AppConfig,
  options: ToolRegistryOptions = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  registerPlanTool(registry);
  if (options.memory) registerMemoryTool(registry, options.memory);
  const includeFilesystemTools = options.includeFilesystemTools ?? config.filesystemAllowedRoots.length > 0;
  if (includeFilesystemTools) {
    registerFilesystemTools(registry, config, {}, options.fileOperationApproval);
    registerGitTools(registry, config, options.actions);
    registerProblemsTool(registry, config, options.actions);
  }
  if (options.actions) {
    registerActionTools(registry, config, options.actions);
    registerWebTools(registry, config, options.actions);
  }
  // Clock, calculator, units, dates, and Mac status always; weather, rates, and versions with web access.
  registerUtilityTools(registry, options.actions);
  return registry;
}
