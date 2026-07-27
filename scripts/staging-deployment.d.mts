export const stagingDeploymentSteps: string[];
export const requiredSecretNames: string[];

export interface StagingDeploymentConfig {
  environmentId: string;
  releaseSha: string;
  workerName: string;
  baseUrl: string;
  projectRef: string;
  secretNamesPresent: number;
}

export interface HostedReleaseIdentity {
  target: "staging";
  environmentId: string;
  releaseSha: string;
  verified: true;
}

export function validateStagingDeploymentConfig(
  env?: NodeJS.ProcessEnv,
  options?: {
    suppliedEnvironmentId?: string;
    requireSecrets?: boolean;
  },
): StagingDeploymentConfig;

export function verifyHostedRelease(
  env?: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): Promise<HostedReleaseIdentity>;
