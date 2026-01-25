import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";

const execAsync = promisify(exec);

export interface PimRoleAssignment {
  id: string;
  roleDefinitionId: string;
  roleName: string;
  scope: string;
  scopeName: string;
  principalId: string;
  principalType: string;
  memberType: string;
  status: string;
  roleEligibilityScheduleId?: string;
}

export interface CliActivationResult {
  success: boolean;
  activatedRoles: string[];
  failedRoles: { role: string; error: string }[];
  message: string;
}

export interface CliListRolesResult {
  success: boolean;
  roles: PimRoleAssignment[];
  message: string;
}

/**
 * Execute an Azure CLI command and return the result
 */
async function azCommand(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(`az ${command}`, {
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });
    if (stderr && !stderr.includes("WARNING")) {
      console.error("Azure CLI stderr:", stderr);
    }
    return stdout;
  } catch (error: any) {
    throw new Error(`Azure CLI error: ${error.message}\n${error.stderr || ""}`);
  }
}

/**
 * Get the current user's principal ID from the access token
 */
async function getCurrentUserPrincipalId(): Promise<string> {
  try {
    // Get the access token and extract the oid (object ID) claim
    const tokenResult = await azCommand(
      'account get-access-token --resource https://management.azure.com --query "accessToken" -o tsv'
    );
    const token = tokenResult.trim();
    
    // Decode the JWT payload (second part)
    const parts = token.split(".");
    if (parts.length < 2) {
      throw new Error("Invalid token format");
    }
    
    // Add padding if needed for base64 decode
    let payload = parts[1];
    const padding = payload.length % 4;
    if (padding) {
      payload += "=".repeat(4 - padding);
    }
    
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    const claims = JSON.parse(decoded);
    
    if (!claims.oid) {
      throw new Error("No oid claim in token");
    }
    
    return claims.oid;
  } catch (error) {
    console.error("Failed to get user principal ID from token:", error);
    throw error;
  }
}

export interface ActiveRoleAssignment {
  id: string;
  roleDefinitionId: string;
  roleName: string;
  scope: string;
  scopeName: string;
  principalId: string;
  principalType: string;
  memberType: string;
  status: string;
  startDateTime?: string;
  endDateTime?: string;
}

export interface CliListActiveRolesResult {
  success: boolean;
  roles: ActiveRoleAssignment[];
  message: string;
}

/**
 * List all currently active PIM role assignments for the current user using Azure CLI
 */
export async function listActiveRolesCli(): Promise<CliListActiveRolesResult> {
  try {
    console.error("Fetching active role assignments...");
    
    // Use the PIM API to get active role assignments
    const apiVersion = "2020-10-01";
    const url = `https://management.azure.com/providers/Microsoft.Authorization/roleAssignmentScheduleInstances?api-version=${apiVersion}&\\$filter=asTarget()`;
    
    const result = await azCommand(`rest --method GET --url "${url}"`);
    const data = JSON.parse(result);
    
    const roles: ActiveRoleAssignment[] = [];
    
    if (data.value && Array.isArray(data.value)) {
      for (const item of data.value) {
        const props = item.properties || {};
        
        // Only include PIM-activated roles, not permanent assignments
        if (props.assignmentType !== "Activated") {
          continue;
        }
        
        // Get role name from expanded properties
        const roleName = props.expandedProperties?.roleDefinition?.displayName || "Unknown Role";
        
        // Get scope name from expanded properties  
        const scopeName = props.expandedProperties?.scope?.displayName || 
                         props.scope?.split("/").pop() || 
                         props.scope || "";
        
        roles.push({
          id: item.id || "",
          roleDefinitionId: props.roleDefinitionId || "",
          roleName,
          scope: props.scope || "",
          scopeName,
          principalId: props.principalId || "",
          principalType: props.principalType || "",
          memberType: props.memberType || "Direct",
          status: props.status || "Active",
          startDateTime: props.startDateTime,
          endDateTime: props.endDateTime,
        });
      }
    }

    return {
      success: true,
      roles,
      message: `Found ${roles.length} active PIM role assignments.`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      roles: [],
      message: `Error listing active PIM roles: ${errorMessage}`,
    };
  }
}

