import "server-only";

import { revalidatePath, revalidateTag } from "next/cache";

export const PROJECTS_LIST_TAG = "projects:list";
export const SERVICE_DESCRIPTIONS_TAG = "service-descriptions:list";

export function projectTag(projectId: string) {
  return `project:${projectId}`;
}

export function revalidateProjectCaches(projectId: string) {
  revalidateTag(PROJECTS_LIST_TAG);
  revalidateTag(projectTag(projectId));
  revalidatePath("/");
  revalidatePath(`/projects/${projectId}`);
}

export function revalidateServiceCaches(projectId?: string) {
  revalidateTag(SERVICE_DESCRIPTIONS_TAG);
  revalidatePath("/");
  revalidatePath("/projects/new");
  revalidatePath("/service-descriptions");
  if (projectId) {
    revalidateProjectCaches(projectId);
  }
}
