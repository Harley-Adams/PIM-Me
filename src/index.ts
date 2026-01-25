/**
 * PIM Me - Azure PIM Role Activation Library
 * 
 * This module provides programmatic access to Azure PIM (Privileged Identity Management)
 * role activation functionality. Use it to list eligible roles, check active elevations,
 * and activate roles from your own code.
 * 
 * @example
 * ```typescript
 * import { listEligibleRoles, listActiveRoles, activateRoles } from 'pim-me-mcp';
 * 
 * // List all roles you can activate
 * const eligible = await listEligibleRoles();
 * console.log(eligible.roles);
 * 
 * // Check what's currently elevated
 * const active = await listActiveRoles();
 * console.log(active.roles);
 * 
 * // Activate specific roles
 * const result = await activateRoles(
 *   [{ name: 'Contributor', scope: 'my-subscription' }],
 *   'Development work',
 *   8 // hours
 * );
 * ```
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Re-export types from pim-cli
export {
  PimRoleAssignment,
  ActiveRoleAssignment,
  CliActivationResult,
  CliListRolesResult,
  CliListActiveRolesResult,
} from "./pim-cli.js";

// Import the internal CLI functions
import {
  listEligibleRolesCli,
  listActiveRolesCli,
  activatePimRolesCli,
  type CliListRolesResult,
  type CliListActiveRolesResult,
  type CliActivationResult,
} from "./pim-cli.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for a role to activate
 */
export interface RoleConfig {
  /** The display name of the role (e.g., "Contributor", "Owner") */
  name: string;
  /** The scope name or identifier (e.g., "my-subscription", "my-resource-group") */
  scope: string;
}

/**
 * Configuration for quick roles (favorites)
 */
export interface QuickRolesConfig {
  /** Array of roles saved as favorites */
  roles: RoleConfig[];
  /** Optional description for this set of roles */
  description?: string;
  /** Optional default justification to use when activating */
  defaultJustification?: string;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * List all eligible PIM roles that can be activated.
 * 
 * @returns Promise with success status, array of eligible roles, and message
 * 
 * @example
 * ```typescript
 * const result = await listEligibleRoles();
 * if (result.success) {
 *   result.roles.forEach(role => {
 *     console.log(`${role.roleName} - ${role.scopeName}`);
 *   });
 * }
 * ```
 */
export async function listEligibleRoles(): Promise<CliListRolesResult> {
  return listEligibleRolesCli();
}

/**
 * List all currently active (elevated) PIM role assignments.
 * Only returns roles that were activated via PIM, not permanent assignments.
 * 
 * @returns Promise with success status, array of active roles with expiration times, and message
 * 
 * @example
 * ```typescript
 * const result = await listActiveRoles();
 * if (result.success) {
 *   result.roles.forEach(role => {
 *     console.log(`${role.roleName} expires at ${role.endDateTime}`);
 *   });
 * }
 * ```
 */
export async function listActiveRoles(): Promise<CliListActiveRolesResult> {
  return listActiveRolesCli();
}

/**
 * Activate one or more PIM roles.
 * 
 * @param roles - Array of roles to activate (name and scope)
 * @param justification - Business justification (required by Azure PIM)
 * @param durationHours - How long to activate the roles (default: 8 hours)
 * @returns Promise with success status, lists of activated and failed roles, and message
 * 
 * @example
 * ```typescript
 * const result = await activateRoles(
 *   [
 *     { name: 'Contributor', scope: 'my-subscription' },
 *     { name: 'Owner', scope: 'my-resource-group' }
 *   ],
 *   'Deploying new feature',
 *   8
 * );
 * 
 * if (result.success) {
 *   console.log('Activated:', result.activatedRoles);
 * } else {
 *   console.log('Failed:', result.failedRoles);
 * }
 * ```
 */
export async function activateRoles(
  roles: RoleConfig[],
  justification: string,
  durationHours: number = 8
): Promise<CliActivationResult> {
  return activatePimRolesCli(roles, justification, durationHours);
}

// ============================================================================
// Quick Roles Configuration
// ============================================================================

/**
 * Get the path to the quick roles config file.
 * 
 * @returns Path to ~/.pim-me-mcp.json
 */
export function getConfigPath(): string {
  return join(homedir(), ".pim-me-mcp.json");
}

/**
 * Load quick roles configuration from file or environment variable.
 * 
 * Priority:
 * 1. PIM_QUICK_ROLES environment variable (JSON)
 * 2. .pim-me-mcp.json in current directory
 * 3. ~/.pim-me-mcp.json in home directory
 * 
 * @returns QuickRolesConfig if found, null otherwise
 * 
 * @example
 * ```typescript
 * const config = loadQuickRolesConfig();
 * if (config) {
 *   console.log('Quick roles:', config.roles);
 *   console.log('Default justification:', config.defaultJustification);
 * }
 * ```
 */
export function loadQuickRolesConfig(): QuickRolesConfig | null {
  // Try environment variable first
  const envRoles = process.env.PIM_QUICK_ROLES;
  if (envRoles) {
    try {
      const parsed = JSON.parse(envRoles);
      if (Array.isArray(parsed)) {
        return { 
          roles: parsed, 
          description: process.env.PIM_QUICK_ROLES_DESC,
          defaultJustification: process.env.PIM_DEFAULT_JUSTIFICATION,
        };
      }
      return parsed as QuickRolesConfig;
    } catch (e) {
      console.error("Warning: PIM_QUICK_ROLES is not valid JSON, ignoring.");
    }
  }

  // Try config file
  const configPaths = [
    join(process.cwd(), ".pim-me-mcp.json"),
    join(homedir(), ".pim-me-mcp.json"),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8");
        const config = JSON.parse(content);
        if (config.quickRoles) {
          return config.quickRoles as QuickRolesConfig;
        }
      } catch (e) {
        console.error(`Warning: Failed to parse ${configPath}, ignoring.`);
      }
    }
  }

  return null;
}