/**
 * List all eligible PIM role assignments for the current user using Azure CLI
 */
export async function listEligibleRolesCli(): Promise<CliListRolesResult> {
  try {
    console.error("Fetching eligible role assignments...");
    
    // Use the PIM API to get eligible role assignments
    const apiVersion = "2020-10-01";
    const url = `https://management.azure.com/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?api-version=${apiVersion}&\\$filter=asTarget()`;
    
    const result = await azCommand(`rest --method GET --url "${url}"`);
    const data = JSON.parse(result);
    
    const roles: PimRoleAssignment[] = [];
    
    if (data.value && Array.isArray(data.value)) {
      for (const item of data.value) {
        const props = item.properties || {};
        
        // Get role name from expanded properties
        const roleName = props.expandedProperties?.roleDefinition?.displayName || "Unknown Role";
        
        // Get scope name from expanded properties  
        const scopeName = props.expandedProperties?.scope?.displayName || 
                         props.scope?.split("/").pop() || 
                         props.scope || "";
        
        roles.push({
          id: item.id || "",
          roleDefinitionId: props.roleDefinitionId || "",
          roleName,
          scope: props.scope || "",
          scopeName,
          principalId: props.principalId || "",
          principalType: props.principalType || "",
          memberType: props.memberType || "Direct",
          status: props.status || "Eligible",
          roleEligibilityScheduleId: props.roleEligibilityScheduleId || undefined,
        });
      }
    }

    return {
      success: true,
      roles,
      message: `Found ${roles.length} eligible PIM role assignments.`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      roles: [],
      message: `Error listing PIM roles: ${errorMessage}`,
    };
  }
}

/**
 * Activate a PIM role using Azure CLI
 * For group-based assignments, we need to pass the linkedRoleEligibilityScheduleId
 */
