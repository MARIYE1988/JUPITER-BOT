export function normalizeFeePolicy(value = {}) {
  const maxFeePercent = value.maxFeePercent ?? 50;
  const strictUsdEnabled = value.strictUsdEnabled ?? false;
  const maxFeeUsd = value.maxFeeUsd ?? 0.05;
  if (typeof maxFeePercent !== 'number' || !Number.isFinite(maxFeePercent) || maxFeePercent < 0 || maxFeePercent > 50) throw new Error('Maximum fees must be 0–50 percent');
  if (typeof strictUsdEnabled !== 'boolean') throw new Error('strictUsdEnabled must be boolean');
  if (typeof maxFeeUsd !== 'number' || !Number.isFinite(maxFeeUsd) || maxFeeUsd <= 0) throw new Error('USD ceiling must be positive');
  return { maxFeePercent, strictUsdEnabled, maxFeeUsd };
}

export function evaluateFees(amountUsd, estimatedCostUsd, value = {}) {
  const policy = normalizeFeePolicy(value);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || !Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) throw new Error('Unknown or invalid fee estimate; do not swap');
  const percentLimitUsd = amountUsd * policy.maxFeePercent / 100;
  const effectiveLimitUsd = policy.strictUsdEnabled ? Math.min(percentLimitUsd, policy.maxFeeUsd) : percentLimitUsd;
  const allowed = estimatedCostUsd <= effectiveLimitUsd;
  return { allowed, amountUsd, estimatedCostUsd, percentLimitUsd, effectiveLimitUsd, policy, reason: allowed ? 'Within fee limits' : 'Estimated cost exceeds permitted fees' };
}
