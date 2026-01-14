export async function checkStorageQuota(): Promise<{
  usage: number;
  quota: number;
  percentUsed: number;
}> {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0,
      percentUsed: ((estimate.usage || 0) / (estimate.quota || 1)) * 100
    };
  }
  return { usage: 0, quota: 0, percentUsed: 0 };
}

export async function warnIfQuotaLow(): Promise<void> {
  const { percentUsed } = await checkStorageQuota();
  if (percentUsed > 80) {
    // Could show notification to user
  }
}
