import path from "node:path";
import { prepareReview, selectReviewerConfiguration } from "../../src/core.mjs";
import { discoverReviewerOptions } from "../../src/reviewer-options.mjs";

process.env.REVIEW_BRIDGE_CODEX_COMMAND = path.resolve("test/fixtures/codex-runtime.mjs");
export async function prepareConfiguredReview(store, input) {
  const review = await prepareReview(store, input);
  if (input.reviewerProvider !== "CODEX_TASK") return review;
  const options = await discoverReviewerOptions(store, input.repositoryPath, "CODEX_TASK");
  return selectReviewerConfiguration(store, review.id, review.state_version, options.suggested);
}
