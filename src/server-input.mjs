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
