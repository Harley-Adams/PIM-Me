# PIM Me

Azure PIM role activation library and MCP server. Activate roles programmatically or through natural language with your AI assistant. Save your frequently-used roles as favorites and activate them all with a single command.

## Quick Start

### Prerequisites

- Node.js 18+
- Azure CLI installed and logged in (`az login`)
- Azure account with PIM-eligible roles

### As an MCP Server

Add to your MCP client:

**VS Code** (`.vscode/mcp.json`):
```json
{
  "servers": {
    "pim-me": {
      "command": "npx",
      "args": ["-y", "pim-me-mcp"]
    }
  }
}
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "pim-me": {
      "command": "npx",
      "args": ["-y", "pim-me-mcp"]
    }
  }
}
```

### As a Library

```bash
npm install pim-me-mcp
```

```typescript
import { 
  listEligibleRoles, 
  listActiveRoles, 
  activateRoles,
  activateQuickRoles 
} from 'pim-me-mcp';

// List all roles you can activate
const eligible = await listEligibleRoles();
console.log(eligible.roles);

// Check what's currently elevated
const active = await listActiveRoles();
active.roles.forEach(role => {
  console.log(`${role.roleName} expires at ${role.endDateTime}`);
});

// Activate specific roles
const result = await activateRoles(
  [{ name: 'Contributor', scope: 'my-subscription' }],
  'Development work',
  8 // hours
);

// Or activate your saved favorites
const quickResult = await activateQuickRoles('Development work');
```

## MCP Server Usage

### Setting Up Quick Roles

The easiest way to use this tool is to set up your frequently-used roles once:

1. **Ask**: "Show me my PIM roles" or "Help me set up my quick roles"
2. **Pick roles** from the numbered list: "Save roles 20, 21, 22 as my quick roles"
3. **Set a default justification** (optional): Include `defaultJustification: "Development work"` when saving

Your configuration is saved to `~/.pim-me-mcp.json`:

```json
{
  "quickRoles": {
    "roles": [
      { "name": "Owner", "scope": "my-resource-group" },
      { "name": "Contributor", "scope": "my-subscription" }
    ],
    "description": "My daily development roles",
    "defaultJustification": "Development work"
  }
}
```

### Daily Usage

Once configured, just say:

- **"Activate my quick roles"** — uses your default justification
- **"Activate my quick roles for debugging production issue"** — custom justification
- **"List my eligible roles"** — see all roles you can activate
- **"List my active roles"** — see currently elevated roles with expiration times
- **"Activate the Contributor role for my-subscription"** — activate specific roles

## Available Tools (MCP)

| Tool | Description |
|------|-------------|
| `list_eligible_roles` | Lists all PIM roles you can activate |
| `list_active_roles` | Lists currently elevated roles with expiration times |
| `list_quick_roles` | Shows eligible roles with indices + your saved quick roles |
| `save_quick_roles` | Saves selected roles (by index) as quick roles |
| `activate_quick_roles` | Activates your saved quick roles |
| `activate_pim_roles` | Activates specific roles by name |

## Library API

### Core Functions

| Function | Description |
|----------|-------------|
| `listEligibleRoles()` | Returns all PIM roles you can activate |
| `listActiveRoles()` | Returns currently elevated roles with expiration times |
| `activateRoles(roles, justification, hours)` | Activates specific roles |
| `activateQuickRoles(justification?, hours?)` | Activates your saved favorites |

### Configuration Functions

| Function | Description |
|----------|-------------|
| `loadQuickRolesConfig()` | Loads quick roles from config file or env |
| `saveQuickRolesConfig(roles, desc?, justification?)` | Saves quick roles to config |
| `getConfigPath()` | Returns path to `~/.pim-me-mcp.json` |

### Types

```typescript
interface RoleConfig {
  name: string;   // e.g., "Contributor"
  scope: string;  // e.g., "my-subscription"
}

interface QuickRolesConfig {
  roles: RoleConfig[];
  description?: string;
  defaultJustification?: string;
}
```

---

## How It Works

This MCP server uses the Azure CLI to interact with the Azure PIM REST API:

1. **Lists eligible roles** via `roleEligibilityScheduleInstances` API
2. **Lists active roles** via `roleAssignmentScheduleInstances` API (filtered to `assignmentType=Activated`)
3. **Activates roles** via `roleAssignmentScheduleRequests` API with `SelfActivate` request type

**API Version**: `2020-10-01`

---

## Tricky Implementation Details

### 🔑 Group-Based Role Assignments

The trickiest part of Azure PIM automation is handling **group-based role assignments**. When a role is assigned to a group (rather than directly to a user), activation requires special handling.

#### Problem 1: Wrong Principal ID

**Symptom**: `"InsufficientPermissions"` or `"The assignee cannot be found"`

**Cause**: The `roleEligibilityScheduleInstances` API returns the *group's* principal ID, but the activation API needs the *user's* principal ID.

**Solution**: Extract the user's OID from the Azure access token JWT:

```typescript
async function getCurrentUserPrincipalId(): Promise<string> {
  const tokenResult = await azCommand(
    "account get-access-token --resource https://management.azure.com"
  );
  const tokenData = JSON.parse(tokenResult);
  
  // Decode JWT payload (base64)
  const payload = JSON.parse(
    Buffer.from(tokenData.accessToken.split('.')[1], 'base64').toString()
  );
  
  return payload.oid;  // The user's Azure AD Object ID
}
```

#### Problem 2: Missing Linked Schedule ID

**Symptom**: Activation fails for group-based roles even with correct principal ID

**Solution**: For group-based assignments, include `linkedRoleEligibilityScheduleId` in the request body. This links the activation back to the group's eligibility schedule.

### 📦 Activation Request Body

```json
{
  "properties": {
    "principalId": "<user-oid>",
    "roleDefinitionId": "<role-definition-id>",
    "requestType": "SelfActivate",
    "justification": "<business-justification>",
    "scheduleInfo": {
      "expiration": {
        "type": "AfterDuration",
        "duration": "PT8H"
      }
    },
    "linkedRoleEligibilityScheduleId": "<eligibility-schedule-id>"
  }
}
```

> **Note**: `linkedRoleEligibilityScheduleId` is required for group-based assignments, optional for direct assignments.

### ⚠️ Error Handling

| Error Code | Meaning | Solution |
|------------|---------|----------|
| `RoleAssignmentExists` | Role already activated | Treat as success ✅ |
| `InsufficientPermissions` | Wrong principal ID | Use user's OID, not group's |
| `The assignee cannot be found` | Principal ID mismatch | Extract OID from access token |

### 📋 API Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?$filter=asTarget()` | GET | List eligible roles |
| `/providers/Microsoft.Authorization/roleAssignmentScheduleInstances?$filter=asTarget()` | GET | List active roles |
| `/{scope}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/{guid}` | PUT | Activate a role |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Command 'az' not found" | [Install Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli) |
| "Please run 'az login'" | Run `az login` to authenticate |
| Role not found | Use `list_eligible_roles` to see exact role names and scopes |

## License

MIT
