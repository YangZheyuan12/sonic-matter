/**
 * 为已批准 Run 领取一次本地应用权。服务端审批本身幂等，这一层防止双击或重放响应
 * 把同一个候选快照重复写进 Project History。
 */
export function claimApprovedRun(appliedRunIds: Set<string>, runId: string): boolean {
  if (appliedRunIds.has(runId)) return false
  appliedRunIds.add(runId)
  return true
}