export async function activateRoleCli(
  roleEligibilityScheduleInstanceId: string,
  scope: string,
  roleDefinitionId: string,
  userPrincipalId: string,  // This should be the USER's ID, not the group's
  justification: string,
  durationHours: number = 8,
  linkedRoleEligibilityScheduleId?: string
): Promise<{ success: boolean; message: string }> {
  try {
    const apiVersion = "2020-10-01";

    // Generate a unique name for the activation request
    const requestName = randomUUID();
    
    // Create the activation request body
    // Always include principalId (the user's ID) for self-activation
    const requestBody: any = {
      properties: {
        principalId: userPrincipalId,
        roleDefinitionId,
        requestType: "SelfActivate",
        justification,
        scheduleInfo: {
          expiration: {
            type: "AfterDuration",
            duration: `PT${durationHours}H`,
          },
        },
      },
    };

    // If this is a group-based assignment, also include the linkedRoleEligibilityScheduleId
    if (linkedRoleEligibilityScheduleId) {
      requestBody.properties.linkedRoleEligibilityScheduleId = linkedRoleEligibilityScheduleId;
    }

    // Make the activation request
    const activationUrl = `https://management.azure.com${scope}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/${requestName}?api-version=${apiVersion}`;
    
    console.error(`Activating role at scope: ${scope}`);
    
    // Need to escape the JSON body for shell
    const bodyJson = JSON.stringify(requestBody).replace(/"/g, '\\"');
    
    const result = await azCommand(
      `rest --method PUT --url "${activationUrl}" --body "${bodyJson}"`
    );
    
    const activationResult = JSON.parse(result);
    
    const status = activationResult.properties?.status;
    if (status === "Provisioned" || 
        status === "PendingApproval" ||
        status === "Accepted" ||
        status === "ScheduleCreated" ||
        activationResult.id) {
      return {
        success: true,
        message: `Role activation ${status || "submitted"} successfully`,
      };
    }
    
    return {
      success: true,
      message: "Role activation request submitted",
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Treat "already activated" as a success
    if (errorMessage.includes("RoleAssignmentExists") || 
        errorMessage.includes("already exists")) {
      return {
        success: true,
        message: "Role is already activated",
      };
    }
    
    return {
      success: false,
      message: `Failed to activate role: ${errorMessage}`,
    };
  }
}

/**
 * Activate multiple PIM roles by name and scope using Azure CLI
 */
export async function activatePimRolesCli(
  roles: { name: string; scope: string }[],
  justification: string,
  durationHours: number = 8
): Promise<CliActivationResult> {
  const activatedRoles: string[] = [];
  const failedRoles: { role: string; error: string }[] = [];

  try {
    // Get the current user's principal ID
    console.error("Getting current user principal ID...");
    const userPrincipalId = await getCurrentUserPrincipalId();
    console.error(`User principal ID: ${userPrincipalId}`);
    
    // Get all eligible roles
    console.error("Fetching eligible roles...");
    const listResult = await listEligibleRolesCli();
    
    if (!listResult.success) {
      return {
        success: false,
        activatedRoles: [],
        failedRoles: roles.map((r) => ({
          role: `${r.name} (${r.scope})`,
          error: listResult.message,
        })),
        message: listResult.message,
      };
    }

    // Match and activate each requested role
    for (const role of roles) {
      const roleIdentifier = `${role.name} (${role.scope})`;
      console.error(`Looking for role: ${roleIdentifier}`);
      
      // Find matching eligible role
      const matchingRole = listResult.roles.find((r) => {
        const nameMatch = r.roleName.toLowerCase().includes(role.name.toLowerCase()) ||
                         role.name.toLowerCase().includes(r.roleName.toLowerCase());
        const scopeMatch = r.scope.toLowerCase().includes(role.scope.toLowerCase()) ||
                          r.scopeName.toLowerCase().includes(role.scope.toLowerCase()) ||
                          role.scope.toLowerCase().includes(r.scopeName.toLowerCase());
        return nameMatch && scopeMatch;
      });

      if (!matchingRole) {
        failedRoles.push({
          role: roleIdentifier,
          error: `Could not find eligible role matching "${role.name}" at scope "${role.scope}"`,
        });
        continue;
      }

      console.error(`Found matching role: ${matchingRole.roleName} at ${matchingRole.scopeName} (${matchingRole.memberType})`);
      
      // Activate the role
      // For group-based assignments, pass the linkedRoleEligibilityScheduleId
      const linkedScheduleId = matchingRole.memberType === "Group" 
        ? matchingRole.roleEligibilityScheduleId 
        : undefined;
        
      // Always use the current user's principal ID for activation, not the group's
      const activationResult = await activateRoleCli(
        matchingRole.id,
        matchingRole.scope,
        matchingRole.roleDefinitionId,
        userPrincipalId,
        justification,
        durationHours,
        linkedScheduleId
      );

      if (activationResult.success) {
        activatedRoles.push(roleIdentifier);
        console.error(`Successfully activated: ${roleIdentifier}`);
      } else {
        failedRoles.push({
          role: roleIdentifier,
          error: activationResult.message,
        });
        console.error(`Failed to activate ${roleIdentifier}: ${activationResult.message}`);
      }
    }

    return {
      success: failedRoles.length === 0,
      activatedRoles,
      failedRoles,
      message:
        activatedRoles.length > 0
          ? `Successfully activated ${activatedRoles.length} role(s).${failedRoles.length > 0 ? ` Failed to activate ${failedRoles.length} role(s).` : ""}`
          : "No roles were activated.",
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      activatedRoles,
      failedRoles: [
        ...failedRoles,
        ...roles
          .filter(
            (r) =>
              !activatedRoles.includes(`${r.name} (${r.scope})`) &&
              !failedRoles.some((f) => f.role === `${r.name} (${r.scope})`)
          )
          .map((r) => ({ role: `${r.name} (${r.scope})`, error: errorMessage })),
      ],
      message: `Error during PIM activation: ${errorMessage}`,
    };
  }
}
