// Which pre-read shape the flat tool arguments carry. A thread action names a
// thread, a pull-request action names a number, and a push names the resolved
// remote; anything else planned nothing that needs a pre-read.
export function executingProof(input) {
  if (input.thread_id != null) {
    return threadActionExecutingProof(input);
  }
  if (input.pr_number != null) {
    return {
      repository_id: input.pr_repository_id,
      pr_number: input.pr_number,
      base_branch: input.base_branch,
      head_branch: input.head_branch,
      head_sha: input.head_sha,
      is_draft: input.is_draft,
    };
  }
  if (input.resolved_repository_id == null && input.resolved_url == null) {
    return null;
  }
  return {
    resolved_repository_id: input.resolved_repository_id,
    resolved_url: input.resolved_url,
    ...(input.pull_request_is_draft == null
      ? {}
      : { pull_request_is_draft: input.pull_request_is_draft }),
  };
}

export function threadActionExecutingProof(input) {
  return {
    thread_id: input.thread_id,
    is_resolved: input.is_resolved,
    ...(input.thread_watermark == null
      ? {}
      : { thread_watermark: input.thread_watermark }),
    ...(input.pr_repository_id == null
      ? {}
      : { repository_id: input.pr_repository_id }),
    ...(input.pr_number == null ? {} : { pr_number: input.pr_number }),
  };
}
