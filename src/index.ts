#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { activatePimRolesCli, listEligibleRolesCli } from "./pim-cli.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Role configuration type
interface RoleConfig {
  name: string;
  scope: string;
}

interface QuickRolesConfig {
  roles: RoleConfig[];
  description?: string;
  defaultJustification?: string;
}

/**
 * Load quick roles from config file or environment variable.
 * 
 * Priority:
 * 1. PIM_QUICK_ROLES environment variable (JSON array)
 * 2. ~/.pim-me-mcp.json config file
 * 3. Default empty array (tool will be hidden)
 */
function loadQuickRoles(): QuickRolesConfig | null {
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
 * Get the config file path (user's home directory)
 */
function getConfigPath(): string {
  return join(homedir(), ".pim-me-mcp.json");
}

/**
 * Save quick roles to the config file
 */
function saveQuickRoles(roles: RoleConfig[], description?: string, defaultJustification?: string): { success: boolean; path: string; error?: string } {
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

// Define the tools available in this MCP server
const tools: Tool[] = [
  // Quick roles tool - always available, reads config fresh each time
  {
    name: "activate_quick_roles",
    description:
      "Activates your saved quick roles (favorites) for fast elevation. Configure your quick roles first using get_quick_roles and save_quick_roles. Reads the latest config each time, so no server reload needed after changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        justification: {
          type: "string",
          description:
            "The business justification for activating these roles. Optional if a default justification is configured.",
        },
        duration: {
          type: "number",
          description:
            "Duration in hours for the role activation. Default is 8 hours.",
          default: 8,
        },
      },
      required: [],
    },
  },
  {
    name: "list_pim_roles",
    description:
      "Lists all available PIM (Privileged Identity Management) roles that can be activated in Azure. Returns role names, scopes, and whether they are assigned directly or through a group.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "activate_pim_roles",
    description:
      "Activates specified PIM (Privileged Identity Management) roles in Azure. Provide role names and scopes to match against your eligible roles.",
    inputSchema: {
      type: "object",
      properties: {
        roles: {
          type: "array",
          items: {
            type: "string",
          },
          description:
            "Array of role names to activate. These should match the role names shown in the Azure PIM portal.",
        },
        justification: {
          type: "string",
          description:
            "The business justification for activating these roles. This is required by Azure PIM.",
        },
        duration: {
          type: "number",
          description:
            "Duration in hours for the role activation. Default is 8 hours.",
          default: 8,
        },
      },
      required: ["roles", "justification"],
    },
  },
  {
    name: "get_quick_roles",
    description:
      "Lists all eligible PIM roles with indices and shows your currently saved quick roles. Use this to see available roles, then call save_quick_roles with your selected indices to update your favorites.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "save_quick_roles",
    description:
      "Saves your selected roles as quick roles for fast activation. Use the indices from get_quick_roles to specify which roles to save.",
    inputSchema: {
      type: "object",
      properties: {
        indices: {
          type: "array",
          items: {
            type: "number",
          },
          description:
            "Array of role indices from setup_quick_roles to save as your quick roles.",
        },
        description: {
          type: "string",
          description:
            "Optional description for your quick roles set (e.g., 'My daily development roles').",
        },
        defaultJustification: {
          type: "string",
          description:
            "Optional default justification to use when activating quick roles (e.g., 'Development work'). If set, you won't need to provide a justification each time.",
        },
      },
      required: ["indices"],
    },
  },
];

