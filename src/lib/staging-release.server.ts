const STAGING_ID = /^staging[-_][a-z0-9][a-z0-9_-]{2,63}$/i;
const RELEASE_SHA = /^[a-f0-9]{40}$/;
const PRODUCTION_LIKE = /(^|[-_.])(prod|production|live)([-_.]|$)/i;

export function stagingReleaseIdentity(env: NodeJS.ProcessEnv = process.env) {
  const environmentId = env.CERTIFICATION_ENVIRONMENT_ID?.trim() ?? "";
  const releaseSha = env.DEPLOYED_RELEASE_SHA?.trim().toLowerCase() ?? "";
  if (
    env.DEPLOYMENT_TARGET !== "staging" ||
    env.STAGING_CERTIFICATION_ENABLED !== "true" ||
    !STAGING_ID.test(environmentId) ||
    PRODUCTION_LIKE.test(environmentId) ||
    !RELEASE_SHA.test(releaseSha)
  ) {
    return null;
  }
  return {
    target: "staging" as const,
    environmentId,
    releaseSha,
  };
}