/**
 * Save quick roles configuration to the config file.
 * 
 * @param roles - Array of roles to save as favorites
 * @param description - Optional description for this set
 * @param defaultJustification - Optional default justification
 * @returns Object with success status, config path, and error if failed
 * 
 * @example
 * ```typescript
 * const result = saveQuickRolesConfig(
 *   [
 *     { name: 'Owner', scope: 'my-subscription' },
 *     { name: 'Contributor', scope: 'my-rg' }
 *   ],
 *   'My daily dev roles',
 *   'Development work'
 * );
 * 
 * if (result.success) {
 *   console.log('Saved to:', result.path);
 * }
 * ```
 */
export function saveQuickRolesConfig(
  roles: RoleConfig[], 
  description?: string, 
  defaultJustification?: string
): { success: boolean; path: string; error?: string } {
  const configPath = getConfigPath();
  
  try {
    // Load existing config or create new one
    let config: any = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {
        // If file is corrupted, start fresh
      }
    }
    
    // Update quick roles
    config.quickRoles = {
      roles,
      description,
      defaultJustification,
    };
    
    // Write back
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    
    return { success: true, path: configPath };
  } catch (e) {
    return { 
      success: false, 
      path: configPath, 
      error: e instanceof Error ? e.message : String(e) 
    };
  }
}

/**
 * Activate the configured quick roles (favorites).
 * 
 * @param justification - Business justification (optional if defaultJustification is configured)
 * @param durationHours - How long to activate (default: 8 hours)
 * @returns Promise with activation result
 * @throws Error if no quick roles are configured or no justification is available
 * 
 * @example
 * ```typescript
 * // Uses default justification from config
 * const result = await activateQuickRoles();
 * 
 * // Or override with custom justification
 * const result = await activateQuickRoles('Emergency fix');
 * ```
 */
export async function activateQuickRoles(
  justification?: string,
  durationHours: number = 8
): Promise<CliActivationResult> {
  const config = loadQuickRolesConfig();
  
  if (!config) {
    throw new Error(
      "Quick roles are not configured. Use saveQuickRolesConfig() or create ~/.pim-me-mcp.json"
    );
  }
  
  const finalJustification = justification || config.defaultJustification;
  
  if (!finalJustification) {
    throw new Error(
      "Justification is required. Provide one or set defaultJustification in your config."
    );
  }
  
  return activateRoles(config.roles, finalJustification, durationHours);
}