// Create the MCP server
const server = new Server(
  {
    name: "pim-me-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "activate_quick_roles": {
        // Always read fresh config to pick up any changes
        const currentConfig = loadQuickRoles();
        
        if (!currentConfig) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Quick roles are not configured. Use get_quick_roles and save_quick_roles to configure them, or create ~/.pim-me-mcp.json",
              },
            ],
            isError: true,
          };
        }

        const justification = (args?.justification as string) || currentConfig.defaultJustification;
        const duration = (args?.duration as number) ?? 8;

        if (!justification) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Justification is required for PIM role activation. Either provide one or set a defaultJustification in your config using save_quick_roles.",
              },
            ],
            isError: true,
          };
        }

        const result = await activatePimRolesCli(
          currentConfig.roles,
          justification,
          duration
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "list_pim_roles": {
        const result = await listEligibleRolesCli();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "activate_pim_roles": {
        const roles = args?.roles as string[];
        const justification = args?.justification as string;
        const duration = (args?.duration as number) ?? 8;

        if (!roles || roles.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "Error: No roles specified for activation.",
              },
            ],
            isError: true,
          };
        }

        if (!justification) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Justification is required for PIM role activation.",
              },
            ],
            isError: true,
          };
        }

        // Convert role strings to {name, scope} objects
        // For simple role names, we'll try to match by name only
        const roleObjects = roles.map((r) => ({ name: r, scope: "" }));
        const result = await activatePimRolesCli(
          roleObjects,
          justification,
          duration
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_quick_roles": {
        // Get eligible roles and format them for selection
        const listResult = await listEligibleRolesCli();
        
        if (!listResult.success) {
          return {
            content: [
              {
                type: "text",
                text: `Error fetching roles: ${listResult.message}`,
              },
            ],
            isError: true,
          };
        }

        // Format roles with indices for selection
        const rolesWithIndices = listResult.roles.map((role, index) => ({
          index,
          name: role.roleName,
          scope: role.scopeName,
          fullScope: role.scope,
          memberType: role.memberType,
        }));

        // Show current quick roles if configured (read fresh)
        const currentQuickRoles = loadQuickRoles();
        let currentConfig = "";
        if (currentQuickRoles) {
          currentConfig = `\n\n**Currently configured quick roles:**\n${currentQuickRoles.roles
            .map((r) => `• ${r.name} (${r.scope})`)
            .join("\n")}`;
        }

        // Build the role list as plain text to ensure it displays
        const roleList = rolesWithIndices
          .map((r) => `${r.index}. ${r.name} — ${r.scope} (${r.memberType})`)
          .join("\n");

        const instructions = `IMPORTANT: You MUST display this entire role list to the user. Do not summarize or truncate.

===== ELIGIBLE PIM ROLES =====

${roleList}

==============================
${currentConfig}

Tell the user which roles they want to save by index number (e.g., "save 0, 3, and 7").`;

        return {
          content: [
            {
              type: "text",
              text: instructions,
            },
          ],
          // Store roles in a way the next call can use them
          _eligibleRoles: rolesWithIndices,
        };
      }

      case "save_quick_roles": {
        const indices = args?.indices as number[];
        const description = args?.description as string | undefined;
        const defaultJustification = args?.defaultJustification as string | undefined;

        if (!indices || indices.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "Error: No role indices provided. Please specify which roles to save using their index numbers from get_quick_roles.",
              },
            ],
            isError: true,
          };
        }

        // Fetch roles again to get the full list
        const listResult = await listEligibleRolesCli();
        
        if (!listResult.success) {
          return {
            content: [
              {
                type: "text",
                text: `Error fetching roles: ${listResult.message}`,
              },
            ],
            isError: true,
          };
        }

        // Validate indices
        const invalidIndices = indices.filter(
          (i) => i < 0 || i >= listResult.roles.length
        );
        if (invalidIndices.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Invalid indices: ${invalidIndices.join(", ")}. Valid range is 0-${listResult.roles.length - 1}.`,
              },
            ],
            isError: true,
          };
        }

        // Build the roles to save
        const rolesToSave: RoleConfig[] = indices.map((i) => ({
          name: listResult.roles[i].roleName,
          scope: listResult.roles[i].scopeName,
        }));

        // Save to config file
        const saveResult = saveQuickRoles(rolesToSave, description, defaultJustification);

        if (!saveResult.success) {
          return {
            content: [
              {
                type: "text",
                text: `Error saving config: ${saveResult.error}`,
              },
            ],
            isError: true,
          };
        }

        // Config is read fresh on each activate_quick_roles call, so no reload needed

        const savedRolesList = rolesToSave
          .map((r) => `• ${r.name} (${r.scope})`)
          .join("\n");

        const justificationNote = defaultJustification 
          ? `\n**Default justification:** "${defaultJustification}"\n\nYou can now activate your quick roles without providing a justification each time!`
          : `\n**Tip:** Just say "activate my quick roles for <justification>" to use them.`;

        return {
          content: [
            {
              type: "text",
              text: `✅ **Quick roles saved successfully!**

**Saved to:** \`${saveResult.path}\`

**Your quick roles:**
${savedRolesList}

You can now use the \`activate_quick_roles\` tool to activate all of these with a single command!
${justificationNote}`,
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error executing tool ${name}: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("PIM MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
