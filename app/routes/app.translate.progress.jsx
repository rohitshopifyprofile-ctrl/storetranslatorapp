import { authenticate } from "../shopify.server";
import db from "../db.server";

// Lightweight polling endpoint: returns the most recent whole-store job so the
// Translate page can render a live progress bar.
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const job = await db.translationJob.findFirst({
    where: { shop: session.shop, resourceType: "ALL" },
    orderBy: { createdAt: "desc" },
  });
  if (!job) return { job: null };
  return {
    job: {
      status: job.status,
      stepsTotal: job.stepsTotal,
      stepsDone: job.stepsDone,
      currentStep: job.currentStep,
      wordsTranslated: job.wordsTranslated,
      totalResources: job.totalResources,
      errorMessage: job.errorMessage,
    },
  };
}
