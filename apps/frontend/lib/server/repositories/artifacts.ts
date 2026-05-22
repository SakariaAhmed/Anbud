import "server-only";

export {
  deleteGeneratedArtifact,
  listGeneratedArtifacts,
  saveGeneratedArtifact,
  updateGeneratedArtifact,
} from "@/lib/server/repositories/supabase-store";
