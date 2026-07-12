import "server-only";

export {
  deleteGeneratedArtifact,
  getArtifactSourceRevisions,
  listArtifactKnowledgeCandidatesFresh,
  listGeneratedArtifacts,
  listGeneratedArtifactsFresh,
  saveGeneratedArtifact,
  updateGeneratedArtifact,
} from "@/lib/server/repositories/supabase-store";
